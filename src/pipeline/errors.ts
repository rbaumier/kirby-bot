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
 * What a handler failure *means* for the issue — the seam routes on this, not on
 * the reason string (see ADR 0004). The fate is decided where the error is born,
 * while its typed cause is still in hand.
 *
 * - `interruption` — an external/environment cut-off; re-queue free (uncapped).
 * - `stall` — the work consumed its session/budget without a verdict, or a cause
 *   that recurs on resume; re-queue but capped ({@link STALL_CAP}).
 * - `failure` — the agent judged, or a safety refusal; `failed-by-agent`, human.
 * - `fatal` — a deploy bug (e.g. a missing prompt template); crash the *run*, do
 *   not park the issue.
 */
export type Fate = "interruption" | "stall" | "failure" | "fatal";

/**
 * A handler decided the issue cannot proceed. `reason` enters the end state;
 * `fate` decides which end state (failed / stalled / interrupted) the seam
 * routes to.
 *
 * Pipeline context (branch / worktree / pullRequestIid) is recovered by the
 * seam via `endFieldsOf(current)` — handlers do not plumb it through the
 * error. Each state variant is the source of truth for the fields it has.
 *
 * `usageLimitResetText` is the one carrier the seam *does* read off the error:
 * when a phase fails because Claude's usage-limit dialog fired (an
 * `interruption`), #77's detection sets it to the captured "resets … (tz)"
 * substring, and the seam threads it onto the `interrupted` state so the
 * orchestrator can back off until the limit resets (#78). Unset (and ignored)
 * for every other failure.
 *
 * `errorType` is the typed `_tag` of the cause the fate was decided from
 * (`ProviderHttpError`, `SessionTimedOut`, `TmuxError`, …). The reason string
 * already describes the failure for a human; `errorType` preserves the machine
 * tag so `run.jsonl` analytics can tell a 429 from a session timeout from a
 * `tmux` crash without regexing prose. Only the two central mappers
 * (`providerHandlerError`, `phaseHandlerError`) set it — the direct
 * `new HandlerError` sites (git/shell/queue) leave it unset: their shell-level
 * `_tag` is too generic to bucket on (every git step shares one) and their
 * `reason` already names the operation. Unset → `null` past the seam.
 */
export class HandlerError extends Data.TaggedError("HandlerError")<{
  readonly reason: string;
  readonly fate: Fate;
  readonly usageLimitResetText?: string;
  readonly errorType?: string;
}> {}

/**
 * The fate of a provider call failure, by status — `providerHandlerError`'s
 * single shared wrapper cannot use a constant, so it computes one here from the
 * *typed* error (not a regex on a flattened string). 5xx / network / 429 are
 * transient → `interruption`; an auth/config 401-403 is a deploy bug → `fatal`;
 * any other 4xx the retry will only re-hit → `failure`.
 */
export const fateOfProviderError = (error: ProviderCallError): Fate => {
  switch (error._tag) {
    case "ProviderNetworkError":
    case "ProviderResponseError": {
      return "interruption";
    }
    case "ProviderHttpError": {
      if (error.status >= 500 || error.status === 429) {
        return "interruption";
      }
      if (error.status === 401 || error.status === 403) {
        return "fatal";
      }
      return "failure";
    }
    default: {
      const _exhaustive: never = error;
      return "interruption";
    }
  }
};

/** Map a `ProviderCallError` into a `HandlerError` with a phase-prefixed reason. */
export const providerHandlerError =
  (prefix: string) =>
  (error: ProviderCallError): HandlerError =>
    new HandlerError({
      reason: `${prefix}: ${describeProviderError(error)}`,
      fate: fateOfProviderError(error),
      errorType: error._tag,
    });
