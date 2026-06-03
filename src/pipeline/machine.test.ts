/**
 * Pipeline/machine.test.ts — the usage-limit back-off (#78).
 *
 * Two layers, both deterministic:
 *  - `usageLimitBackoffMs` is pure (a `now` is passed in): it turns a captured
 *    reset substring into a sleep duration — until reset + margin, clamped to a
 *    floor, or a fixed fallback when unparseable.
 *  - `backOffForUsageLimit` runs that under a virtual `Clock`, so the sleep is
 *    asserted exactly (the codebase drives time via Effect `Clock`, see
 *    `pollSentinel`). It also emits the `usage_limit_backoff` / `_resume` pair
 *    that keeps a paused run from reading as crashed.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Fiber, Option, TestClock, TestContext } from "effect";
import {
  USAGE_LIMIT_BACKOFF_FALLBACK_MS,
  USAGE_LIMIT_BACKOFF_MARGIN_MS,
  USAGE_LIMIT_BACKOFF_MIN_MS,
} from "../config";
import { RunArtifacts } from "../run-artifacts";
import type { RunArtifactsShape } from "../run-artifacts";
import { backOffForUsageLimit, usageLimitBackoffMs } from "./machine";

const SONNET = "You've hit your Sonnet limit · resets Jun 1 at 2am (Europe/Paris)";

/** A RunArtifacts whose only live method records the events the back-off logs. */
const recordingArtifacts = (events: Array<Record<string, unknown>>): RunArtifactsShape => ({
  dir: "/tmp/test-run-dir",
  runId: "test-run-dir",
  logPath: "/tmp/test-run-dir/run.jsonl",
  sentinelPath: () => "/tmp/test-run-dir/sentinel.flag",
  tmuxLogPath: () => "/tmp/test-run-dir/tmux.log",
  promptFilePath: () => "/tmp/test-run-dir/prompt.md",
  findingsPath: () => "/tmp/test-run-dir/findings.json",
  triagePath: () => "/tmp/test-run-dir/triage.json",
  sessionName: () => "test-session",
  logEvent: (event) =>
    Effect.sync(() => {
      events.push(event as Record<string, unknown>);
    }),
});

describe("usageLimitBackoffMs (pure)", () => {
  it("sleeps until the parsed reset plus the margin", () => {
    // now: Jun 1 2026 01:00 Paris (CEST) == May 31 2026 23:00 UTC; reset 1h ahead.
    const now = Date.UTC(2026, 4, 31, 23, 0, 0);
    const resetInstant = Date.UTC(2026, 5, 1, 0, 0, 0); // Jun 1 02:00 Paris == 00:00 UTC
    const result = usageLimitBackoffMs(SONNET, now);
    expect(result.resetInstant).toBe(resetInstant);
    expect(result.sleepMs).toBe(resetInstant + USAGE_LIMIT_BACKOFF_MARGIN_MS - now);
  });

  it("falls back to the fixed interval when the reset is unparseable", () => {
    expect(usageLimitBackoffMs("hit your limit, try later", 0)).toEqual({
      sleepMs: USAGE_LIMIT_BACKOFF_FALLBACK_MS,
      resetInstant: null,
    });
  });

  it("clamps to the floor when the reset is already in the past (clock skew)", () => {
    // now: Jun 1 2026 05:00 UTC — hours past the Jun 1 00:00 UTC reset.
    const now = Date.UTC(2026, 5, 1, 5, 0, 0);
    const result = usageLimitBackoffMs(SONNET, now);
    expect(result.resetInstant).toBe(Date.UTC(2026, 5, 1, 0, 0, 0));
    expect(result.sleepMs).toBe(USAGE_LIMIT_BACKOFF_MIN_MS);
  });
});

describe("backOffForUsageLimit (virtual clock)", () => {
  it("pauses until the reset + margin, then resumes, logging both events", async () => {
    const baseNow = Date.UTC(2026, 4, 31, 23, 0, 0);
    const { sleepMs, resetInstant } = usageLimitBackoffMs(SONNET, baseNow);
    const events: Array<Record<string, unknown>> = [];

    const pending = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(baseNow);
        const fiber = yield* Effect.fork(backOffForUsageLimit(SONNET));
        // One tick short of the computed sleep: the back-off is still waiting.
        yield* TestClock.adjust(`${sleepMs - 1} millis`);
        const stillWaiting = yield* Fiber.poll(fiber);
        // The final tick releases it.
        yield* TestClock.adjust("1 millis");
        yield* Fiber.join(fiber);
        return stillWaiting;
      }).pipe(Effect.provideService(RunArtifacts, recordingArtifacts(events)), Effect.provide(TestContext.TestContext)),
    );

    expect(Option.isNone(pending)).toBe(true);
    expect(events.map((e) => e.event)).toEqual(["usage_limit_backoff", "usage_limit_resume"]);
    expect(events[0]).toMatchObject({ parsed: true, sleepMs, resetInstant, resumeAt: baseNow + sleepMs });
  });

  it("uses the fixed fallback and flags the unparseable reset in the event", async () => {
    const events: Array<Record<string, unknown>> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(backOffForUsageLimit("unrecognized phrasing"));
        yield* TestClock.adjust(`${USAGE_LIMIT_BACKOFF_FALLBACK_MS} millis`);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provideService(RunArtifacts, recordingArtifacts(events)), Effect.provide(TestContext.TestContext)),
    );

    expect(events.map((e) => e.event)).toEqual(["usage_limit_backoff", "usage_limit_resume"]);
    expect(events[0]).toMatchObject({
      parsed: false,
      resetInstant: null,
      sleepMs: USAGE_LIMIT_BACKOFF_FALLBACK_MS,
    });
  });
});
