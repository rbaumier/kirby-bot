/**
 * Session/fanout.ts — `runFanOutPhase`: N parallel `claude` tmux sessions, one
 * per review agent, sharing one worktree and one Stop-hook config.
 *
 * Replacement for the single-prompt review session that called the upstream
 * `code-review` skill via the Task tool. Issue #29: Claude Code 2.1.150 broke
 * Stop-hook `decision: "block"` after ~4 consecutive `end_turn` waits, causing
 * the parent session to give up while subagents were still running. The fix is
 * to flatten the fan-out: each agent gets its own top-level session, the
 * orchestrator (this module) does the parallelism in TypeScript via
 * `Effect.forEach`.
 *
 * The agent-spawn decision now flows through `./router.ts` — a one-shot haiku
 * tmux session that reads the diff + the agent registry's `description`
 * column and returns the subset of agents to spawn, along with each agent's
 * scoped file list. Per-agent isolation is by environment variable — every
 * session exports its own `AGENT_SENTINEL` before launching `claude`, and the
 * shared Stop-hook script reads `$AGENT_SENTINEL` to know which sentinel to
 * write into. See `phase-primitives.ts` and `tmux.ts` for the mechanics.
 *
 * Concurrency is capped by {@link MAX_CONCURRENT_AGENTS}. Per-agent failures
 * are collected, not propagated — a single hung agent must not nuke the whole
 * review pass. Routing failures, by contrast, DO bubble: a malformed router
 * output or unknown agent name fails the phase by design (the router IS the
 * routing decision; a silent fallback would re-introduce the brittleness it
 * was meant to replace).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Clock, Console, Effect, Exit } from "effect";
import type { Phase } from "../config";
import { MAX_CONCURRENT_AGENTS, PHASE_CAP_MINUTES, SENTINEL_POLL_MS } from "../config";
import type { AgentName } from "../review/agents";
import { getAgentModel } from "../review/agents";
import { getChangedFilesSince } from "../review/delta-files";
import type { ChangedFile, ReviewAnalysis } from "../review/detect";
import { analyzeReviewInputs } from "../review/detect";
import { writeDiffSlices, writeFullDiff } from "../review/diff-slices";
import type { RenderError } from "../review/render-prompt";
import { renderAgentPrompt } from "../review/render-prompt";
import type { RoutedAgent, RouterMalformedOutput } from "../review/router";
import { routeAgents } from "../review/router";
import { RunArtifacts } from "../run-artifacts";
import type { PhaseError } from "./errors";
import { BudgetExhausted, WorkspaceError } from "./errors";
import { runOneClaudeSession, writeStopHookConfig } from "./phase-primitives";

/** Outcome for one agent in the fan-out. */
export type AgentOutcome =
  | { readonly kind: "ok"; readonly agent: AgentName; readonly findingsPath: string; readonly totalMs: number }
  | { readonly kind: "error"; readonly agent: AgentName; readonly reason: string; readonly totalMs: number };

/** Aggregate result of a fan-out. */
export type FanOutResult = {
  /** Deterministic-analysis output: trust boundaries, dogfood, totals. */
  readonly analysis: ReviewAnalysis;
  /** The router's decision: which agents fire + each one's file scope. */
  readonly routes: readonly RoutedAgent[];
  /** Whether the router's input diff was head-truncated. */
  readonly routerTruncated: boolean;
  /** Per-agent best-effort outcomes. */
  readonly outcomes: readonly AgentOutcome[];
  /** Path to the shared full-diff patch, reused by every full-diff agent. */
  readonly fullDiffPath: string;
};

/** Input for {@link runFanOutPhase}. */
export type RunFanOutPhaseInput = {
  readonly phase: Phase;
  readonly issueIid: number;
  readonly worktree: string;
  readonly iteration: number;
  /** Wall-clock deadline (absolute ms from epoch) for the whole fan-out. */
  readonly deadline: number;
  /** Default branch for `git diff $default...HEAD`. */
  readonly defaultBranch: string;
  /** The diff file-set the review pass consumes. Drives analysis + routing. */
  readonly files: readonly ChangedFile[];
  /** Path to the vendored templates directory (assets/code-review-templates). */
  readonly templatesDir: string;
  /**
   * Absolute path to the slim MCP config JSON passed to each agent session via
   * `--strict-mcp-config --mcp-config <path>`. Omit to inherit the global
   * operator config (legacy behaviour; not recommended for new code).
   */
  readonly mcpConfigPath?: string;
  /**
   * Block of previously-triaged findings to inject into every agent's prompt
   * via the scaffold's `{previous_findings_block}` placeholder. Empty string
   * (the default) → first iteration, nothing to skip. Built upstream from
   * `provider.listDiscussions` via {@link buildPreviousFindingsBlock} — kept
   * out of this module to avoid coupling the fan-out to the Provider seam.
   */
  readonly previousFindingsBlock?: string;
  /**
   * HEAD commit at the end of the previous review iteration, if any. When
   * defined and still an ancestor of the current HEAD, scoped agents whose
   * scope doesn't intersect the delta `<lastReviewedSha>...HEAD` are skipped
   * — they would otherwise re-flag the same code unchanged. Full-diff agents
   * (routed with `files: []`) are kept unconditionally — they need the
   * cross-file view a `fix` commit can perturb in non-obvious ways.
   */
  readonly lastReviewedSha?: string;
};

/** Templates dir resolved relative to this file at module load — handy default. */
export const DEFAULT_TEMPLATES_DIR = new URL(
  "../../assets/code-review-templates/",
  import.meta.url,
).pathname;

/** Slim MCP config for phase sessions — resolved relative to this file. */
export const DEFAULT_MCP_CONFIG_PATH = new URL(
  "../../assets/mcp/phase.json",
  import.meta.url,
).pathname;

/**
 * Render and write one agent's prompt file. Folds the {@link renderAgentPrompt}
 * + {@link writeFile} into one Effect so the fan-out body stays linear.
 */
const writeAgentPrompt = (
  phase: Phase,
  agent: AgentName,
  promptFile: string,
  promptText: string,
): Effect.Effect<void, WorkspaceError> =>
  Effect.tryPromise({
    try: () => writeFile(promptFile, promptText),
    catch: (cause) =>
      new WorkspaceError({
        phase,
        operation: `write prompt for agent ${agent}`,
        reason: String(cause),
      }),
  });

/**
 * Translate a `RenderError` into a `WorkspaceError` — Step 8 doesn't surface
 * a distinct render-failure shape upward; rendering issues are operational
 * (missing template, bad spec) and the phase-level error channel is enough.
 */
const renderErrorToWorkspace = (phase: Phase) => (error: RenderError): WorkspaceError =>
  new WorkspaceError({
    phase,
    operation: `render prompt for agent ${error.agent}`,
    reason: error.reason,
  });

/**
 * Run one agent's session and translate any failure into an `AgentOutcome`.
 * Per-agent best-effort: a timeout or render error becomes `{ kind: "error" }`
 * so the surviving N-1 agents still produce findings.
 */
type RunOneAgentParams = {
  readonly input: RunFanOutPhaseInput;
  readonly agent: AgentName;
  readonly analysis: ReviewAnalysis;
  readonly scopedFiles: readonly string[];
  readonly diffFile: string;
  readonly perAgentTimeoutMs: number;
  readonly previousFindingsBlock: string;
};

const runOneAgent = (params: RunOneAgentParams): Effect.Effect<AgentOutcome, never, RunArtifacts> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const { input, agent, analysis, scopedFiles, diffFile, perAgentTimeoutMs, previousFindingsBlock } =
      params;
    const artifacts = yield* RunArtifacts;
    const ref = {
      issueIid: input.issueIid,
      phase: input.phase,
      iteration: input.iteration,
      agent,
    };
    const promptFile = artifacts.promptFilePath(ref);
    const findingsFile = artifacts.findingsPath(ref);
    const sentinel = artifacts.sentinelPath(ref);
    const tmuxLogPath = artifacts.tmuxLogPath(ref);
    const session = artifacts.sessionName(ref);

    // The router supplied this agent's file scope. Empty = "full diff" — fall
    // back to the diff's complete file list so the prompt's `{file_list}`
    // remains informative.
    const fileList =
      scopedFiles.length === 0 ? input.files.map((file) => file.path) : scopedFiles;

    const result = yield* renderAgentPrompt({
      agent,
      diffFile,
      fileList,
      trustBoundaries: analysis.trustBoundaries,
      previousFindingsBlock,
      findingsFile,
      templatesDir: input.templatesDir,
    })
      .pipe(Effect.mapError(renderErrorToWorkspace(input.phase)))
      .pipe(
        Effect.flatMap((promptText) => writeAgentPrompt(input.phase, agent, promptFile, promptText)),
      )
      .pipe(
        Effect.flatMap(() =>
          runOneClaudeSession({
            phase: input.phase,
            worktree: input.worktree,
            session,
            tmuxLogPath,
            promptFile,
            sentinel,
            timeoutMs: perAgentTimeoutMs,
            logContext: {
              issueIid: input.issueIid,
              iteration: input.iteration,
              agent,
            },
            model: getAgentModel(agent),
            ...(input.mcpConfigPath === undefined ? {} : { mcpConfigPath: input.mcpConfigPath }),
          }),
        ),
      )
      .pipe(Effect.exit);

    const totalMs = (yield* Clock.currentTimeMillis) - startedAt;

    if (Exit.isSuccess(result)) {
      return { kind: "ok" as const, agent, findingsPath: findingsFile, totalMs };
    }
    const reason = Cause.pretty(result.cause);
    return { kind: "error" as const, agent, reason, totalMs };
  });

/**
 * Apply delta-scope filtering to the router output: when `lastReviewedSha` is
 * still an ancestor of HEAD, drop routed agents whose entire scope sits
 * outside the delta file-set. Full-diff agents (`files: []`) and empty-scope
 * agents are kept — they rely on the cross-file view that a `fix` commit can
 * perturb anywhere.
 */
const applyDeltaScope = (
  routes: readonly RoutedAgent[],
  delta: ReadonlySet<string>,
): { readonly kept: readonly RoutedAgent[]; readonly skipped: readonly AgentName[] } => {
  const kept: RoutedAgent[] = [];
  const skipped: AgentName[] = [];
  for (const route of routes) {
    const intersects =
      route.files.length === 0 ||
      route.files.some((path) => delta.has(path));
    if (intersects) { kept.push(route); }
    else { skipped.push(route.name); }
  }
  return { kept, skipped };
};

/**
 * Map the router's `RouterMalformedOutput` failure into the phase-level
 * `PhaseError` channel (a `PhaseError` passes through unchanged). The schema's
 * formatted `reason` already names the specific cause — bad JSON, unknown
 * agent, empty list — so the single tag loses no diagnostic detail.
 */
const routerErrorToPhase =
  (phase: Phase) =>
  (error: PhaseError | RouterMalformedOutput): PhaseError =>
    error._tag === "RouterMalformedOutput"
      ? new WorkspaceError({
          phase,
          operation: "route agents",
          reason: `router emitted malformed output — ${error.reason}`,
        })
      : error;

/**
 * `runFanOutPhase` — main entry point of the per-agent review fan-out.
 *
 * Sequence:
 *   1. Write the shared Stop-hook config in the worktree's `.claude/`.
 *      The hook reads `$AGENT_SENTINEL` to know which sentinel to write.
 *   2. Write the full diff once → `fullDiffPath`. Reused as both the router's
 *      input and the `{diff_file}` for every full-diff agent the router picks.
 *   3. Run the routing haiku via {@link routeAgents}. Failure aborts the
 *      phase by design — no heuristic fallback.
 *   4. Compute deterministic analysis: trust boundaries, dogfood surfaces,
 *      totals. Pure pass over the file roster.
 *   5. Optionally delta-scope filter the routes when a prior `lastReviewedSha`
 *      is still an ancestor of HEAD.
 *   6. Write per-agent diff slices for routed agents with a non-empty scope.
 *   7. Spawn one `runOneClaudeSession` per kept route, capped to
 *      {@link MAX_CONCURRENT_AGENTS} concurrency. Each session's prompt
 *      embeds `input.previousFindingsBlock` so the agent self-filters
 *      findings the previous evaluator already triaged.
 *   8. Collect outcomes (best-effort: per-agent failures don't bubble).
 */
export const runFanOutPhase = (
  input: RunFanOutPhaseInput,
): Effect.Effect<FanOutResult, PhaseError, RunArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;

    // Per-agent wall-clock budget: smaller of the phase cap and the budget
    // still left for the issue, applied per session (sessions run in parallel
    // — they share the wall-clock, not the budget).
    const perAgentTimeoutMs = Math.min(
      PHASE_CAP_MINUTES[input.phase] * 60 * 1000,
      input.deadline - (yield* Clock.currentTimeMillis),
    );
    if (perAgentTimeoutMs < SENTINEL_POLL_MS) {
      return yield* Effect.fail(new BudgetExhausted({ phase: input.phase }));
    }

    // Stop-hook first — the router's session also needs it (verdict captured
    // exactly the same way as fan-out agents).
    yield* writeStopHookConfig(input.phase, input.worktree);

    // Full diff written once; both the router (as input) and every full-diff
    // agent (as `{diff_file}`) read from this same path.
    const slug = `review-${input.issueIid}-${input.iteration}`;
    const fullDiffPath = join(artifacts.dir, `${slug}-full.patch`);
    yield* writeFullDiff({ defaultBranch: input.defaultBranch, outPath: fullDiffPath }).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceError({
            phase: input.phase,
            operation: "write full diff",
            reason: error.reason,
          }),
      ),
    );
    const fullDiff = yield* Effect.tryPromise({
      try: () => readFile(fullDiffPath, "utf8"),
      catch: (cause) =>
        new WorkspaceError({
          phase: input.phase,
          operation: "read full diff",
          reason: String(cause),
        }),
    });

    // Routing — haiku in a tmux session. Hard-fails the phase if the output
    // is malformed or the agent list is empty.
    const routerResult = yield* routeAgents({
      phase: input.phase,
      issueIid: input.issueIid,
      worktree: input.worktree,
      iteration: input.iteration,
      deadline: input.deadline,
      files: input.files,
      fullDiff,
    }).pipe(Effect.mapError(routerErrorToPhase(input.phase)));

    // Deterministic analysis — runs after routing so the run JSONL keeps the
    // chronological order (router_complete → fanout_plan). The analysis itself
    // does NOT depend on the router; we could parallelize, but routing
    // dominates wall-clock and analysis is microseconds.
    const analysis = analyzeReviewInputs(input.files);

    // Delta-scope filter: only when a prior review's HEAD is known AND still
    // an ancestor of the current HEAD. Failure of `getChangedFilesSince`
    // (e.g. shallow clone) silently disables the filter — the whole router
    // output ships intact.
    let routes: readonly RoutedAgent[] = routerResult.agents;
    let skipped: readonly AgentName[] = [];
    if (input.lastReviewedSha !== undefined) {
      const delta = yield* getChangedFilesSince({
        worktree: input.worktree,
        lastSha: input.lastReviewedSha,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (delta === null) {
        yield* Console.log(
          `[#${input.issueIid} ${input.phase}[${input.iteration}]] delta-scope disabled: ` +
            `lastSha ${input.lastReviewedSha.slice(0, 8)} is not an ancestor of HEAD`,
        );
      } else {
        const filtered = applyDeltaScope(routes, new Set(delta));
        routes = filtered.kept;
        skipped = filtered.skipped;
      }
    }

    const routeCount = routes.length;
    const skippedCount = skipped.length;
    const boundaryCount = analysis.trustBoundaries.length;
    yield* Console.log(
      `[#${input.issueIid} ${input.phase}[${input.iteration}]] fan-out planned: ` +
        `agents=${routeCount} (skipped ${skippedCount}) ` +
        `boundaries=${boundaryCount}`,
    );
    yield* artifacts.logEvent({
      event: "fanout_plan",
      phase: input.phase,
      iteration: input.iteration,
      issueIid: input.issueIid,
      agents: routes.map((route) => route.name),
      skippedAgents: skipped,
      routerTruncated: routerResult.truncated,
      trustBoundaries: analysis.trustBoundaries,
      dogfoodRequired: analysis.dogfoodRequired,
      dogfoodSurfaces: analysis.dogfoodSurfaces,
    });

    const slices = yield* writeDiffSlices({
      routes,
      fullDiffPath,
      defaultBranch: input.defaultBranch,
      slicesDir: artifacts.dir,
      slug,
    }).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceError({
            phase: input.phase,
            operation: `write diff slice for ${error.agent}`,
            reason: error.reason,
          }),
      ),
    );

    const previousFindingsBlock = input.previousFindingsBlock ?? "";
    const outcomes = yield* Effect.forEach(
      routes,
      (route) =>
        runOneAgent({
          input,
          agent: route.name,
          analysis,
          scopedFiles: route.files,
          diffFile: slices.perAgent.get(route.name) ?? fullDiffPath,
          perAgentTimeoutMs,
          previousFindingsBlock,
        }),
      { concurrency: MAX_CONCURRENT_AGENTS },
    );

    const okCount = outcomes.filter((outcome) => outcome.kind === "ok").length;
    const totalCount = outcomes.length;
    yield* Console.log(
      `[#${input.issueIid} ${input.phase}[${input.iteration}]] fan-out complete: ` +
        `${okCount}/${totalCount} agents reached AGENT_DONE`,
    );
    yield* artifacts.logEvent({
      event: "fanout_complete",
      phase: input.phase,
      iteration: input.iteration,
      issueIid: input.issueIid,
      okCount,
      total: totalCount,
      outcomes: outcomes.map((outcome) => ({
        agent: outcome.agent,
        kind: outcome.kind,
        totalMs: outcome.totalMs,
        ...(outcome.kind === "error" ? { reason: outcome.reason } : {}),
      })),
    });

    return {
      analysis,
      routes,
      routerTruncated: routerResult.truncated,
      outcomes,
      fullDiffPath: slices.fullDiffPath,
    };
  });
