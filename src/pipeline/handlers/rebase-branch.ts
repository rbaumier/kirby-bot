/**
 * Rebase-branch — bring an agent branch up to date with the default branch.
 *
 * GitLab refuses to merge a branch that has fallen behind its target with
 * HTTP 422 "Branch cannot be merged" (see issue #40). The recovery is to
 * rebase the branch onto the latest `origin/<defaultBranch>`, force-push, and
 * let the merge phase retry. A rebase that hits conflicts is aborted so the
 * worktree is left clean for inspection, and the failure is surfaced.
 */
import { Effect } from "effect";
import { describeShellError, runShellGit } from "../../shell";
import { HandlerError } from "../errors";

export type RebaseBranchInput = {
  readonly worktree: string;
  readonly branch: string;
  readonly defaultBranch: string;
};

/**
 * Rebase `branch` (checked out in `worktree`) onto `origin/<defaultBranch>`
 * and force-push the result. Fetches the target ref first so the rebase sees
 * the latest tip.
 */
export const rebaseBranchOntoDefault = (
  input: RebaseBranchInput,
): Effect.Effect<void, HandlerError> =>
  Effect.gen(function* () {
    const { worktree, branch, defaultBranch } = input;

    yield* runShellGit(worktree, ["fetch", "origin", defaultBranch]).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({ reason: `fetch before rebase failed — ${describeShellError(error)}` }),
      ),
    );

    yield* runShellGit(worktree, ["rebase", `origin/${defaultBranch}`]).pipe(
      Effect.catchAll((error) =>
        runShellGit(worktree, ["rebase", "--abort"]).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.fail(
              new HandlerError({
                reason: `rebase onto ${defaultBranch} hit conflicts — ${describeShellError(error)}`,
              }),
            ),
          ),
        ),
      ),
    );

    yield* runShellGit(worktree, ["push", "--force-with-lease", "origin", branch]).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({ reason: `force-push after rebase failed — ${describeShellError(error)}` }),
      ),
    );
  });
