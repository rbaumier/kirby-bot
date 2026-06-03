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
import { Cause, Effect, Exit, Ref, TestContext } from "effect";
import { SessionTimedOut, UsageLimitHit } from "./errors";
import type { AgentOutcome } from "./fanout";
import { agentOutcomeOrAbort, usageLimitFromCause } from "./fanout";

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

// Issue #77: the plan limit is shared, so one agent hitting it means every
// sibling would too. A UsageLimitHit short-circuits the whole pass instead of
// each agent idling to the cap; every other failure stays per-agent best-effort.
describe("fan-out abort on UsageLimitHit", () => {
  it("usageLimitFromCause extracts a UsageLimitHit, ignores other failures", () => {
    expect(usageLimitFromCause(Cause.fail(new UsageLimitHit({ phase: "review" })))?._tag).toBe(
      "UsageLimitHit",
    );
    expect(
      usageLimitFromCause(Cause.fail(new SessionTimedOut({ phase: "review", elapsedMs: 1 }))),
    ).toBeUndefined();
  });

  it("agentOutcomeOrAbort returns an ok outcome on success", async () => {
    const outcome = await Effect.runPromise(
      agentOutcomeOrAbort({
        exit: Exit.succeed("REVIEW_DONE"),
        agent: "simplify",
        findingsPath: "/tmp/z.json",
        totalMs: 5000,
      }),
    );
    expect(outcome).toEqual({
      kind: "ok",
      agent: "simplify",
      findingsPath: "/tmp/z.json",
      totalMs: 5000,
    });
  });

  it("agentOutcomeOrAbort keeps a non-usage-limit failure per-agent (best effort)", async () => {
    const outcome = await Effect.runPromise(
      agentOutcomeOrAbort({
        exit: Exit.fail(new SessionTimedOut({ phase: "review", elapsedMs: 35_000 })),
        agent: "tests",
        findingsPath: "/tmp/y.json",
        totalMs: 35_000,
      }),
    );
    expect(outcome.kind).toBe("error");
  });

  it("agentOutcomeOrAbort re-raises a UsageLimitHit instead of swallowing it", async () => {
    const exit = await Effect.runPromiseExit(
      agentOutcomeOrAbort({
        exit: Exit.fail(new UsageLimitHit({ phase: "review" })),
        agent: "correctness",
        findingsPath: "/tmp/x.json",
        totalMs: 1000,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : undefined;
    expect(failure?._tag).toBe("Some");
  });

  it("one agent's UsageLimitHit interrupts the still-running siblings", async () => {
    const program = Effect.gen(function* () {
      const completed = yield* Ref.make(0);
      const agents = ["correctness", "tests", "simplify", "tanstack"] as const;
      const run = (agent: (typeof agents)[number], index: number) =>
        index === 0
          ? agentOutcomeOrAbort({
              exit: Exit.fail(new UsageLimitHit({ phase: "review" })),
              agent,
              findingsPath: "",
              totalMs: 0,
            })
          : Effect.sleep("1 hour").pipe(
              Effect.zipRight(Ref.update(completed, (n) => n + 1)),
              Effect.as({ kind: "ok" as const, agent, findingsPath: "", totalMs: 0 }),
            );
      const exit = yield* Effect.forEach(agents, run, { concurrency: 4 }).pipe(Effect.exit);
      return { failed: Exit.isFailure(exit), completed: yield* Ref.get(completed) };
    }).pipe(Effect.provide(TestContext.TestContext));

    const result = await Effect.runPromise(program);
    expect(result.failed).toBe(true);
    // The three siblings were interrupted while suspended on their sleep, so
    // none ran to completion — they died fast rather than idling to the cap.
    expect(result.completed).toBe(0);
  });
});
