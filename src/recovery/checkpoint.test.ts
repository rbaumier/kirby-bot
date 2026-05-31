/**
 * Checkpoint.test.ts — the Phase-resume checkpoint round-trip (#73).
 *
 * Writes under the real STATE_DIR (cleaned up after) with a suite-unique repo
 * name, so a developer's real ~/.afk-state is never touched. Mirrors the
 * lockfile fs test: a write then read returns the checkpoint, a clear forgets
 * it, an absent file reads as null.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { STATE_DIR } from "../config";
import { clearCheckpoint, readCheckpoint, writeCheckpoint } from "./checkpoint";

const REPO = "kirby-checkpoint-test";
const IID = 7_770_001;
const repoDir = join(STATE_DIR, REPO);

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("checkpoint round-trip", () => {
  test("an absent checkpoint reads as null", async () => {
    expect(await run(readCheckpoint(REPO, IID))).toBeNull();
  });

  test("a written checkpoint reads back", async () => {
    await run(writeCheckpoint(REPO, IID, { phase: "evaluate", fixCycles: 1 }));
    expect(await run(readCheckpoint(REPO, IID))).toEqual({ phase: "evaluate", fixCycles: 1 });
  });

  test("last write wins", async () => {
    await run(writeCheckpoint(REPO, IID, { phase: "review", fixCycles: 0 }));
    await run(writeCheckpoint(REPO, IID, { phase: "qa", fixCycles: 2 }));
    expect(await run(readCheckpoint(REPO, IID))).toEqual({ phase: "qa", fixCycles: 2 });
  });

  test("clear forgets one issue, leaving the others", async () => {
    await run(writeCheckpoint(REPO, IID, { phase: "fix", fixCycles: 1 }));
    await run(writeCheckpoint(REPO, IID + 1, { phase: "review", fixCycles: 0 }));
    await run(clearCheckpoint(REPO, IID));
    expect(await run(readCheckpoint(REPO, IID))).toBeNull();
    expect(await run(readCheckpoint(REPO, IID + 1))).toEqual({ phase: "review", fixCycles: 0 });
  });

  test("clearing an absent issue is a no-op", async () => {
    await run(clearCheckpoint(REPO, IID));
    expect(await run(readCheckpoint(REPO, IID))).toBeNull();
  });
});
