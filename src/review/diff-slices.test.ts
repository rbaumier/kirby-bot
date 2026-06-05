import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { writeFullDiff } from "./diff-slices";

/** Init an empty git repo on `main`; return its path. */
const initRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "kirby-diffslice-"));
  await $`git -C ${dir} init -q -b main`;
  await $`git -C ${dir} config user.email test@test`;
  await $`git -C ${dir} config user.name test`;
  return dir;
};

/**
 * Repo with a non-empty `main...HEAD` delta: a commit on `main`, then a
 * divergent commit on a `feature` branch. Mirrors an issue worktree.
 */
const repoWithDelta = async (): Promise<string> => {
  const dir = await initRepo();
  writeFileSync(join(dir, "a.ts"), "a\n");
  await $`git -C ${dir} add a.ts`;
  await $`git -C ${dir} commit -q -m c1`;
  await $`git -C ${dir} checkout -q -b feature`;
  writeFileSync(join(dir, "a.ts"), "a changed\n");
  await $`git -C ${dir} add a.ts`;
  await $`git -C ${dir} commit -q -m c2`;
  return dir;
};

/** Repo with an EMPTY `main...HEAD` delta (HEAD === main). Stands in for the
 *  orchestrator's process cwd — a different repo than the issue worktree. */
const repoNoDelta = async (): Promise<string> => {
  const dir = await initRepo();
  writeFileSync(join(dir, "x.ts"), "x\n");
  await $`git -C ${dir} add x.ts`;
  await $`git -C ${dir} commit -q -m c1`;
  return dir;
};

/**
 * Regression guard for the empty-diff bug: `writeGitDiff` must diff inside the
 * issue worktree (`git -C <worktree> diff`), not the orchestrator's process
 * cwd. The orchestrator juggles several worktrees at once, so its cwd is never
 * the issue worktree — before the fix, the diff was taken against the wrong
 * repo and silently came back empty, so every fan-out agent received a 0-byte
 * `{diff_file}` and returned "No findings.".
 *
 * The test runs from a *different* repo's cwd on purpose: a correct
 * implementation still produces the worktree's patch; the old bug would yield
 * an empty one.
 */
describe("writeFullDiff — diffs inside the issue worktree, not the process cwd", () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  test("emits the worktree's main...HEAD patch even when the process cwd is another repo", async () => {
    const worktree = await repoWithDelta();
    const elsewhere = await repoNoDelta();

    // Sanity: the worktree genuinely has a non-empty `main...HEAD` delta.
    const realDelta = await $`git -C ${worktree} diff main...HEAD`.text();
    expect(realDelta.length).toBeGreaterThan(0);

    // The orchestrator runs outside the issue worktree — the diff must still
    // come from the worktree, not this (empty-delta) cwd.
    process.chdir(elsewhere);

    const outPath = join(worktree, "out.patch");
    await Effect.runPromise(writeFullDiff({ worktree, defaultBranch: "main", outPath }));

    const written = readFileSync(outPath, "utf8");
    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain("a changed");
  });
});
