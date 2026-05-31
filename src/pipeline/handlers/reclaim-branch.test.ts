import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  dropStaleRemoteAgentBranch,
  reclaimAgentBranch,
  resumableRemoteBranch,
} from "./reclaim-branch";

const BRANCH = "issue-42";

/**
 * Fresh repo with one commit on `main`, plus a synthetic `origin/main`
 * remote-tracking ref pinned to that commit (no real remote needed).
 */
const buildRepo = async (): Promise<string> => {
  const repoDir = mkdtempSync(join(tmpdir(), "kirby-reclaim-"));
  await $`git -C ${repoDir} init -q -b main`;
  await $`git -C ${repoDir} config user.email test@test`;
  await $`git -C ${repoDir} config user.name test`;
  writeFileSync(join(repoDir, "a.ts"), "a");
  await $`git -C ${repoDir} add a.ts`;
  await $`git -C ${repoDir} commit -q -m c1`;
  const headSha = await $`git -C ${repoDir} rev-parse HEAD`.text();
  const mainSha = headSha.trim();
  await $`git -C ${repoDir} update-ref refs/remotes/origin/main ${mainSha}`;
  return repoDir;
};

const branchExists = async (repoDir: string): Promise<boolean> => {
  const probe = await $`git -C ${repoDir} show-ref --verify --quiet refs/heads/${BRANCH}`.nothrow();
  return probe.exitCode === 0;
};

describe("reclaimAgentBranch", () => {
  test("no-op when the branch does not exist", async () => {
    const repoDir = await buildRepo();
    await Effect.runPromise(reclaimAgentBranch({ repoDir, branch: BRANCH, defaultBranch: "main" }));
    const exists = await branchExists(repoDir);
    expect(exists).toBe(false);
  });

  test("deletes a branch whose tip is contained in origin/main", async () => {
    const repoDir = await buildRepo();
    await $`git -C ${repoDir} branch ${BRANCH} main`;
    const before = await branchExists(repoDir);
    expect(before).toBe(true);

    await Effect.runPromise(reclaimAgentBranch({ repoDir, branch: BRANCH, defaultBranch: "main" }));
    const after = await branchExists(repoDir);
    expect(after).toBe(false);
  });

  test("refuses (fails) when the branch has work not in origin/main", async () => {
    const repoDir = await buildRepo();
    await $`git -C ${repoDir} checkout -q -b ${BRANCH}`;
    writeFileSync(join(repoDir, "b.ts"), "b");
    await $`git -C ${repoDir} add b.ts`;
    await $`git -C ${repoDir} commit -q -m unmerged`;
    await $`git -C ${repoDir} checkout -q main`;

    const error = await Effect.runPromise(
      Effect.flip(reclaimAgentBranch({ repoDir, branch: BRANCH, defaultBranch: "main" })),
    );
    expect(error._tag).toBe("HandlerError");
    expect(error.reason).toContain("refusing to delete");
    // The branch — and its unmerged commit — survive.
    const survived = await branchExists(repoDir);
    expect(survived).toBe(true);
  });
});

/**
 * Bare `origin` plus a working clone with `main` pushed. No agent branch yet —
 * each test pushes the stale remote branch it needs.
 */
const buildClonedRepo = async (): Promise<string> => {
  const origin = mkdtempSync(join(tmpdir(), "kirby-drop-origin-"));
  await $`git -C ${origin} init -q --bare -b main`;

  const work = mkdtempSync(join(tmpdir(), "kirby-drop-work-"));
  await $`git -C ${work} init -q -b main`;
  await $`git -C ${work} config user.email test@test`;
  await $`git -C ${work} config user.name test`;
  await $`git -C ${work} remote add origin ${origin}`;
  writeFileSync(join(work, "a.ts"), "base\n");
  await $`git -C ${work} add a.ts`;
  await $`git -C ${work} commit -q -m base`;
  await $`git -C ${work} push -q -u origin main`;
  return work;
};

const remoteBranchExists = async (repoDir: string): Promise<boolean> => {
  const probe = await $`git -C ${repoDir} ls-remote --exit-code --heads origin ${BRANCH}`.nothrow();
  return probe.exitCode === 0;
};

describe("resumableRemoteBranch", () => {
  test("false when origin/<branch> does not exist", async () => {
    const repoDir = await buildClonedRepo();
    const resumable = await Effect.runPromise(
      resumableRemoteBranch({ repoDir, branch: BRANCH, defaultBranch: "main" }),
    );
    expect(resumable).toBe(false);
  });

  test("false when origin/<branch> exists but is not ahead of origin/main", async () => {
    const repoDir = await buildClonedRepo();
    // Push the branch at main's tip — present on origin, zero commits ahead.
    await $`git -C ${repoDir} checkout -q -b ${BRANCH} main`;
    await $`git -C ${repoDir} push -q -u origin ${BRANCH}`;
    await $`git -C ${repoDir} fetch -q origin ${BRANCH}`;

    const resumable = await Effect.runPromise(
      resumableRemoteBranch({ repoDir, branch: BRANCH, defaultBranch: "main" }),
    );
    expect(resumable).toBe(false);
  });

  test("true when origin/<branch> holds commits beyond origin/main (resumable work)", async () => {
    const repoDir = await buildClonedRepo();
    await $`git -C ${repoDir} checkout -q -b ${BRANCH}`;
    writeFileSync(join(repoDir, "wip.ts"), "partial work\n");
    await $`git -C ${repoDir} add wip.ts`;
    await $`git -C ${repoDir} commit -q -m wip`;
    await $`git -C ${repoDir} push -q -u origin ${BRANCH}`;
    await $`git -C ${repoDir} fetch -q origin ${BRANCH}`;

    const resumable = await Effect.runPromise(
      resumableRemoteBranch({ repoDir, branch: BRANCH, defaultBranch: "main" }),
    );
    expect(resumable).toBe(true);
  });
});

describe("dropStaleRemoteAgentBranch", () => {
  test("no-op when the remote branch does not exist", async () => {
    const repoDir = await buildClonedRepo();
    await Effect.runPromise(dropStaleRemoteAgentBranch({ repoDir, branch: BRANCH }));
    expect(await remoteBranchExists(repoDir)).toBe(false);
  });

  test("drops a stale remote branch so a fresh push fast-forwards (#36)", async () => {
    const repoDir = await buildClonedRepo();
    // A prior run pushed a branch ahead of main to origin, then died.
    await $`git -C ${repoDir} checkout -q -b ${BRANCH}`;
    writeFileSync(join(repoDir, "wip.ts"), "abandoned\n");
    await $`git -C ${repoDir} add wip.ts`;
    await $`git -C ${repoDir} commit -q -m wip`;
    await $`git -C ${repoDir} push -q -u origin ${BRANCH}`;

    // The new run branches fresh from main — behind the stale remote tip.
    await $`git -C ${repoDir} checkout -q main`;
    await $`git -C ${repoDir} branch -q -D ${BRANCH}`;
    await $`git -C ${repoDir} checkout -q -b ${BRANCH} main`;

    // Without the drop, this push is rejected non-fast-forward.
    const before = await $`git -C ${repoDir} push origin ${BRANCH}`.nothrow();
    expect(before.exitCode).not.toBe(0);

    await Effect.runPromise(dropStaleRemoteAgentBranch({ repoDir, branch: BRANCH }));

    const after = await $`git -C ${repoDir} push -u origin ${BRANCH}`.nothrow();
    expect(after.exitCode).toBe(0);
  });
});
