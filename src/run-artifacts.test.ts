/**
 * Run-artifacts.test.ts — RunArtifacts is deterministic under controlled
 * Clock + Random.
 *
 * The point of the service refactor was to make `dir` reproducible in tests
 * (was previously `new Date()` + `Math.random()` at module top-level). Two
 * runs with the same seed and clock must produce the same paths.
 */
import { describe, expect, it } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { Effect, Random, TestClock, TestContext } from "effect";
import { buildRunArtifacts } from "./run-artifacts";

const buildAt = (clockMs: number, seed: number) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(clockMs);
    return yield* buildRunArtifacts;
  }).pipe(Effect.withRandom(Random.make(seed)), Effect.provide(TestContext.TestContext));

const fixedRef = { issueIid: 1, phase: "run_impl", iteration: 0 } as const;
/** ISO-8601 timestamp followed by a hex suffix — colons/dots replaced. */
const DIR_PATTERN = /\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}/;

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

  it("logEvent swallows write failures when the dir does not exist", async () => {
    // buildRunArtifacts does NOT mkdir its own dir — appendFile will fail with ENOENT.
    // Effect.ignore must swallow that failure so a run never aborts on logging.
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);
      const artifacts = yield* buildRunArtifacts;
      yield* artifacts.logEvent({ event: "test" });
      return true;
    }).pipe(Effect.withRandom(Random.make(7)), Effect.provide(TestContext.TestContext));
    const completed = await Effect.runPromise(program);
    expect(completed).toBe(true);
  });

  it("logEvent writes an ISO-8601 `at` timestamp driven by Clock", async () => {
    const clockMs = 1_700_000_000_000;
    // Dir name is deterministic (TestClock + fixed seed); acquireUseRelease
    // guarantees the dir is cleaned even if the assertion below throws.
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(clockMs);
      const artifacts = yield* buildRunArtifacts;
      return yield* Effect.acquireUseRelease(
        Effect.tryPromise(async () => {
          await rm(artifacts.dir, { recursive: true, force: true });
          await mkdir(artifacts.dir, { recursive: true });
          return artifacts;
        }),
        (live) =>
          Effect.gen(function* () {
            yield* live.logEvent({ event: "ping" });
            return yield* Effect.tryPromise(() => readFile(live.logPath, "utf8"));
          }),
        (live) =>
          Effect.tryPromise(() => rm(live.dir, { recursive: true, force: true })).pipe(
            Effect.ignore,
          ),
      );
    }).pipe(Effect.withRandom(Random.make(11)), Effect.provide(TestContext.TestContext));
    const content = await Effect.runPromise(program);
    const parsed: unknown = JSON.parse(content.trim());
    expect(parsed).toMatchObject({ at: new Date(clockMs).toISOString(), event: "ping" });
  });
});
