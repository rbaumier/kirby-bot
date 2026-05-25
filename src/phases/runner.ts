/**
 * Phases/runner.ts — the cross-Phase plumbing each Phase Module reuses.
 *
 * Every interactive Phase drives a `claude` tmux Session and narrows the
 * verdict to an expected set. A session failure routes into the pipeline's
 * `HandlerError` channel. Only the Phase name, options, and verdicts differ.
 *
 * The wiring lives here so the seam to `runPhaseSession` is named in one
 * place. A change to the Session surface lights up every Phase at once.
 */
import { Effect } from "effect";
import type { Phase } from "../config";
import {
  describePhaseRunError,
  HandlerError,
  UnexpectedVerdictError,
} from "../pipeline/errors";
import type { PhaseRunError } from "../pipeline/errors";
import type { PipelineContext } from "../pipeline/state";
import type { RunArtifacts } from "../run-artifacts";
import { phaseTimeoutMs, runPhaseSession } from "../session/phase";
import type { VerdictToken } from "../session/verdict";

/** Options for running a single Phase Session. */
export type RunPhaseOptions = {
  readonly issueIid: number;
  readonly worktree: string;
  readonly deadline: number;
  readonly iteration: number;
  readonly replacements: Record<string, string>;
};

/**
 * Run one Phase Session and narrow the verdict to the expected set.
 *
 * Keeps the typed `PhaseError` channel of `runPhaseSession`; an out-of-set
 * verdict surfaces as `UnexpectedVerdictError` so callers route on tagged
 * data rather than re-pattern-matching a string reason.
 */
export const runPhase = <const V extends VerdictToken>(
  phase: Phase,
  options: RunPhaseOptions,
  expected: readonly V[],
): Effect.Effect<V, PhaseRunError, RunArtifacts> => {
  const expectedSet: ReadonlySet<string> = new Set(expected);
  const isExpected = (verdict: VerdictToken): verdict is V => expectedSet.has(verdict);
  return runPhaseSession({
    phase,
    issueIid: options.issueIid,
    worktree: options.worktree,
    iteration: options.iteration,
    timeoutMs: phaseTimeoutMs(phase, options.deadline),
    replacements: options.replacements,
  }).pipe(
    Effect.flatMap((verdict) =>
      isExpected(verdict)
        ? Effect.succeed(verdict)
        : Effect.fail(new UnexpectedVerdictError({ phase, verdict, expected })),
    ),
  );
};

/** Build the `RunPhaseOptions` for a PR-bound Phase — the `{worktree, mr_iid}` template. */
export const mrPhaseOptions = (
  context: PipelineContext,
  iteration: number,
): RunPhaseOptions => ({
  issueIid: context.issue.iid,
  worktree: context.worktree,
  deadline: context.deadline,
  iteration,
  replacements: { worktree: context.worktree, mr_iid: String(context.pullRequestIid) },
});

/** The five shared pipeline fields, copied off any node that carries them. */
export const pipelineContext = (state: PipelineContext): PipelineContext => ({
  issue: state.issue,
  branch: state.branch,
  worktree: state.worktree,
  deadline: state.deadline,
  pullRequestIid: state.pullRequestIid,
});

/** Map a Phase-running error into a `HandlerError` with a phase-prefixed reason. */
export const phaseRunHandlerError =
  (prefix: string) =>
  (error: PhaseRunError): HandlerError =>
    new HandlerError({ reason: `${prefix}: ${describePhaseRunError(error)}` });
