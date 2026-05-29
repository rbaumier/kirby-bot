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
import { NoVerdict, SessionTimedOut } from "./errors";
import { runPhaseSession } from "./phase";
import { pollSentinel, recoverNoVerdictOnce } from "./phase-primitives";
import type { VerdictToken } from "./verdict";

const ABSENT_SENTINEL = "/kirby-bot-test-no-such-sentinel-xyz.flag";

describe("pollSentinel under a virtual clock", () => {
  it("fails SessionTimedOut when the clock passes the timeout with no sentinel", async () => {
    const timeoutMs = SENTINEL_POLL_MS * 3;
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        pollSentinel({ phase: "implementation", sentinel: ABSENT_SENTINEL, startedAt: 0, timeoutMs }),
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
          phase: "implementation",
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

// Issue #26: a session that stops without a clean verdict gets exactly one
// re-prompt before the failure becomes terminal — bounded, and only re-prompts
// when the first poll actually missed.
describe("recoverNoVerdictOnce", () => {
  const makePoll = (outcomes: readonly (VerdictToken | "no-verdict")[]) => {
    let i = 0;
    return Effect.suspend((): Effect.Effect<VerdictToken, NoVerdict> => {
      const outcome = outcomes[Math.min(i, outcomes.length - 1)] ?? "no-verdict";
      i += 1;
      return outcome === "no-verdict"
        ? Effect.fail(new NoVerdict({ phase: "fix", captured: "no verdict line" }))
        : Effect.succeed(outcome);
    });
  };

  it("re-prompts once and returns the verdict from the second poll", async () => {
    let reprompts = 0;
    const reprompt = Effect.sync(() => {
      reprompts += 1;
    });
    const verdict = await Effect.runPromise(
      recoverNoVerdictOnce(makePoll(["no-verdict", "FIX_DONE"]), reprompt),
    );
    expect(verdict).toBe("FIX_DONE");
    expect(reprompts).toBe(1);
  });

  it("does not re-prompt when the first poll already has a verdict", async () => {
    let reprompts = 0;
    const reprompt = Effect.sync(() => {
      reprompts += 1;
    });
    const verdict = await Effect.runPromise(
      recoverNoVerdictOnce(makePoll(["READY_FOR_REVIEW"]), reprompt),
    );
    expect(verdict).toBe("READY_FOR_REVIEW");
    expect(reprompts).toBe(0);
  });

  it("stays terminal after a single re-prompt: a second miss surfaces NoVerdict", async () => {
    let reprompts = 0;
    const reprompt = Effect.sync(() => {
      reprompts += 1;
    });
    const error = await Effect.runPromise(
      recoverNoVerdictOnce(makePoll(["no-verdict", "no-verdict"]), reprompt).pipe(Effect.flip),
    );
    expect(error._tag).toBe("NoVerdict");
    expect(reprompts).toBe(1);
  });

  it("propagates a timeout while waiting after the re-prompt", async () => {
    const reprompt = Effect.void;
    let i = 0;
    const poll = Effect.suspend((): Effect.Effect<VerdictToken, NoVerdict | SessionTimedOut> => {
      i += 1;
      return i === 1
        ? Effect.fail(new NoVerdict({ phase: "fix", captured: "" }))
        : Effect.fail(new SessionTimedOut({ phase: "fix", elapsedMs: 1_800_000 }));
    });
    const error = await Effect.runPromise(recoverNoVerdictOnce(poll, reprompt).pipe(Effect.flip));
    expect(error._tag).toBe("SessionTimedOut");
  });
});
