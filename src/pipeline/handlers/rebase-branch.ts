/**
 * Rebase-branch — bring an agent branch up to date with the default branch.
 *
 * GitLab refuses to merge a branch that has fallen behind its target with
 * HTTP 422 "Branch cannot be merged" (see issue #40). The recovery is to
 * rebase the branch onto the latest `origin/<defaultBranch>`, force-push, and
 * let the merge phase retry. A rebase that hits conflicts is aborted so the
 * worktree is left clean for inspection, and the failure is surfaced.
 *
 * Before rebasing, any pending working-tree changes are committed. A phase
 * (evaluate/fix, or a formatter) can leave the worktree dirty after the
 * reviewed commit was already pushed; `git rebase` refuses to run on a dirty
 * tree (`cannot rebase: You have unstaged changes`), which otherwise strands a
 * fully-reviewed MR (#67). Committing those edits first lets the rebase run
 * clean and carries the refinements along in the force-push.
 */
import { Effect } from "effect";
import { describeShellError, runShellGit, withShellRetry } from "../../shell";
import { HandlerError } from "../errors";

export type RebaseBranchInput = {
  readonly worktree: string;
  readonly branch: string;
  readonly defaultBranch: string;
};

/**
 * Commit any uncommitted working-tree changes so the rebase can run. A clean
 * tree is a no-op. `git add -A` stages every untracked path too, not just
 * tracked edits; the `.claude/settings.local.json` exclude set up in
 * `branch_create` keeps the orchestrator's own config out of it.
 */
const commitPendingChanges = (worktree: string): Effect.Effect<void, HandlerError> =>
  Effect.gen(function* () {
    const status = yield* runShellGit(worktree, ["status", "--porcelain"]).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `status before rebase failed — ${describeShellError(error)}`,
            fate: "interruption",
          }),
      ),
    );
    if (status.stdout.trim() === "") {
      return;
    }

    yield* runShellGit(worktree, ["add", "-A"]).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `git add before rebase failed — ${describeShellError(error)}`,
            fate: "interruption",
          }),
      ),
    );
    yield* runShellGit(worktree, ["commit", "-m", "chore: post-review refinements (kirby)"]).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `commit before rebase failed — ${describeShellError(error)}`,
            fate: "interruption",
          }),
      ),
    );
  });

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

    yield* withShellRetry(runShellGit(worktree, ["fetch", "origin", defaultBranch])).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `fetch before rebase failed — ${describeShellError(error)}`,
            fate: "interruption",
          }),
      ),
    );

    yield* commitPendingChanges(worktree);

    yield* runShellGit(worktree, ["rebase", `origin/${defaultBranch}`]).pipe(
      Effect.catchAll((error) =>
        runShellGit(worktree, ["rebase", "--abort"]).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.fail(
              // Diff-correlated and recurs on resume (the branch genuinely diverges
              // from the default), so it's a Stall — capped at STALL_CAP and parked
              // for a human to resolve, not retried up to the looser re-pick backstop
              // (ADR 0004's re-runnability rule). The transient git wrappers around
              // this stay `interruption`.
              new HandlerError({
                reason: `rebase onto ${defaultBranch} hit conflicts — ${describeShellError(error)}`,
                fate: "stall",
              }),
            ),
          ),
        ),
      ),
    );

    yield* withShellRetry(
      runShellGit(worktree, ["push", "--force-with-lease", "origin", branch]),
    ).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `force-push after rebase failed — ${describeShellError(error)}`,
            fate: "interruption",
          }),
      ),
    );
  });
