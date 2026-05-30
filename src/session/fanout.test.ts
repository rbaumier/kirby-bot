/**
 * Fanout.test.ts — unit tests for the okCount / totalCount fields added to
 * FanOutResult (issue #50: abort review iteration when the whole fan-out goes
 * sterile).
 *
 * runFanOutPhase requires tmux + git infrastructure, so we test the counting
 * logic directly through the AgentOutcome type: the only invariant is that
 * `okCount` counts `kind === "ok"` entries and `totalCount` mirrors the full
 * outcomes array length.
 */
import { describe, expect, it } from "bun:test";
import type { AgentOutcome } from "./fanout";

/** Mirror of the aggregation runFanOutPhase computes internally. */
const aggregate = (outcomes: AgentOutcome[]) => ({
  okCount: outcomes.filter((o) => o.kind === "ok").length,
  totalCount: outcomes.length,
});

describe("FanOutResult okCount / totalCount", () => {
  it("all-error outcomes yield okCount === 0 (sterile fan-out)", () => {
    const outcomes: AgentOutcome[] = [
      { kind: "error", agent: "correctness", reason: "SessionTimedOut", totalMs: 35_000 },
      { kind: "error", agent: "tests", reason: "verdict_reprompt then timed out", totalMs: 35_000 },
    ];
    const { okCount, totalCount } = aggregate(outcomes);
    expect(okCount).toBe(0);
    expect(totalCount).toBe(2);
  });

  it("mixed outcomes count only 'ok' entries toward okCount", () => {
    const outcomes: AgentOutcome[] = [
      { kind: "ok", agent: "correctness", findingsPath: "/tmp/findings.json", totalMs: 5_000 },
      { kind: "error", agent: "tests", reason: "timed out", totalMs: 35_000 },
    ];
    const { okCount, totalCount } = aggregate(outcomes);
    expect(okCount).toBe(1);
    expect(totalCount).toBe(2);
  });

  it("all-ok outcomes yield okCount === totalCount", () => {
    const outcomes: AgentOutcome[] = [
      { kind: "ok", agent: "correctness", findingsPath: "/tmp/a.json", totalMs: 3_000 },
      { kind: "ok", agent: "tests", findingsPath: "/tmp/b.json", totalMs: 4_000 },
    ];
    const { okCount, totalCount } = aggregate(outcomes);
    expect(okCount).toBe(2);
    expect(totalCount).toBe(2);
  });

  it("empty outcomes list yields okCount === 0 and totalCount === 0", () => {
    const { okCount, totalCount } = aggregate([]);
    expect(okCount).toBe(0);
    expect(totalCount).toBe(0);
  });
});
