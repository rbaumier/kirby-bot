/**
 * Pipeline/errors.ts — the failure modes the pipeline routes on.
 *
 * `HandlerError` is the only error a non-`fetch_queue` handler may fail with.
 * `step` catches it and rebuilds a `failed` state from `current`. Handlers no
 * longer spread `{issue, branch, worktree, pullRequestIid}`.
 */
import { Data } from "effect";

/**
 * A handler decided the issue cannot proceed. `reason` enters the failed state.
 *
 * Optional `branch` / `worktree` / `pullRequestIid` overrides let a handler
 * surface context the current `State` variant doesn't yet carry — e.g. the
 * `branch_worktree` push step has computed both paths but the state itself
 * stores neither.
 */
export class HandlerError extends Data.TaggedError("HandlerError")<{
  readonly reason: string;
  readonly branch?: string;
  readonly worktree?: string;
  readonly pullRequestIid?: number;
}> {}
