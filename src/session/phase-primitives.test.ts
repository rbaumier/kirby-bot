/**
 * Phase-primitives.test.ts — the session timing primitives read the ambient
 * `Clock`, so a virtual clock drives both the poll sleeps and the elapsed-time
 * predicate together. Before the Clock migration these used `Date.now()` and a
 * TestClock could only move half the system (see issue #23).
 */
import { describe, expect, it } from "bun:test";
import { Effect, Fiber, Random, TestClock, TestContext } from "effect";
import { SENTINEL_POLL_MS } from "../config";
import { buildRunArtifacts, RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "./phase";
import { pollSentinel } from "./phase-primitives";

const ABSENT_SENTINEL = "/kirby-bot-test-no-such-sentinel-xyz.flag";

describe("pollSentinel under a virtual clock", () => {
  it("fails SessionTimedOut once the clock passes the timeout and the sentinel never appears", async () => {
    const timeoutMs = SENTINEL_POLL_MS * 3;
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        pollSentinel({ phase: "run_impl", sentinel: ABSENT_SENTINEL, startedAt: 0, timeoutMs }),
      );
      // One push past the budget: every queued poll sleep fires in sequence
      // until the elapsed-time predicate trips. A real clock could not do this
      // deterministically — this is the whole point of the Clock migration.
      yield* TestClock.adjust(`${timeoutMs + SENTINEL_POLL_MS} millis`);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.flip, Effect.provide(TestContext.TestContext));

    const error = await Effect.runPromise(program);
    expect(error._tag).toBe("SessionTimedOut");
  });
});

describe("runPhaseSession budget guard under a virtual clock", () => {
  it("fails BudgetExhausted when the deadline is already spent", async () => {
    const clockMs = 1_700_000_000_000;
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(clockMs);
      const artifacts = yield* buildRunArtifacts;
      return yield* runPhaseSession(
        {
          phase: "run_impl",
          issueIid: 1,
          worktree: "/tmp/kirby-test-worktree",
          iteration: 0,
          deadline: clockMs, // no budget left: deadline - now === 0
          replacements: {},
        },
        ["READY_FOR_REVIEW"],
      ).pipe(Effect.provideService(RunArtifacts, artifacts), Effect.flip);
    }).pipe(Effect.withRandom(Random.make(1)), Effect.provide(TestContext.TestContext));

    const error = await Effect.runPromise(program);
    expect(error._tag).toBe("BudgetExhausted");
  });
});
