/**
 * Phases/runner.ts — the cross-Phase plumbing each Phase Module reuses.
 *
 * `mrPhaseOptions` builds the `runPhaseSession` input shape for a PR-bound
 * Phase. `pipelineContext` carries the five shared pipeline fields forward.
 * `phaseRunHandlerError` maps a Session failure into a `HandlerError` with a
 * phase-prefixed reason — the seam the pipeline routes on.
 */
import { HandlerError } from "../pipeline/errors";
import type { PipelineContext } from "../pipeline/state";
import { describePhaseError } from "../session/errors";
import type { PhaseError } from "../session/errors";
import type { RunPhaseSessionInput } from "../session/phase";

/** Build the `RunPhaseSessionInput` for a PR-bound Phase — the `{worktree, mr_iid}` template. */
export const mrPhaseOptions = (
  context: PipelineContext,
  phase: RunPhaseSessionInput["phase"],
  iteration: number,
): RunPhaseSessionInput => ({
  phase,
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

/** Map a Session error into a `HandlerError` with a phase-prefixed reason. */
export const phaseRunHandlerError =
  (prefix: string) =>
  (error: PhaseError): HandlerError =>
    new HandlerError({ reason: `${prefix}: ${describePhaseError(error)}` });
