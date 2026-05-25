/**
 * Pipeline/errors.ts — the failure modes the pipeline routes on.
 *
 * `HandlerError` is the only error a non-`fetch_queue` handler may fail with.
 * `step` catches it and rebuilds a `failed` state from `current`.
 * Handlers no longer spread `{issue, branch, worktree, pullRequestIid}`.
 *
 * `UnexpectedVerdictError` covers verdicts outside the set expected for a phase.
 * Keeping the `_tag` lets `describePhaseRunError` format it without string parsing.
 */
import { Data } from "effect";
import type { Phase } from "../config";
import type { PhaseError } from "../session/errors";
import { describePhaseError } from "../session/errors";
import type { VerdictToken } from "../session/verdict";

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

/** A phase session returned a verdict outside the expected set for that phase. */
export class UnexpectedVerdictError extends Data.TaggedError("UnexpectedVerdictError")<{
  readonly phase: Phase;
  readonly verdict: VerdictToken;
  readonly expected: readonly VerdictToken[];
}> {}

/** The complete error channel of `runPhase`: session failures plus unexpected verdicts. */
export type PhaseRunError = PhaseError | UnexpectedVerdictError;

/**
 * A one-line, human-readable description of any phase-running failure.
 *
 * Discrimination is by `_tag` so adding a new `PhaseError` variant routes to
 * `describePhaseError` automatically (its own exhaustive switch covers it).
 */
export const describePhaseRunError = (error: PhaseRunError): string =>
  error._tag === "UnexpectedVerdictError"
    ? `unexpected verdict ${error.verdict} (expected: ${error.expected.join(", ")})`
    : describePhaseError(error);
