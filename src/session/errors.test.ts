/**
 * Session/errors.test.ts — `describePhaseError` formatting for each variant.
 *
 * The describe function is the seam every `failed` reason string flows through.
 * One test per variant pins the human-readable form.
 */
import { describe, expect, it } from "bun:test";
import {
  BudgetExhausted,
  NoVerdict,
  PromptError,
  SessionTimedOut,
  TmuxError,
  UnexpectedVerdictError,
  WorkspaceError,
  describePhaseError,
} from "./errors";

describe("describePhaseError", () => {
  it("formats UnexpectedVerdictError with the verdict + expected list", () => {
    const error = new UnexpectedVerdictError({
      phase: "review",
      verdict: "BLOCKER_SUSPECTED",
      expected: ["REVIEW_DONE"],
    });
    expect(describePhaseError(error)).toBe(
      "unexpected verdict BLOCKER_SUSPECTED (expected: REVIEW_DONE)",
    );
  });

  it("formats TmuxError with the step plus a truncated stderr", () => {
    const error = new TmuxError({ step: "new-session", stderr: "boom" });
    expect(describePhaseError(error)).toBe("tmux new-session failed: boom");
  });

  it("formats PromptError with the reason", () => {
    const error = new PromptError({ phase: "review", reason: "template missing" });
    expect(describePhaseError(error)).toBe("prompt: template missing");
  });

  it("formats WorkspaceError with the operation plus reason", () => {
    const error = new WorkspaceError({
      phase: "implementation",
      operation: "write the prompt file",
      reason: "EACCES",
    });
    expect(describePhaseError(error)).toBe("write the prompt file failed: EACCES");
  });

  it("formats BudgetExhausted with the phase that could not start", () => {
    const error = new BudgetExhausted({ phase: "evaluate" });
    expect(describePhaseError(error)).toBe(
      "per-issue budget exhausted before the evaluate phase could start",
    );
  });

  it("formats SessionTimedOut with a rounded elapsed-seconds count", () => {
    const error = new SessionTimedOut({ phase: "review", elapsedMs: 65_400 });
    expect(describePhaseError(error)).toBe("timed out after 65s without a verdict");
  });

  it("formats NoVerdict with the captured tail", () => {
    const error = new NoVerdict({ phase: "fix", captured: "all good" });
    expect(describePhaseError(error)).toBe(
      "stopped without a clean verdict (got: all good)",
    );
  });
});
