import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { reclaimAgentBranch } from "./reclaim-branch";

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
