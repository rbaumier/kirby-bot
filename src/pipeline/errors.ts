/**
 * Pipeline/errors.ts — the failure modes the pipeline routes on.
 *
 * `HandlerError` is the only error a non-`fetch_queue` handler may fail with.
 * `step` catches it and rebuilds a `failed` state from `current`. Handlers no
 * longer spread `{issue, branch, worktree, pullRequestIid}`.
 */
import { Data } from "effect";
import type { ProviderCallError } from "../provider/types";
import { describeProviderError } from "../provider/types";

/**
 * A handler decided the issue cannot proceed. `reason` enters the failed state.
 *
 * Pipeline context (branch / worktree / pullRequestIid) is recovered by the
 * seam via `failedFieldsOf(current)` — handlers do not plumb it through the
 * error. Each state variant is the source of truth for the fields it has.
 */
export class HandlerError extends Data.TaggedError("HandlerError")<{
  readonly reason: string;
}> {}

/** Map a `ProviderCallError` into a `HandlerError` with a phase-prefixed reason. */
export const providerHandlerError =
  (prefix: string) =>
  (error: ProviderCallError): HandlerError =>
    new HandlerError({ reason: `${prefix}: ${describeProviderError(error)}` });
