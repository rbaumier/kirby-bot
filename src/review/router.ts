/**
 * Review/router.ts — `routeAgents`: a one-shot haiku call that reads the diff
 * + the agent catalog (`AGENTS`, with their descriptions) and returns which
 * subset of agents to spawn, plus each agent's scoped file list.
 *
 * Replaces every static spawn heuristic (path substring, extension list,
 * import substring) with semantic judgment from a cheap model. The router
 * runs as a regular `claude` tmux session — same Stop-hook contract, same
 * sentinel + findings JSON contract as any fan-out agent, just with a
 * dedicated prompt and a `ROUTING_DONE` verdict.
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
import { Console, Data, Effect } from "effect";
import type { Phase } from "../config";
import { PHASE_CAP_MINUTES, SENTINEL_POLL_MS } from "../config";
import { RunArtifacts } from "../run-artifacts";
import { BudgetExhausted, type PhaseError, UnexpectedVerdictError, WorkspaceError } from "../session/errors";
import { runOneClaudeSession } from "../session/phase-primitives";
import { AGENTS, ALL_AGENT_NAMES, type AgentName, isAgentName } from "./agents";
import type { ChangedFile } from "./detect";

/** Total budget for the truncated diff sent to the router, in bytes. */
export const ROUTER_DIFF_MAX_BYTES = 100 * 1024;

/** Marker appended to head-truncated per-file slices so the router knows it's incomplete. */
const TRUNCATION_MARKER = "\n\n... [truncated by kirby-bot router]";

/** Haiku cap — the router is fast; this is the wall-clock hedge if it hangs. */
const ROUTER_TIMEOUT_MS = 5 * 60 * 1000;

/** Failure modes specific to {@link routeAgents}. */
export class RouterMalformedOutput extends Data.TaggedError("RouterMalformedOutput")<{
  readonly reason: string;
  readonly raw: string;
}> {}

export class RouterUnknownAgent extends Data.TaggedError("RouterUnknownAgent")<{
  readonly agent: string;
}> {}

export class RouterEmpty extends Data.TaggedError("RouterEmpty")<{}> {}

/** Input for {@link routeAgents}. */
export type RouteAgentsInput = {
  readonly phase: Phase;
  readonly issueIid: number;
  readonly worktree: string;
  readonly iteration: number;
  /** Wall-clock deadline (absolute ms from epoch) for the whole review phase. */
  readonly deadline: number;
  /** The file roster the router decides over — paths + metadata. */
  readonly files: ReadonlyArray<ChangedFile>;
  /** The full diff text (will be truncated to ~100KB before being sent). */
  readonly fullDiff: string;
};

/** One agent decision the router emitted. */
export type RoutedAgent = {
  readonly name: AgentName;
  /**
   * Files the router restricted this agent to. Empty array means "no
   * restriction — pass the full diff". Non-empty means "scope this agent to
   * these files only" (the orchestrator slices the diff accordingly).
   */
  readonly files: ReadonlyArray<string>;
};

/** Aggregate result of one routing pass. */
export type RouteAgentsResult = {
  readonly agents: ReadonlyArray<RoutedAgent>;
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
  if (bytes <= maxBytes) return { text: fullDiff, truncated: false };

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
    if (hunkBytes <= perFileBudget) return hunk;
    truncatedAny = true;
    const headRoom = perFileBudget - TRUNCATION_MARKER.length;
    if (headRoom <= 0) return TRUNCATION_MARKER;
    return Buffer.from(hunk, "utf8").slice(0, headRoom).toString("utf8") + TRUNCATION_MARKER;
  });

  return { text: truncatedParts.join(""), truncated: truncatedAny };
};

/**
 * Build the routing prompt: kirby-bot preamble, agent catalog, truncated diff,
 * JSON output contract. Inline string — small enough that vendoring as a
 * template would add more ceremony than it saves.
 */
const buildRouterPrompt = (input: {
  readonly findingsFile: string;
  readonly agentCatalog: string;
  readonly fileRoster: string;
  readonly diffText: string;
  readonly truncated: boolean;
}): string =>
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
    "{",
    `  "agents": [`,
    `    { "name": "funnel-l1", "files": [] },`,
    `    { "name": "correctness", "files": [] },`,
    `    { "name": "language-typescript", "files": ["src/foo.ts", "src/bar.tsx"] }`,
    "  ]",
    "}",
    "```",
    "",
    "Rules:",
    "",
    "- `name` MUST be one of the agent names listed above. Unknown names abort the phase.",
    "- `files: []` means the agent receives the full diff. Use for funnel-l1, funnel-l2, correctness, tests, generalist passes (matt-review, thermo-nuclear), and any agent whose review value depends on the cross-file picture.",
    "- `files: [\"path/a\", \"path/b\"]` restricts the agent to those files. Use for language-specific agents (e.g. language-typescript on `.ts/.tsx` files), skill agents (drizzle-orm only on files importing drizzle), and subsystem agents (billing-subsystem only on billing files).",
    "- Be inclusive with always-on agents (funnel-l1, funnel-l2, occam-razor, correctness, tests, simplify, coding-standards). Be selective with specialist ones — only pick a subsystem or language agent if its rule clearly matches.",
    "- Pick `general-opus` only for large diffs (>200 lines) or visibly high-stakes ones (auth, billing, schema migrations).",
    "- Pick `claude-md-materiality` only when the diff teaches something that *should* be in the repo's CLAUDE.md / AGENTS.md but those files are unchanged.",
    "",
    "Now read the diff carefully, decide, write the JSON, emit the verdict.",
  ].join("\n");

/** Render the agent catalog block — one line per agent. */
const renderAgentCatalog = (): string =>
  ALL_AGENT_NAMES.map((name) => `- \`${name}\`: ${AGENTS[name].description}`).join("\n");

/** Render the file roster — small per-file summaries; no diff content here. */
const renderFileRoster = (files: ReadonlyArray<ChangedFile>): string =>
  files
    .map((file) => {
      const importsField =
        file.imports.length === 0 ? "" : ` · imports: ${file.imports.slice(0, 10).join(", ")}`;
      return `- ${file.path} · .${file.ext} · ${file.lineCount} lines${importsField}`;
    })
    .join("\n");

/** Parse and validate the router's findings JSON. */
const parseRouterOutput = (
  raw: string,
): Effect.Effect<ReadonlyArray<RoutedAgent>, RouterMalformedOutput | RouterUnknownAgent | RouterEmpty> =>
  Effect.gen(function* () {
    const trimmed = raw.trim();
    if (trimmed === "") {
      return yield* Effect.fail(
        new RouterMalformedOutput({ reason: "findings file is empty", raw }),
      );
    }
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(trimmed),
      catch: (cause) =>
        new RouterMalformedOutput({ reason: `JSON.parse failed: ${String(cause)}`, raw: trimmed }),
    });
    if (parsed === null || typeof parsed !== "object" || !("agents" in parsed)) {
      return yield* Effect.fail(
        new RouterMalformedOutput({ reason: "missing top-level 'agents' field", raw: trimmed }),
      );
    }
    const agents = (parsed as { readonly agents: unknown }).agents;
    if (!Array.isArray(agents)) {
      return yield* Effect.fail(
        new RouterMalformedOutput({ reason: "'agents' is not an array", raw: trimmed }),
      );
    }
    if (agents.length === 0) {
      return yield* Effect.fail(new RouterEmpty());
    }
    const routed: RoutedAgent[] = [];
    for (const item of agents) {
      if (item === null || typeof item !== "object") {
        return yield* Effect.fail(
          new RouterMalformedOutput({ reason: `non-object agent entry: ${JSON.stringify(item)}`, raw: trimmed }),
        );
      }
      const name = (item as { readonly name?: unknown }).name;
      const files = (item as { readonly files?: unknown }).files;
      if (typeof name !== "string") {
        return yield* Effect.fail(
          new RouterMalformedOutput({ reason: `agent.name is not a string: ${JSON.stringify(item)}`, raw: trimmed }),
        );
      }
      if (!isAgentName(name)) {
        return yield* Effect.fail(new RouterUnknownAgent({ agent: name }));
      }
      if (!Array.isArray(files)) {
        return yield* Effect.fail(
          new RouterMalformedOutput({ reason: `agent.files is not an array (agent=${name})`, raw: trimmed }),
        );
      }
      const typedFiles: string[] = [];
      for (const f of files) {
        if (typeof f !== "string") {
          return yield* Effect.fail(
            new RouterMalformedOutput({ reason: `agent.files contains non-string (agent=${name})`, raw: trimmed }),
          );
        }
        typedFiles.push(f);
      }
      routed.push({ name, files: typedFiles });
    }
    return routed;
  });

/**
 * `routeAgents` — spawn one haiku tmux session, hand it the diff + the agent
 * catalog, return the routing decision.
 *
 * Failure modes:
 *  - Session timeout / no verdict → propagated as PhaseError.
 *  - JSON parse failure / unknown agent / empty agent list → fail with a
 *    typed RouterError. The caller (review phase) maps these to a
 *    HandlerError that fails the whole phase — no heuristic fallback by
 *    design.
 */
export const routeAgents = (
  input: RouteAgentsInput,
): Effect.Effect<
  RouteAgentsResult,
  PhaseError | RouterMalformedOutput | RouterUnknownAgent | RouterEmpty,
  RunArtifacts
> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    const ref = {
      issueIid: input.issueIid,
      phase: input.phase,
      iteration: input.iteration,
      agent: "router",
    };

    // Wall-clock cap = min(router-specific cap, budget left, phase cap).
    const phaseBudgetMs = input.deadline - Date.now();
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

    const findingsFile = artifacts.findingsPath(ref);
    const promptFile = artifacts.promptFilePath(ref);
    const sentinel = artifacts.sentinelPath(ref);
    const tmuxLogPath = artifacts.tmuxLogPath(ref);
    const session = artifacts.sessionName(ref);

    const promptText = buildRouterPrompt({
      findingsFile,
      agentCatalog: renderAgentCatalog(),
      fileRoster: renderFileRoster(input.files),
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
      diffBytesSent,
      truncated,
      fileCount: input.files.length,
    });
    yield* Console.log(
      `[#${input.issueIid} ${input.phase}[${input.iteration}]] router (haiku) on ${input.files.length} files, ${diffBytesSent} bytes${truncated ? " (truncated)" : ""}`,
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
        agent: "router",
      },
      model: "haiku",
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

    // The session ended with a verdict. Read the findings file the haiku wrote.
    const raw = yield* Effect.tryPromise({
      try: () => Bun.file(findingsFile).text(),
      catch: (cause) =>
        new WorkspaceError({
          phase: input.phase,
          operation: "read router findings",
          reason: String(cause),
        }),
    });
    const routed = yield* parseRouterOutput(raw);

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
export const _renderFileRoster = renderFileRoster;
export const _parseRouterOutput = parseRouterOutput;
