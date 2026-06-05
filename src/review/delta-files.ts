/**
 * Review/delta-files.ts — files touched between two commits in a worktree.
 * Guards against non-ancestor SHAs.
 *
 * Used by the fan-out to skip scoped agents whose territory hasn't changed
 * since the previous review iteration. The basic operation is a trivial
 * `git diff --name-only A...HEAD`. But the caller may pass a `lastSha` that
 * is no longer an ancestor of HEAD — e.g. a force-push or rebase inside
 * `fix`. The diff is then meaningless and the safe fallback is to disable
 * the skip entirely (return `null` — "treat every file as changed").
 *
 * Pure data in / Effect out: the only side effect is the two `git` shell-outs.
 */
import { $ } from "bun";
import { Effect } from "effect";
import { GIT_READ_TIMEOUT_MS } from "../config";
import type { ShellError } from "../shell";
import { runShell, withShellRetry } from "../shell";

/** Input for {@link getChangedFilesSince}. */
export type GetChangedFilesSinceInput = {
  readonly worktree: string;
  readonly lastSha: string;
};

/**
 * `getChangedFilesSince` — list files touched between `lastSha` and HEAD in
 * `worktree`. Returns `null` when `lastSha` is not an ancestor of HEAD (the
 * delta is meaningless — caller must disable the skip optimization for this
 * iteration). Returns the de-duplicated file path list on the happy path.
 *
 * Errors from the ancestor check are not failures — `git merge-base
 * --is-ancestor` exits 1 when not-an-ancestor and that's not a runtime error.
 * We discriminate on exit code via {@link ShellNonZeroExit}: exit 1 → `null`,
 * other failures (spawn, timeout, exit ≥ 2) propagate.
 */
export const getChangedFilesSince = (
  input: GetChangedFilesSinceInput,
): Effect.Effect<readonly string[] | null, ShellError> =>
  Effect.gen(function* () {
    const { worktree, lastSha } = input;
    // withShellRetry gates on ShellTimeout/ShellSpawnFailed only, so the exit-1
    // not-an-ancestor signal (a ShellNonZeroExit) skips the retry and flows
    // straight to the catchTag below — the retry can't swallow it.
    const isAncestor = yield* withShellRetry(
      runShell(
        () => $`git -C ${worktree} merge-base --is-ancestor ${lastSha} HEAD`,
        GIT_READ_TIMEOUT_MS,
      ),
    ).pipe(
      Effect.map(() => true),
      Effect.catchTag("ShellNonZeroExit", (error) =>
        error.exitCode === 1 ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
    if (!isAncestor) {
      return null;
    }

    const diff = yield* withShellRetry(
      runShell(
        () => $`git -C ${worktree} diff --name-only ${lastSha}...HEAD`,
        GIT_READ_TIMEOUT_MS,
      ),
    );
    const files = diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    return [...new Set(files)];
  });
