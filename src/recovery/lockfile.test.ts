/**
 * Lockfile.test.ts — the PID liveness lock round-trip (ADR 0004).
 *
 * Writes lock dirs under the real RUNS_DIR (cleaned up after), so `scanClaims`
 * sees them. Asserts only membership of this suite's unique iids — never the
 * whole set — so a developer's real `~/.afk-runs` runs don't make it flaky.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RUNS_DIR } from "../config";
import { LOCK_FILENAME, scanClaims, writeLock } from "./lockfile";

const LIVE_IID = 8_880_001;
const DEAD_IID = 8_880_002;
const liveDir = join(RUNS_DIR, "kirby-locktest-live");
const deadDir = join(RUNS_DIR, "kirby-locktest-dead");

afterEach(async () => {
  await rm(liveDir, { recursive: true, force: true });
  await rm(deadDir, { recursive: true, force: true });
});

describe("scanClaims", () => {
  test("a lock held by this live process lands in `live`, not `dead`", async () => {
    await Effect.runPromise(writeLock(liveDir, LIVE_IID));
    const { live, dead } = await Effect.runPromise(scanClaims);
    expect(live.has(LIVE_IID)).toBe(true);
    expect(dead.has(LIVE_IID)).toBe(false);
  });

  test("a lock whose pid/start-time no longer matches lands in `dead`", async () => {
    await mkdir(deadDir, { recursive: true });
    // A pid that is alive but with a deliberately wrong start time → not our run.
    const stale = { pid: process.pid, startTime: "Thu Jan  1 00:00:00 1970", claimedIssueIid: DEAD_IID };
    await writeFile(join(deadDir, LOCK_FILENAME), JSON.stringify(stale));
    const { live, dead } = await Effect.runPromise(scanClaims);
    expect(dead.has(DEAD_IID)).toBe(true);
    expect(live.has(DEAD_IID)).toBe(false);
  });
});
