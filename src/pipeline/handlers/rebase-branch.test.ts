import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { rebaseBranchOntoDefault } from "./rebase-branch";

const BRANCH = "issue-42";

type DivergeOptions = {
  /** The file the branch's commit touches. Same as main's → rebase conflict. */
  readonly branchFile: string;
};

/**
 * A bare `origin` plus a working clone with a diverged feature branch. `main`
 * gained a commit after the branch was pushed, so the branch is "behind"
 * exactly as GitLab sees it at merge time.
 */
const buildDivergedRepo = async (options: DivergeOptions): Promise<string> => {
  const origin = mkdtempSync(join(tmpdir(), "kirby-rebase-origin-"));
  await $`git -C ${origin} init -q --bare -b main`;

  const work = mkdtempSync(join(tmpdir(), "kirby-rebase-work-"));
  await $`git -C ${work} init -q -b main`;
  await $`git -C ${work} config user.email test@test`;
  await $`git -C ${work} config user.name test`;
  await $`git -C ${work} remote add origin ${origin}`;

  writeFileSync(join(work, "a.ts"), "base\n");
  await $`git -C ${work} add a.ts`;
  await $`git -C ${work} commit -q -m base`;
  await $`git -C ${work} push -q -u origin main`;

  // Feature branch with its own commit, pushed to origin.
  await $`git -C ${work} checkout -q -b ${BRANCH}`;
  writeFileSync(join(work, options.branchFile), "branch change\n");
  await $`git -C ${work} add ${options.branchFile}`;
  await $`git -C ${work} commit -q -m feature`;
  await $`git -C ${work} push -q -u origin ${BRANCH}`;

  // main moves ahead by one commit touching a.ts.
  await $`git -C ${work} checkout -q main`;
  writeFileSync(join(work, "a.ts"), "base\nmain change\n");
  await $`git -C ${work} add a.ts`;
  await $`git -C ${work} commit -q -m advance`;
  await $`git -C ${work} push -q origin main`;

  // Back on the branch — this is the worktree state at merge time.
  await $`git -C ${work} checkout -q ${BRANCH}`;
  return work;
};

const headSha = async (worktree: string, ref: string): Promise<string> => {
  const out = await $`git -C ${worktree} rev-parse ${ref}`.text();
  return out.trim();
};

const rebaseInProgress = async (worktree: string): Promise<boolean> => {
  const path = await $`git -C ${worktree} rev-parse --git-path rebase-merge`.text();
  const probe = await $`test -d ${path.trim()}`.nothrow();
  return probe.exitCode === 0;
};

describe("rebaseBranchOntoDefault", () => {
  test("replays the branch on top of the updated origin/main", async () => {
    const worktree = await buildDivergedRepo({ branchFile: "b.ts" });

    await Effect.runPromise(rebaseBranchOntoDefault({ worktree, branch: BRANCH, defaultBranch: "main" }));

    const mainSha = await headSha(worktree, "origin/main");
    const parentSha = await headSha(worktree, `${BRANCH}~1`);
    expect(parentSha).toBe(mainSha);
  });

  test("force-pushes the rebased branch to origin", async () => {
    const worktree = await buildDivergedRepo({ branchFile: "b.ts" });

    await Effect.runPromise(rebaseBranchOntoDefault({ worktree, branch: BRANCH, defaultBranch: "main" }));

    const localSha = await headSha(worktree, BRANCH);
    const remoteSha = await headSha(worktree, `origin/${BRANCH}`);
    expect(localSha).toBe(remoteSha);
  });

  test("commits a dirty working tree before rebasing, carrying the edit along (#67)", async () => {
    const worktree = await buildDivergedRepo({ branchFile: "b.ts" });
    // A post-review edit left uncommitted by a later phase — would abort the
    // rebase with "cannot rebase: You have unstaged changes" before the fix.
    writeFileSync(join(worktree, "b.ts"), "branch change\npost-review refinement\n");

    await Effect.runPromise(rebaseBranchOntoDefault({ worktree, branch: BRANCH, defaultBranch: "main" }));

    const clean = (await $`git -C ${worktree} status --porcelain`.text()).trim();
    expect(clean).toBe("");
    const localSha = await headSha(worktree, BRANCH);
    const remoteSha = await headSha(worktree, `origin/${BRANCH}`);
    expect(localSha).toBe(remoteSha);
    const tracked = await $`git -C ${worktree} show ${BRANCH}:b.ts`.text();
    expect(tracked).toContain("post-review refinement");
  });

  test("fails with a conflict error when the rebase cannot replay cleanly", async () => {
    const worktree = await buildDivergedRepo({ branchFile: "a.ts" });

    const error = await Effect.runPromise(
      Effect.flip(rebaseBranchOntoDefault({ worktree, branch: BRANCH, defaultBranch: "main" })),
    );

    expect(error._tag).toBe("HandlerError");
    expect(error.reason).toContain("hit conflicts");
  });

  test("aborts the conflicting rebase, leaving the branch intact", async () => {
    const worktree = await buildDivergedRepo({ branchFile: "a.ts" });
    const before = await headSha(worktree, BRANCH);

    await Effect.runPromise(
      Effect.flip(rebaseBranchOntoDefault({ worktree, branch: BRANCH, defaultBranch: "main" })),
    );

    const after = await headSha(worktree, BRANCH);
    const dangling = await rebaseInProgress(worktree);
    expect(after).toBe(before);
    expect(dangling).toBe(false);
  });
});
