/**
 * Phases/runner.ts — cross-Phase plumbing shared by every Phase Module.
 *
 * The three helpers below carry data across the Session/pipeline seam.
 *
 * - `mrPhaseOptions`: builds `RunPhaseSessionInput` for a PR-bound Phase.
 * - `pipelineContext`: copies the five shared pipeline fields onto the next state.
 * - `phaseHandlerError`: maps `PhaseError` to `HandlerError` with a phase-prefixed reason.
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
export const phaseHandlerError =
  (prefix: string) =>
  (error: PhaseError): HandlerError =>
    new HandlerError({ reason: `${prefix}: ${describePhaseError(error)}` });
