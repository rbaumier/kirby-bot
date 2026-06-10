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
 * The review fleet has been replaced by a single fable agent (see
 * {@link SINGLE_FABLE_AGENT}): one `claude` session carrying every compressed
 * skill + role-body, reviewing the full diff in one shot and self-selecting
 * which passes apply. The router (`./router.ts`) and the other registry
 * entries are dormant — the spawn list is now the static single route. The
 * fan-out plumbing is kept (it still spawns N sessions in principle, and the
 * aggregation/anchoring is identical); N just happens to be 1.
 *
 * Per-agent isolation is by environment variable — the session exports its own
 * `AGENT_SENTINEL` before launching `claude`, and the shared Stop-hook script
 * reads `$AGENT_SENTINEL` to know which sentinel to write into. See
 * `phase-primitives.ts` and `tmux.ts` for the mechanics. Concurrency is capped
 * by {@link MAX_CONCURRENT_AGENTS}; agent failures are collected, not
 * propagated — best-effort isolation kept from the fleet era (with one agent
 * it just means a hung review yields an empty roster rather than a phase error).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Chunk, Clock, Console, Effect, Exit } from "effect";
import type { Phase } from "../config";
import { MAX_CONCURRENT_AGENTS, PHASE_CAP_MINUTES, SENTINEL_POLL_MS } from "../config";
import type { AgentName } from "../review/agents";
import { getAgentModel, SINGLE_FABLE_AGENT } from "../review/agents";
import type { ChangedFile, ReviewAnalysis } from "../review/detect";
import { analyzeReviewInputs } from "../review/detect";
import { writeDiffSlices, writeFullDiff } from "../review/diff-slices";
import type { RenderError } from "../review/render-prompt";
import { renderAgentPrompt } from "../review/render-prompt";
import type { RoutedAgent } from "../review/router";
import { RunArtifacts } from "../run-artifacts";
import type { PhaseError } from "./errors";
import { BudgetExhausted, UsageLimitHit, WorkspaceError } from "./errors";
import { runOneClaudeSession, writeStopHookConfig } from "./phase-primitives";
import type { VerdictToken } from "./verdict";

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
  /**
   * Per-agent diff slice path — the same `{diff_file}` each agent reviewed.
   * Fed to the line resolver so a finding's snippet is matched against the
   * exact diff the emitting agent saw. Full-diff agents map to `fullDiffPath`.
   */
  readonly perAgentDiffPath: ReadonlyMap<AgentName, string>;
  /** Number of agents that successfully reached AGENT_DONE. */
  readonly okCount: number;
  /** Total number of agents that ran (includes errors and timeouts). */
  readonly totalCount: number;
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
   * The author's intent (issue + approved plan) prepended to every agent's
   * prompt so a deliberate decision is not re-flagged as a bug (#84). Empty
   * string (the default) → no usable intent, nothing prepended. Built upstream
   * by {@link buildIntentBlock} in the review phase.
   */
  readonly intentBlock?: string;
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
 * rather than bubbling — the fan-out reports a partial roster instead of
 * aborting. (At the current single-agent route that "partial" is just zero
 * findings; the plumbing predates the fleet's retirement.)
 */
type RunOneAgentParams = {
  readonly input: RunFanOutPhaseInput;
  readonly agent: AgentName;
  readonly analysis: ReviewAnalysis;
  readonly scopedFiles: readonly string[];
  readonly diffFile: string;
  readonly perAgentTimeoutMs: number;
  readonly previousFindingsBlock: string;
  readonly intentBlock: string;
};

/**
 * Pull a {@link UsageLimitHit} out of a failed agent's `Cause`, if present.
 * The plan limit is shared, so one agent hitting it means every sibling will
 * too — that single failure is re-raised (not swallowed into an `error`
 * outcome) to short-circuit the whole fan-out (#77).
 */
export const usageLimitFromCause = (cause: Cause.Cause<PhaseError>): UsageLimitHit | undefined =>
  Chunk.toReadonlyArray(Cause.failures(cause)).find(
    (error): error is UsageLimitHit => error._tag === "UsageLimitHit",
  );

/**
 * Turn one agent session's `Exit` into a best-effort {@link AgentOutcome},
 * except when the failure carries a {@link UsageLimitHit}: that is re-raised so
 * the enclosing `Effect.forEach` interrupts the still-running and queued
 * siblings instead of each idling to the cap (#77). Every other failure stays
 * per-agent — a single hung agent must not nuke the whole review pass.
 */
export const agentOutcomeOrAbort = (params: {
  readonly exit: Exit.Exit<VerdictToken, PhaseError>;
  readonly agent: AgentName;
  readonly findingsPath: string;
  readonly totalMs: number;
}): Effect.Effect<AgentOutcome, UsageLimitHit> => {
  const { exit, agent, findingsPath, totalMs } = params;
  if (Exit.isSuccess(exit)) {
    return Effect.succeed({ kind: "ok" as const, agent, findingsPath, totalMs });
  }
  const usageLimit = usageLimitFromCause(exit.cause);
  return usageLimit !== undefined
    ? Effect.fail(usageLimit)
    : Effect.succeed({ kind: "error" as const, agent, reason: Cause.pretty(exit.cause), totalMs });
};

const runOneAgent = (
  params: RunOneAgentParams,
): Effect.Effect<AgentOutcome, UsageLimitHit, RunArtifacts> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const {
      input,
      agent,
      analysis,
      scopedFiles,
      diffFile,
      perAgentTimeoutMs,
      previousFindingsBlock,
      intentBlock,
    } = params;
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

    // The route carries this agent's file scope. The single route uses
    // `files: []` ("full diff"), so this falls back to the diff's complete
    // file list, keeping the prompt's `{file_list}` informative.
    const fileList =
      scopedFiles.length === 0 ? input.files.map((file) => file.path) : scopedFiles;

    const result = yield* renderAgentPrompt({
      agent,
      diffFile,
      fileList,
      trustBoundaries: analysis.trustBoundaries,
      previousFindingsBlock,
      intentBlock,
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

    return yield* agentOutcomeOrAbort({ exit: result, agent, findingsPath: findingsFile, totalMs });
  });

/**
 * True when the full diff is empty even though the roster lists changed files.
 * This is an infrastructure failure — the diff was taken against the wrong tree
 * (the empty-diff bug fixed in diff-slices.ts), a shallow clone, or a bad
 * default branch — never a legitimate "no changes" state: `git diff` over a
 * non-empty numstat roster always emits content (a binary file renders as
 * "Binary files … differ", a mode-only change renders a mode line). Routing
 * reviewers over an empty diff is what silently produced "No findings." on
 * every run (the #955 regression), so the caller fails loudly instead.
 */
export const diffEmptyDespiteRoster = (fileCount: number, fullDiff: string): boolean =>
  fileCount > 0 && Buffer.byteLength(fullDiff, "utf8") === 0;

/**
 * `runFanOutPhase` — main entry point of the per-agent review fan-out.
 *
 * Sequence:
 *   1. Write the shared Stop-hook config in the worktree's `.claude/`.
 *      The hook reads `$AGENT_SENTINEL` to know which sentinel to write.
 *   2. Write the full diff once → `fullDiffPath`, the `{diff_file}` the single
 *      fable agent reads.
 *   3. Compute deterministic analysis: trust boundaries, dogfood surfaces,
 *      totals. Pure pass over the file roster.
 *   4. Build the static single route — the {@link SINGLE_FABLE_AGENT} over the
 *      full diff. No router, no delta-scope.
 *   5. Spawn its `runOneClaudeSession`. The prompt embeds
 *      `input.previousFindingsBlock` so the agent self-filters findings the
 *      previous evaluator already triaged.
 *   6. Collect the outcome (best-effort: an agent failure doesn't bubble).
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

    // Stop-hook first — the agent's verdict is captured through it.
    yield* writeStopHookConfig(input.phase, input.worktree);

    // Full diff written once; the single agent reads it as `{diff_file}`.
    const slug = `review-${input.issueIid}-${input.iteration}`;
    const fullDiffPath = join(artifacts.dir, `${slug}-full.patch`);
    yield* writeFullDiff({ worktree: input.worktree, defaultBranch: input.defaultBranch, outPath: fullDiffPath }).pipe(
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

    // Roster says files changed but the diff is empty — fail loudly instead of
    // routing reviewers over nothing and silently concluding "No findings."
    // (the #955 regression). See {@link diffEmptyDespiteRoster}.
    if (diffEmptyDespiteRoster(input.files.length, fullDiff)) {
      yield* artifacts.logEvent({
        event: "fanout_diff_empty",
        phase: input.phase,
        iteration: input.iteration,
        issueIid: input.issueIid,
        fileCount: input.files.length,
      });
      return yield* Effect.fail(
        new WorkspaceError({
          phase: input.phase,
          operation: "verify full diff",
          reason: `full diff is empty but ${input.files.length} file(s) changed — diff taken against the wrong tree?`,
        }),
      );
    }

    // Deterministic analysis: trust boundaries feed the prompt, dogfood
    // surfaces are logged. Pure pass over the file roster.
    const analysis = analyzeReviewInputs(input.files);

    // The review fleet is replaced by ONE fable agent carrying every compressed
    // skill + role-body (assets/code-review-templates/single-agent-review-fable.md).
    // No router, no per-agent file scoping, no delta-scope: a single route over
    // the full diff (`files: []` ⇒ full-diff scope). The agent self-selects which
    // passes apply via the prompt's "Use this paragraph if…" gates.
    const routes: readonly RoutedAgent[] = [{ name: SINGLE_FABLE_AGENT, files: [] }];
    const skipped: readonly AgentName[] = [];
    const routerTruncated = false;

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
      routerTruncated,
      trustBoundaries: analysis.trustBoundaries,
      dogfoodRequired: analysis.dogfoodRequired,
      dogfoodSurfaces: analysis.dogfoodSurfaces,
    });

    const slices = yield* writeDiffSlices({
      routes,
      fullDiffPath,
      worktree: input.worktree,
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
    const intentBlock = input.intentBlock ?? "";
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
          intentBlock,
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
      routerTruncated,
      outcomes,
      fullDiffPath: slices.fullDiffPath,
      perAgentDiffPath: slices.perAgent,
      okCount,
      totalCount,
    };
  });
