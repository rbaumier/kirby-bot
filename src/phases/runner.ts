/**
 * Phases/runner.ts — cross-Phase plumbing shared by every Phase Module.
 *
 * The three helpers below carry data across the Session/pipeline seam.
 *
 * - `mrPhaseOptions`: builds `RunPhaseSessionInput` for a PR-bound Phase.
 * - `pipelineContext`: copies the five shared pipeline fields onto the next state.
 * - `phaseHandlerError`: maps `PhaseError` to `HandlerError` with a phase-prefixed reason.
 */
import { Effect } from "effect";
import { MAX_FIX_CYCLES, SCRIPTS_DIR } from "../config";
import { HandlerError } from "../pipeline/errors";
import type { PipelineContext, State } from "../pipeline/state";
import { describePhaseError } from "../session/errors";
import type { PhaseError } from "../session/errors";
import type { RunPhaseSessionInput } from "../session/phase";

/**
 * Build the `RunPhaseSessionInput` for a PR-bound Phase — the
 * `{worktree, mr_iid, scripts_dir}` template. `scripts_dir` is the
 * absolute path to the orchestrator's `scripts/` folder, so prompts
 * can invoke `bun {scripts_dir}/mr-discussion.ts ...` without
 * hard-coding a stale install location.
 */
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
  replacements: {
    worktree: context.worktree,
    mr_iid: String(context.pullRequestIid),
    scripts_dir: SCRIPTS_DIR,
  },
});

/** The five shared pipeline fields, copied off any node that carries them. */
export const pipelineContext = (state: PipelineContext): PipelineContext => ({
  issue: state.issue,
  branch: state.branch,
  worktree: state.worktree,
  deadline: state.deadline,
  pullRequestIid: state.pullRequestIid,
});

/**
 * Route a converged-but-not-clean phase back to `fix`, unless the shared
 * fix-cycle budget is spent — then fail the issue for a human. Both the
 * evaluate→fix and qa→fix edges share this one cap policy and `fixCycles`
 * budget; `capDetail` only flavors the failure reason.
 */
export const toFixUnlessCapped = (
  state: PipelineContext & { readonly fixCycles: number },
  capDetail: string,
): Effect.Effect<State, HandlerError> =>
  MAX_FIX_CYCLES <= state.fixCycles
    ? Effect.fail(new HandlerError({ reason: `fix_cycle_cap: ${MAX_FIX_CYCLES} ${capDetail}` }))
    : Effect.succeed({ kind: "fix", ...pipelineContext(state), fixCycles: state.fixCycles });

/** Map a Session error into a `HandlerError` with a phase-prefixed reason. */
export const phaseHandlerError =
  (prefix: string) =>
  (error: PhaseError): HandlerError =>
    new HandlerError({ reason: `${prefix}: ${describePhaseError(error)}` });
