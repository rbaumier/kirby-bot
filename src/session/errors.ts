/**
 * Session/errors.ts — the failure modes of running one phase session.
 *
 * See `provider/types.ts` for the project-wide error policy.
 * One tagged error per distinct failure mode, grouped by boundary.
 * A union alias and a `describe` function let a handler turn any
 * of them into a `failed` state's reason string.
 *
 * The seven modes below are genuinely distinct. An operator treats
 * a timeout, a missing verdict, and a broken tmux very differently.
 * Hence seven types, not one `{ reason: string }`.
 */
import { Data } from "effect";
import type { Phase } from "../config";
import type { Fate } from "../pipeline/errors";
import type { VerdictToken } from "./verdict";

/** A tmux command failed — the session could not be created or driven. */
export class TmuxError extends Data.TaggedError("TmuxError")<{
  readonly step: string;
  readonly stderr: string;
}> {}

/** A phase prompt template was missing, unreadable, or left a placeholder unresolved. */
export class PromptError extends Data.TaggedError("PromptError")<{
  readonly phase: Phase;
  readonly reason: string;
}> {}

/** A filesystem operation in the worktree or run directory failed. */
export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly phase: Phase;
  readonly operation: string;
  readonly reason: string;
}> {}

/** No budget was left to even start the phase. */
export class BudgetExhausted extends Data.TaggedError("BudgetExhausted")<{
  readonly phase: Phase;
}> {}

/** The session ran past its timeout without ever producing a verdict. */
export class SessionTimedOut extends Data.TaggedError("SessionTimedOut")<{
  readonly phase: Phase;
  readonly elapsedMs: number;
}> {}

/**
 * The session hit Claude's usage limit mid-work: the interactive CLI raised its
 * blocking usage-limit dialog, which `--dangerously-skip-permissions` does NOT
 * dismiss, so the session would otherwise idle to the phase cap (issue #77).
 * Detected by {@link paneShowsUsageLimit} during the sentinel poll and failed
 * fast. An exhausted plan limit is not the issue's fault, so this maps to an
 * `interruption` fate — never a stall. `resetText` carries the raw `resets …
 * (tz)` substring when the dialog header was still in the capture; the
 * orchestrator parses it to back off until the limit resets (#78).
 */
export class UsageLimitHit extends Data.TaggedError("UsageLimitHit")<{
  readonly phase: Phase;
  readonly resetText?: string;
}> {}

/** The session stopped, but its final message carried no clean verdict. */
export class NoVerdict extends Data.TaggedError("NoVerdict")<{
  readonly phase: Phase;
  readonly captured: string;
}> {}

/** The session returned a verdict outside the expected set for that phase. */
export class UnexpectedVerdictError extends Data.TaggedError("UnexpectedVerdictError")<{
  readonly phase: Phase;
  readonly verdict: VerdictToken;
  readonly expected: readonly VerdictToken[];
}> {}

/** Every failure running a phase session can produce. */
export type PhaseError =
  | TmuxError
  | PromptError
  | WorkspaceError
  | BudgetExhausted
  | SessionTimedOut
  | UsageLimitHit
  | NoVerdict
  | UnexpectedVerdictError;

/**
 * The fate of a phase-session failure (ADR 0004), by tag — not by reason string.
 *
 * A `SessionTimedOut` / `NoVerdict` / `BudgetExhausted` consumed the session
 * without a verdict → `stall`. An `UnexpectedVerdictError` is a diff-correlated
 * emission glitch that recurs on resume → `stall`. A `TmuxError` / `WorkspaceError`
 * is an environment cut-off, the issue innocent → `interruption`. A `UsageLimitHit`
 * is an exhausted plan limit, not the issue's content → `interruption` (so it
 * resets the consecutive-stall run and never pushes a good issue toward
 * `STALL_CAP`). A `PromptError` is a deploy bug affecting every issue → `fatal`
 * (crash the run).
 */
export const fateOfPhaseError = (error: PhaseError): Fate => {
  switch (error._tag) {
    case "SessionTimedOut":
    case "NoVerdict":
    case "BudgetExhausted":
    case "UnexpectedVerdictError": {
      return "stall";
    }
    case "TmuxError":
    case "WorkspaceError":
    case "UsageLimitHit": {
      return "interruption";
    }
    case "PromptError": {
      return "fatal";
    }
    default: {
      const _exhaustive: never = error;
      return "interruption";
    }
  }
};

const MAX_STDERR_CHARS = 160;
const MS_PER_SECOND = 1000;
const MAX_CAPTURED_CHARS = 120;

/** A one-line, human-readable description of a phase error. */
export const describePhaseError = (error: PhaseError): string => {
  switch (error._tag) {
    case "TmuxError": {
      return `tmux ${error.step} failed: ${error.stderr.slice(0, MAX_STDERR_CHARS)}`;
    }
    case "PromptError": {
      return `prompt: ${error.reason}`;
    }
    case "WorkspaceError": {
      return `${error.operation} failed: ${error.reason}`;
    }
    case "BudgetExhausted": {
      return `per-issue budget exhausted before the ${error.phase} phase could start`;
    }
    case "SessionTimedOut": {
      return `timed out after ${Math.round(error.elapsedMs / MS_PER_SECOND)}s without a verdict`;
    }
    case "UsageLimitHit": {
      return `Claude usage limit hit${error.resetText === undefined ? "" : ` — ${error.resetText}`}`;
    }
    case "NoVerdict": {
      return `stopped without a clean verdict (got: ${error.captured.slice(0, MAX_CAPTURED_CHARS)})`;
    }
    case "UnexpectedVerdictError": {
      return `unexpected verdict ${error.verdict} (expected: ${error.expected.join(", ")})`;
    }
    default: {
      const _exhaustive: never = error;
      return `unknown phase error: ${String(_exhaustive)}`;
    }
  }
};
