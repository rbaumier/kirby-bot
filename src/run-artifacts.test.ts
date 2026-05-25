/**
 * Run-artifacts.test.ts — RunArtifacts is deterministic under controlled
 * Clock + Random.
 *
 * The point of the service refactor was to make `dir` reproducible in tests
 * (was previously `new Date()` + `Math.random()` at module top-level). Two
 * runs with the same seed and clock must produce the same paths.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Random, TestClock, TestContext } from "effect";
import { buildRunArtifacts } from "./run-artifacts";

const buildAt = (clockMs: number, seed: number) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(clockMs);
    return yield* buildRunArtifacts;
  }).pipe(Effect.withRandom(Random.make(seed)), Effect.provide(TestContext.TestContext));

const fixedRef = { issueIid: 1, phase: "run_impl", iteration: 0 } as const;
/** ISO-8601 timestamp followed by a hex suffix — colons/dots replaced. */
const DIR_PATTERN = /\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{1,6}/;

describe("RunArtifacts", () => {
  it("identical Clock + seed → identical dir", async () => {
    const first = await Effect.runPromise(buildAt(1_700_000_000_000, 42));
    const second = await Effect.runPromise(buildAt(1_700_000_000_000, 42));
    expect(first.dir).toBe(second.dir);
  });

  it("different seed → different dir under same Clock", async () => {
    const first = await Effect.runPromise(buildAt(1_700_000_000_000, 1));
    const second = await Effect.runPromise(buildAt(1_700_000_000_000, 2));
    expect(first.dir).not.toBe(second.dir);
  });

  it("different Clock → different dir under same seed", async () => {
    const first = await Effect.runPromise(buildAt(1_700_000_000_000, 42));
    const second = await Effect.runPromise(buildAt(1_700_000_001_000, 42));
    expect(first.dir).not.toBe(second.dir);
  });

  it("dir embeds an ISO-8601 timestamp with colons/dots replaced", async () => {
    const out = await Effect.runPromise(buildAt(1_700_000_000_000, 42));
    expect(out.dir).toMatch(DIR_PATTERN);
  });

  it("logPath roots in dir", async () => {
    const out = await Effect.runPromise(buildAt(1_700_000_000_000, 42));
    expect(out.logPath.startsWith(out.dir)).toBe(true);
  });

  it("phase paths root in dir", async () => {
    const out = await Effect.runPromise(buildAt(1_700_000_000_000, 42));
    expect(out.sentinelPath(fixedRef).startsWith(out.dir)).toBe(true);
    expect(out.tmuxLogPath(fixedRef).startsWith(out.dir)).toBe(true);
    expect(out.promptFilePath(fixedRef).startsWith(out.dir)).toBe(true);
  });

  it("sessionName is independent of dir", async () => {
    const out = await Effect.runPromise(buildAt(1_700_000_000_000, 42));
    expect(out.sessionName({ issueIid: 7, phase: "review", iteration: 2 })).toBe(
      "afk-7-review-2",
    );
  });
});
