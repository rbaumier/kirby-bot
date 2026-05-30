/**
 * Review/router.ts — `routeAgents`: a one-shot haiku call that reads the diff
 * + the agent catalog (`AGENTS`, with their descriptions) and returns which
 * subset of agents to spawn, plus each agent's scoped file list.
 *
 * Replaces every static spawn heuristic (path substring, extension list,
 * import substring) with semantic judgment from a cheap model. The router
 * runs as a regular `claude` tmux session — same Stop-hook contract, same
 * sentinel + findings JSON contract as any fan-out agent, with a dedicated
 * prompt and a `ROUTING_DONE` verdict.
 *
 * Failure modes are strict: a malformed JSON output, an unknown agent name,
 * or an empty agent list aborts the review phase. Per user direction (the
 * router IS the routing decision — no heuristic fallback is acceptable, since
 * any fallback would re-introduce the brittleness the router was meant to
 * replace).
 *
 * Diff is head-truncated to ~100KB total, equitably budgeted per file. The
 * router needs the full file roster (every path) to make scoping decisions,
 * but only enough diff content per file to recognize what each file does.
 */
import { writeFile } from "node:fs/promises";
import { Clock, Console, Data, Effect, ParseResult, Schema } from "effect";
import type { Phase } from "../config";
import { MAX_ROUTER_ATTEMPTS, PHASE_CAP_MINUTES, SENTINEL_POLL_MS } from "../config";
import { RunArtifacts } from "../run-artifacts";
import type { PhaseError } from "../session/errors";
import { BudgetExhausted, UnexpectedVerdictError, WorkspaceError } from "../session/errors";
import { runOneClaudeSession } from "../session/phase-primitives";
import type { AgentModel, AgentName } from "./agents";
import { AGENTS, ALL_AGENT_NAMES, isAgentName } from "./agents";
import type { ChangedFile } from "./detect";

/** Total budget for the truncated diff sent to the router, in bytes. */
export const ROUTER_DIFF_MAX_BYTES = 100 * 1024;

/** Marker appended to head-truncated per-file slices so the router knows it's incomplete. */
const TRUNCATION_MARKER = "\n\n... [truncated by kirby-bot router]";

/** Haiku cap — the router is fast; this is the wall-clock hedge if it hangs. */
const ROUTER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Total bytes of router raw output echoed into a `router_failed` event. Big
 * enough to host the head + tail of a multi-KB malformed envelope (capturing
 * both the opening structure and the offending tail index that the
 * TreeFormatter's `reason` typically points to), small enough that two failing
 * attempts can't bloat `run.jsonl`.
 */
const ROUTER_RAW_LOG_CAP = 4000;

/**
 * Build a log-friendly view of the raw payload: emit it whole when under the
 * cap, otherwise head + tail (each half the cap) so the entries are bounded
 * but still informative about *where* the schema decoder gave up.
 */
const summarizeRaw = (
  raw: string,
): {
  readonly rawLength: number;
  readonly raw?: string;
  readonly rawHead?: string;
  readonly rawTail?: string;
} => {
  const rawLength = raw.length;
  if (rawLength <= ROUTER_RAW_LOG_CAP) { return { rawLength, raw }; }
  const half = ROUTER_RAW_LOG_CAP / 2;
  return { rawLength, rawHead: raw.slice(0, half), rawTail: raw.slice(-half) };
};

/**
 * The router produced output the orchestrator can't act on: unparseable JSON,
 * a missing or empty `agents` list, an unknown agent name, or a malformed
 * entry. All collapse to this one tag — the phase boundary maps them to a
 * single `WorkspaceError` regardless, so the `reason` text carries the cause.
 */
export class RouterMalformedOutput extends Data.TaggedError("RouterMalformedOutput")<{
  readonly reason: string;
  readonly raw: string;
}> {}

/** Input for {@link routeAgents}. */
export type RouteAgentsInput = {
  readonly phase: Phase;
  readonly issueIid: number;
  readonly worktree: string;
  readonly iteration: number;
  /** Wall-clock deadline (absolute ms from epoch) for the whole review phase. */
  readonly deadline: number;
  /** The file roster the router decides over — paths + metadata. */
  readonly files: readonly ChangedFile[];
  /** The full diff text (will be truncated to ~100KB before being sent). */
  readonly fullDiff: string;
  /**
   * Model the router session runs on. The review fan-out escalates this from
   * haiku to sonnet on re-review / large diffs (#52) — a degraded diff is also
   * where the router itself emits bad agent names (#39), so it escalates with
   * the per-agent reviewers rather than staying pinned to haiku.
   */
  readonly model: AgentModel;
};

/** One agent decision the router emitted. */
export type RoutedAgent = {
  readonly name: AgentName;
  /**
   * Files the router restricted this agent to. Empty array means "no
   * restriction — pass the full diff". Non-empty means "scope this agent to
   * these files only" (the orchestrator slices the diff accordingly).
   */
  readonly files: readonly string[];
};

/** Aggregate result of one routing pass. */
export type RouteAgentsResult = {
  readonly agents: readonly RoutedAgent[];
  /** Whether the diff fed to the router was head-truncated. */
  readonly truncated: boolean;
  /** Raw bytes of diff that survived truncation — useful for logs. */
  readonly diffBytesSent: number;
};

/**
 * Head-truncate the diff to {@link ROUTER_DIFF_MAX_BYTES} total, sharing the
 * budget equitably across files when the raw diff exceeds the cap.
 *
 * Strategy: split the diff into per-file hunks (`diff --git`), give each file
 * an equal share of the budget, head-truncate any hunk that overshoots its
 * share, recombine. Preserves the "router sees every file" invariant — losing
 * one file entirely is worse than losing the tail of every file.
 */
export const truncateDiff = (
  fullDiff: string,
  maxBytes: number = ROUTER_DIFF_MAX_BYTES,
): { readonly text: string; readonly truncated: boolean } => {
  const bytes = Buffer.byteLength(fullDiff, "utf8");
  if (bytes <= maxBytes) { return { text: fullDiff, truncated: false }; }

  // Split on `diff --git ` boundary — keep the boundary on each hunk.
  const parts = fullDiff.split(/^(?=diff --git )/m).filter((part) => part !== "");
  if (parts.length === 0) {
    // Single-file diff with no `diff --git` markers (unusual). Hard head-truncate.
    return {
      text: Buffer.from(fullDiff, "utf8").slice(0, maxBytes - TRUNCATION_MARKER.length).toString("utf8") + TRUNCATION_MARKER,
      truncated: true,
    };
  }

  const perFileBudget = Math.floor(maxBytes / parts.length);
  let truncatedAny = false;
  const truncatedParts = parts.map((hunk) => {
    const hunkBytes = Buffer.byteLength(hunk, "utf8");
    if (hunkBytes <= perFileBudget) { return hunk; }
    truncatedAny = true;
    const headRoom = perFileBudget - TRUNCATION_MARKER.length;
    if (headRoom <= 0) { return TRUNCATION_MARKER; }
    return Buffer.from(hunk, "utf8").slice(0, headRoom).toString("utf8") + TRUNCATION_MARKER;
  });

  return { text: truncatedParts.join(""), truncated: truncatedAny };
};

/**
 * Build the routing prompt: kirby-bot preamble, agent catalog, truncated diff,
 * JSON output contract. Inline string — small enough that vendoring as a
 * template would add more ceremony than it saves.
 */
type BuildRouterPromptInput = {
  readonly findingsFile: string;
  readonly agentCatalog: string;
  readonly fileRoster: string;
  readonly diffText: string;
  readonly truncated: boolean;
};

const buildRouterPrompt = (input: BuildRouterPromptInput): string =>
  [
    "# kirby-bot routing pass",
    "",
    "You are a routing haiku spawned by the kirby-bot orchestrator. Your job is to pick which code-review agents should run on this diff, and for each picked agent, to list the files it should focus on.",
    "",
    "## Hard constraints",
    "",
    "- **Do NOT use the Task / Agent tool.** This session IS the routing call.",
    "- **Do NOT review the code.** Your job is to *pick reviewers*, not to find bugs. Save bug-hunting for the agents you route to.",
    `- Write your decision (the JSON envelope below) to ${input.findingsFile}. Write atomically: write to ${input.findingsFile}.tmp, then rename. Do NOT print the JSON in chat — only the file matters.`,
    "- After writing the file, end your final assistant turn with this token on its own line as the **last non-empty line**:",
    "",
    "  VERDICT: ROUTING_DONE",
    "",
    "  Nothing else after — no closing remarks.",
    "",
    "---",
    "",
    "## Available agents",
    "",
    "Each line is `agent-name: <description>`. The description is the routing rule — pick the agent only when its description matches what this diff actually does.",
    "",
    input.agentCatalog,
    "",
    "## File roster",
    "",
    "The diff touches these files (path · ext · line count · imports):",
    "",
    input.fileRoster,
    "",
    "## Diff",
    "",
    input.truncated
      ? "(diff head-truncated to ~100KB; per-file hunks may end with `... [truncated by kirby-bot router]`)"
      : "(full diff below)",
    "",
    "```diff",
    input.diffText,
    "```",
    "",
    "---",
    "",
    "## Output contract",
    "",
    "Write this exact JSON envelope to the findings file:",
    "",
    "```json",
    renderExampleEnvelope(),
    "```",
    "",
    "Rules:",
    "",
    "- `name` MUST be copied exactly from the catalog above. Unknown names abort the phase — never invent or abbreviate one. The example above shows the envelope *shape*; pick the actual agents from the catalog, not from the example.",
    "- `files: []` means the agent receives the full diff. Use it for any agent whose description says to spawn on every diff, and for generalist passes whose review value depends on the cross-file picture.",
    "- `files: [\"path/a\", \"path/b\"]` restricts the agent to those files. Use it for language-, skill-, or subsystem-specific agents — scope each to the files its description targets (e.g. a language agent on that language's files, a skill agent only on files that import the skill's library).",
    "- Be inclusive with the spawn-on-every-diff agents; be selective with specialists — pick a language, skill, or subsystem agent only when its description clearly matches what the diff actually does.",
    "",
    "Now read the diff carefully, decide, write the JSON, emit the verdict.",
  ].join("\n");

/** Render the agent catalog block — one line per agent. */
const renderAgentCatalog = (): string =>
  ALL_AGENT_NAMES.map((name) => `- \`${name}\`: ${AGENTS[name].description}`).join("\n");

/**
 * Render the example routing envelope shown in the output contract. Built from
 * {@link ALL_AGENT_NAMES} — never hard-coded — so an agent rename or merge can
 * never leave a stale name in the prompt that the haiku copies verbatim into an
 * unroutable decision. This was the #38 regression: after `funnel-l1`/`-l2`
 * were merged into `funnel` (and with no TypeScript agent ever in the catalog),
 * the prompt's hard-coded examples still advertised `funnel-l1` and
 * `language-typescript`; haiku echoed them, `isAgentName` rejected them every
 * time, and the deterministic failure made the retry useless.
 */
const renderExampleEnvelope = (): string => {
  const fullDiffPicks = ALL_AGENT_NAMES.slice(0, 2);
  const scopedPick = ALL_AGENT_NAMES[ALL_AGENT_NAMES.length - 1];
  return [
    "{",
    `  "agents": [`,
    ...fullDiffPicks.map((name) => `    { "name": "${name}", "files": [] },`),
    `    { "name": "${scopedPick}", "files": ["src/foo.ts", "src/bar.ts"] }`,
    "  ]",
    "}",
  ].join("\n");
};

/** Render the file roster — small per-file summaries; no diff content here. */
const renderFileRoster = (files: readonly ChangedFile[]): string =>
  files
    .map((file) => {
      const importsField =
        file.imports.length === 0 ? "" : ` · imports: ${file.imports.slice(0, 10).join(", ")}`;
      return `- ${file.path} · .${file.ext} · ${file.lineCount} lines${importsField}`;
    })
    .join("\n");

/** Agent-name decoder: rejects a value outside the catalog (mirrors `MrStateSchema`). */
const AgentNameSchema = Schema.String.pipe(
  Schema.filter(isAgentName, {
    message: (issue) => `unknown agent name: ${JSON.stringify(issue.actual)}`,
  }),
);

/**
 * Schema for the router's JSON envelope — decodes a JSON string straight to
 * typed {@link RoutedAgent}s. The agent-name filter rejects an unknown agent,
 * `NonEmptyArray` rejects an empty list; both surface as a `ParseError` the
 * caller maps to {@link RouterMalformedOutput}.
 */
const RouterOutputSchema = Schema.parseJson(
  Schema.Struct({
    agents: Schema.NonEmptyArray(
      Schema.Struct({
        name: AgentNameSchema,
        files: Schema.Array(Schema.String),
      }),
    ),
  }),
);

/** Decode and validate the router's findings JSON. */
const parseRouterOutput = (
  raw: string,
): Effect.Effect<readonly RoutedAgent[], RouterMalformedOutput> => {
  // An empty file is a distinct mode (atomic rename failed, disk full, prompt
  // misread) — flag it with a clear reason instead of the noisy decoder dump.
  if (raw.trim() === "") {
    return Effect.fail(
      new RouterMalformedOutput({ reason: "router wrote empty findings file", raw }),
    );
  }
  return Schema.decodeUnknown(RouterOutputSchema, { errors: "all" })(raw.trim()).pipe(
    Effect.map((output) => output.agents),
    Effect.mapError(
      (error) =>
        new RouterMalformedOutput({
          reason: ParseResult.TreeFormatter.formatErrorSync(error).slice(0, 2400),
          raw,
        }),
    ),
  );
};

/**
 * `routeAgents` — spawn one haiku tmux session, hand it the diff + the agent
 * catalog, return the routing decision.
 *
 * Failure modes:
 *  - Session timeout / no verdict → propagated as PhaseError. Not retried —
 *    that's capacity, not an LLM shape glitch.
 *  - JSON parse failure / unknown agent / empty agent list → up to
 *    {@link MAX_ROUTER_ATTEMPTS} attempts before propagating as
 *    RouterMalformedOutput. Each attempt uses a distinct `ref.agent`
 *    (`router`, `router-r1`, …) so sentinel/findings/tmux/session paths
 *    never collide. The caller (review phase) maps the final failure to a
 *    HandlerError that fails the whole phase — no heuristic fallback by
 *    design.
 */
export const routeAgents = (
  input: RouteAgentsInput,
): Effect.Effect<RouteAgentsResult, PhaseError | RouterMalformedOutput, RunArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;

    // Wall-clock cap = min(router-specific cap, budget left, phase cap). All
    // attempts share this single budget — a parse failure must not reset the
    // deadline.
    const phaseBudgetMs = input.deadline - (yield* Clock.currentTimeMillis);
    const timeoutMs = Math.min(
      ROUTER_TIMEOUT_MS,
      phaseBudgetMs,
      PHASE_CAP_MINUTES[input.phase] * 60 * 1000,
    );
    if (timeoutMs < SENTINEL_POLL_MS) {
      return yield* Effect.fail(new BudgetExhausted({ phase: input.phase }));
    }

    const { text: diffText, truncated } = truncateDiff(input.fullDiff);
    const diffBytesSent = Buffer.byteLength(diffText, "utf8");
    const agentCatalog = renderAgentCatalog();
    const fileRoster = renderFileRoster(input.files);

    const tryRoute = (
      attempt: number,
    ): Effect.Effect<readonly RoutedAgent[], PhaseError | RouterMalformedOutput, RunArtifacts> =>
      Effect.gen(function* () {
        // Attempt 0 keeps the original `router` agent slot so existing artifact
        // paths and log greps are unchanged; retries get a suffixed slot.
        const refAgent = attempt === 0 ? "router" : `router-r${attempt}`;
        const ref = {
          issueIid: input.issueIid,
          phase: input.phase,
          iteration: input.iteration,
          agent: refAgent,
        };
        const findingsFile = artifacts.findingsPath(ref);
        const promptFile = artifacts.promptFilePath(ref);
        const sentinel = artifacts.sentinelPath(ref);
        const tmuxLogPath = artifacts.tmuxLogPath(ref);
        const session = artifacts.sessionName(ref);

        const promptText = buildRouterPrompt({
          findingsFile,
          agentCatalog,
          fileRoster,
          diffText,
          truncated,
        });

        yield* Effect.tryPromise({
          try: () => writeFile(promptFile, promptText),
          catch: (cause) =>
            new WorkspaceError({
              phase: input.phase,
              operation: "write router prompt",
              reason: String(cause),
            }),
        });

        yield* artifacts.logEvent({
          event: "router_starting",
          phase: input.phase,
          iteration: input.iteration,
          issueIid: input.issueIid,
          attempt,
          diffBytesSent,
          truncated,
          fileCount: input.files.length,
          model: input.model,
        });
        yield* Console.log(
          `[#${input.issueIid} ${input.phase}[${input.iteration}]] router (${input.model}${attempt === 0 ? "" : `, attempt ${attempt + 1}`}) on ${input.files.length} files, ${diffBytesSent} bytes${truncated ? " (truncated)" : ""}`,
        );

        const verdict = yield* runOneClaudeSession({
          phase: input.phase,
          worktree: input.worktree,
          session,
          tmuxLogPath,
          promptFile,
          sentinel,
          timeoutMs,
          logContext: {
            issueIid: input.issueIid,
            iteration: input.iteration,
            agent: refAgent,
          },
          model: input.model,
        });
        if (verdict !== "ROUTING_DONE") {
          return yield* Effect.fail(
            new UnexpectedVerdictError({
              phase: input.phase,
              verdict,
              expected: ["ROUTING_DONE"],
            }),
          );
        }

        const raw = yield* Effect.tryPromise({
          try: () => Bun.file(findingsFile).text(),
          catch: (cause) =>
            new WorkspaceError({
              phase: input.phase,
              operation: "read router findings",
              reason: String(cause),
            }),
        });

        const canRetry = attempt + 1 < MAX_ROUTER_ATTEMPTS;
        return yield* parseRouterOutput(raw).pipe(
          Effect.catchTag("RouterMalformedOutput", (error) =>
            Effect.gen(function* () {
              yield* artifacts.logEvent({
                event: "router_failed",
                phase: input.phase,
                iteration: input.iteration,
                issueIid: input.issueIid,
                attempt,
                willRetry: canRetry,
                reason: error.reason,
                ...summarizeRaw(error.raw),
              });
              return yield* canRetry ? tryRoute(attempt + 1) : Effect.fail(error);
            }),
          ),
        );
      });

    const routed = yield* tryRoute(0);

    yield* artifacts.logEvent({
      event: "router_complete",
      phase: input.phase,
      iteration: input.iteration,
      issueIid: input.issueIid,
      agentCount: routed.length,
      agents: routed.map((agent) => ({ name: agent.name, fileCount: agent.files.length })),
    });

    return { agents: routed, truncated, diffBytesSent };
  });

/** Exported for tests. */
export const _renderAgentCatalog = renderAgentCatalog;
export const _renderExampleEnvelope = renderExampleEnvelope;
export const _renderFileRoster = renderFileRoster;
export const _parseRouterOutput = parseRouterOutput;
