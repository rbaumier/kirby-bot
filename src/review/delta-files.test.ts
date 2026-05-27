import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { getChangedFilesSince } from "./delta-files";

/** Create a fresh git repo with two commits; return worktree path + both SHAs. */
const buildRepo = async (): Promise<{ worktree: string; firstSha: string; secondSha: string }> => {
  const worktree = mkdtempSync(join(tmpdir(), "kirby-delta-"));
  await $`git -C ${worktree} init -q -b main`;
  await $`git -C ${worktree} config user.email test@test`;
  await $`git -C ${worktree} config user.name test`;
  writeFileSync(join(worktree, "a.ts"), "a");
  await $`git -C ${worktree} add a.ts`;
  await $`git -C ${worktree} commit -q -m c1`;
  const rawFirst = await $`git -C ${worktree} rev-parse HEAD`.text();
  const firstSha = rawFirst.trim();
  writeFileSync(join(worktree, "b.ts"), "b");
  writeFileSync(join(worktree, "a.ts"), "a updated");
  await $`git -C ${worktree} add a.ts b.ts`;
  await $`git -C ${worktree} commit -q -m c2`;
  const rawSecond = await $`git -C ${worktree} rev-parse HEAD`.text();
  const secondSha = rawSecond.trim();
  return { worktree, firstSha, secondSha };
};

describe("getChangedFilesSince", () => {
  test("returns files touched since the previous commit", async () => {
    const { worktree, firstSha } = await buildRepo();
    const result = await Effect.runPromise(getChangedFilesSince({ worktree, lastSha: firstSha }));
    expect(result).not.toBeNull();
    expect(new Set(result)).toEqual(new Set(["a.ts", "b.ts"]));
  });

  test("returns [] when lastSha === HEAD", async () => {
    const { worktree, secondSha } = await buildRepo();
    const result = await Effect.runPromise(getChangedFilesSince({ worktree, lastSha: secondSha }));
    expect(result).toEqual([]);
  });

  test("returns null when lastSha is not an ancestor of HEAD", async () => {
    const { worktree, firstSha } = await buildRepo();
    // Reset HEAD back to firstSha, then commit a divergent change so the
    // original second SHA is now an orphan ancestor of nothing.
    await $`git -C ${worktree} reset --hard ${firstSha} -q`;
    writeFileSync(join(worktree, "c.ts"), "c");
    await $`git -C ${worktree} add c.ts`;
    await $`git -C ${worktree} commit -q -m c3`;
    // The original second SHA (no longer on the branch) is unknown to HEAD.
    // Use any short-but-valid SHA that's not an ancestor — easier: pick a known
    // synthetic SHA from another branch. We commit on a side branch and use its tip.
    await $`git -C ${worktree} checkout -q -b side ${firstSha}`;
    writeFileSync(join(worktree, "d.ts"), "d");
    await $`git -C ${worktree} add d.ts`;
    await $`git -C ${worktree} commit -q -m c-side`;
    const rawSide = await $`git -C ${worktree} rev-parse HEAD`.text();
    const sideSha = rawSide.trim();
    await $`git -C ${worktree} checkout -q main`;
    const result = await Effect.runPromise(getChangedFilesSince({ worktree, lastSha: sideSha }));
    expect(result).toBeNull();
  });
});
