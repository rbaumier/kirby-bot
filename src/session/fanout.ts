/**
 * Session/fanout.ts — `runFanOutPhase`: N parallel `claude` tmux sessions, one
 * per review agent, sharing one worktree and one Stop-hook config.
 *
 * This is the replacement for the single-prompt review session that called the
 * upstream `code-review` skill via the Task tool. Issue #29: Claude Code
 * 2.1.150 broke Stop-hook `decision: "block"` after ~4 consecutive `end_turn`
 * waits, causing the parent session to give up while subagents were still
 * running. The fix is to flatten the fan-out: each agent gets its own
 * top-level session, the orchestrator (this module) does the parallelism in
 * TypeScript via `Effect.forEach`.
 *
 * Per-agent isolation is by environment variable — every session exports its
 * own `AGENT_SENTINEL` before launching `claude`, and the shared Stop-hook
 * script reads `$AGENT_SENTINEL` to know which sentinel to write into. See
 * `phase-primitives.ts` and `tmux.ts` for the underlying mechanics.
 *
 * Concurrency is capped by {@link MAX_CONCURRENT_AGENTS} to keep API
 * pressure and local CPU contention bounded. Per-agent failures are
 * collected, not propagated — a single hung agent must not nuke the whole
 * review pass.
 */
import { writeFile } from "node:fs/promises";
import { Cause, Console, Effect, Exit } from "effect";
import type { Phase } from "../config";
import { MAX_CONCURRENT_AGENTS, PHASE_CAP_MINUTES, SENTINEL_POLL_MS } from "../config";
import { type AgentName, getAgentModel } from "../review/agents";
import { getChangedFilesSince } from "../review/delta-files";
import type { ChangedFile, ReviewPlan } from "../review/detect";
import { detectReviewPlan } from "../review/detect";
import { agentScope, writeDiffSlices } from "../review/diff-slices";
import { renderAgentPrompt, type RenderError } from "../review/render-prompt";
import { RunArtifacts } from "../run-artifacts";
import { BudgetExhausted, type PhaseError, WorkspaceError } from "./errors";
import { runOneClaudeSession, writeStopHookConfig } from "./phase-primitives";

/** Outcome for one agent in the fan-out. */
export type AgentOutcome =
  | { readonly kind: "ok"; readonly agent: AgentName; readonly findingsPath: string; readonly totalMs: number }
  | { readonly kind: "error"; readonly agent: AgentName; readonly reason: string; readonly totalMs: number };

/** Aggregate result of a fan-out. */
export type FanOutResult = {
  readonly plan: ReviewPlan;
  readonly outcomes: ReadonlyArray<AgentOutcome>;
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
  /** The diff file-set the review pass consumes. Drives both detection and slicing. */
  readonly files: ReadonlyArray<ChangedFile>;
  /** Force the Full tier even if the diff would compute Lite. */
  readonly forceFull?: boolean;
  /** Path to the vendored templates directory (assets/code-review-templates). */
  readonly templatesDir: string;
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
   * (correctness, matt-review, …) are kept unconditionally — they need the
   * cross-file view a `fix` commit can perturb in non-obvious ways.
   */
  readonly lastReviewedSha?: string;
};

/** Templates dir resolved relative to this file at module load — handy default. */
export const DEFAULT_TEMPLATES_DIR = new URL(
  "../../assets/code-review-templates/",
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
 * so the surviving N-1 agents still produce findings. The orchestrator
 * logs the failure into the run's JSONL event stream via
 * {@link runOneClaudeSession}'s own taps.
 */
const runOneAgent = (params: {
  readonly input: RunFanOutPhaseInput;
  readonly agent: AgentName;
  readonly plan: ReviewPlan;
  readonly diffFile: string;
  readonly perAgentTimeoutMs: number;
  readonly previousFindingsBlock: string;
}): Effect.Effect<AgentOutcome, never, RunArtifacts> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const { input, agent, plan, diffFile, perAgentTimeoutMs, previousFindingsBlock } = params;
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

    // The list of files this agent owns — for the prompt's {file_list}. We use
    // the same scoping logic the slice writer used: but we don't re-derive
    // here because writeDiffSlices already wrote the slice; we just pass the
    // plan's full file list to keep it simple and let the slice be the source
    // of truth on scoping. The prompt template uses {file_list} as a hint, not
    // as a hard constraint — the agent reads {diff_file} for the real picture.
    const fileList = input.files.map((file) => file.path);

    const result = yield* renderAgentPrompt({
      agent,
      diffFile,
      fileList,
      trustBoundaries: plan.trustBoundaries,
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
          }),
        ),
      )
      .pipe(Effect.exit);

    const totalMs = Date.now() - startedAt;

    if (Exit.isSuccess(result)) {
      return { kind: "ok" as const, agent, findingsPath: findingsFile, totalMs };
    }
    // Best-effort: any failure (render, write, session) demotes the agent to
    // an `error` outcome. The aggregate result still contains it so the
    // caller can see which agents missed and decide how to report.
    const reason = Cause.pretty(result.cause);
    return { kind: "error" as const, agent, reason, totalMs };
  });

/**
 * `runFanOutPhase` — main entry point of the per-agent review fan-out.
 *
 * Sequence:
 *   1. Compute the review plan (`detectReviewPlan`) — tier, agent list,
 *      trust boundaries, dogfood gate.
 *   2. Delta-scope (when `input.lastReviewedSha` is set): drop scoped agents
 *      whose scope doesn't intersect the files changed since the previous
 *      review's HEAD. Skipped agents are logged but never reach a session.
 *   3. Write the shared Stop-hook config in the worktree's `.claude/`.
 *      The hook reads `$AGENT_SENTINEL` to know which sentinel to write.
 *   4. Write per-agent diff slices to `artifacts.dir`.
 *   5. Spawn one `runOneClaudeSession` per agent, capped to
 *      {@link MAX_CONCURRENT_AGENTS} concurrency. Each session's prompt
 *      embeds `input.previousFindingsBlock` so the agent self-filters
 *      findings the previous evaluator already triaged.
 *   6. Collect outcomes (best-effort: per-agent failures don't bubble).
 */
export const runFanOutPhase = (
  input: RunFanOutPhaseInput,
): Effect.Effect<FanOutResult, PhaseError, RunArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;

    // Per-agent wall-clock budget: the smaller of the phase cap and the
    // budget still left for the issue, applied to each session independently
    // (sessions run in parallel — they share the wall-clock, not the budget).
    const perAgentTimeoutMs = Math.min(
      PHASE_CAP_MINUTES[input.phase] * 60 * 1000,
      input.deadline - Date.now(),
    );
    if (perAgentTimeoutMs < SENTINEL_POLL_MS) {
      return yield* Effect.fail(new BudgetExhausted({ phase: input.phase }));
    }

    const detected = detectReviewPlan(
      input.forceFull === undefined
        ? { files: input.files }
        : { files: input.files, forceFull: input.forceFull },
    );

    // Delta-scope: when a prior review's HEAD is known and still an ancestor
    // of the current HEAD, drop scoped agents whose territory has not changed
    // since. Full-diff agents and empty-scope fallbacks are kept — they rely
    // on the cross-file view that a `fix` commit can perturb anywhere.
    const skipped: AgentName[] = [];
    let plan: ReviewPlan = detected;
    if (input.lastReviewedSha !== undefined) {
      const delta = yield* getChangedFilesSince({
        worktree: input.worktree,
        lastSha: input.lastReviewedSha,
      }).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (delta === null) {
        yield* Console.log(
          `[#${input.issueIid} ${input.phase}[${input.iteration}]] delta-scope disabled: ` +
            `lastSha ${input.lastReviewedSha.slice(0, 8)} is not an ancestor of HEAD`,
        );
      } else {
        const deltaSet = new Set(delta);
        const kept: AgentName[] = [];
        for (const agent of detected.agents) {
          const scope = agentScope(agent, input.files);
          const intersects =
            scope === null ||
            scope.length === 0 ||
            scope.some((path) => deltaSet.has(path));
          if (intersects) kept.push(agent);
          else skipped.push(agent);
        }
        plan = { ...detected, agents: kept };
      }
    }

    yield* Console.log(
      `[#${input.issueIid} ${input.phase}[${input.iteration}]] fan-out planned: ` +
        `tier=${plan.tier} agents=${plan.agents.length} (skipped ${skipped.length}) ` +
        `boundaries=${plan.trustBoundaries.length}`,
    );
    yield* artifacts.logEvent({
      event: "fanout_plan",
      phase: input.phase,
      iteration: input.iteration,
      issueIid: input.issueIid,
      tier: plan.tier,
      agents: plan.agents,
      skippedAgents: skipped,
      trustBoundaries: plan.trustBoundaries,
      dogfoodRequired: plan.dogfoodRequired,
      dogfoodSurfaces: plan.dogfoodSurfaces,
    });

    yield* writeStopHookConfig(input.phase, input.worktree);

    const slug = `review-${input.issueIid}-${input.iteration}`;
    const slices = yield* writeDiffSlices({
      plan,
      files: input.files,
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
      plan.agents,
      (agent) =>
        runOneAgent({
          input,
          agent,
          plan,
          diffFile: slices.perAgent.get(agent) ?? slices.fullDiffPath,
          perAgentTimeoutMs,
          previousFindingsBlock,
        }),
      { concurrency: MAX_CONCURRENT_AGENTS },
    );

    const okCount = outcomes.filter((outcome) => outcome.kind === "ok").length;
    yield* Console.log(
      `[#${input.issueIid} ${input.phase}[${input.iteration}]] fan-out complete: ` +
        `${okCount}/${outcomes.length} agents reached AGENT_DONE`,
    );
    yield* artifacts.logEvent({
      event: "fanout_complete",
      phase: input.phase,
      iteration: input.iteration,
      issueIid: input.issueIid,
      okCount,
      total: outcomes.length,
      outcomes: outcomes.map((outcome) => ({
        agent: outcome.agent,
        kind: outcome.kind,
        totalMs: outcome.totalMs,
        ...(outcome.kind === "error" ? { reason: outcome.reason } : {}),
      })),
    });

    return { plan, outcomes, fullDiffPath: slices.fullDiffPath };
  });
