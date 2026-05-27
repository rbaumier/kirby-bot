/**
 * Pipeline/handlers/reclaim-branch.ts — reclaim a crashed run's issue branch
 * without ever clobbering work that isn't ours.
 *
 * The re-entry sweep in `branch_create` used to force-delete any leftover
 * branch unconditionally (`git branch -D`). The branch name is slugified from
 * the issue title/iid, so it can collide with a human's branch. A blind `-D`
 * would then silently discard their unmerged commits (#24).
 *
 * Decision, in order:
 *   - branch absent                  → nothing to reclaim (no-op).
 *   - tip ⊆ origin/<defaultBranch>   → fully contained upstream, safe to delete.
 *   - otherwise / can't confirm safe → refuse, fail with an explicit reason.
 *
 * Refusing never loses data; a false delete does. So every uncertain branch
 * (missing origin ref, spawn/timeout on the probe) is treated as unsafe and
 * left for a human to triage.
 *
 * Pure data in / Effect out: the only side effects are the `git` shell-outs.
 */
import { $ } from "bun";
import { Effect } from "effect";
import { describeShellError, runShell } from "../../shell";
import { HandlerError } from "../errors";

/** Input for {@link reclaimAgentBranch}. */
export type ReclaimAgentBranchInput = {
  /** Repo directory to run git in (`.` in production = the orchestrator cwd). */
  readonly repoDir: string;
  /** Slugified issue branch the orchestrator owns. */
  readonly branch: string;
  /** Upstream branch the leftover must be contained in to be deletable. */
  readonly defaultBranch: string;
};

export const reclaimAgentBranch = (
  input: ReclaimAgentBranchInput,
): Effect.Effect<void, HandlerError> =>
  Effect.gen(function* () {
    const { repoDir, branch, defaultBranch } = input;

    const exists = yield* runShell(
      () => $`git -C ${repoDir} show-ref --verify --quiet refs/heads/${branch}`,
    ).pipe(
      Effect.as(true),
      // Non-zero (1) = absent. Spawn/timeout = can't confirm presence; assume
      // absent — the later `worktree add -b` fails loudly if it is present.
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (!exists) {
      return;
    }

    const contained = yield* runShell(
      () =>
        $`git -C ${repoDir} merge-base --is-ancestor refs/heads/${branch} origin/${defaultBranch}`,
    ).pipe(
      Effect.as(true),
      Effect.catchTag("ShellNonZeroExit", (error) =>
        error.exitCode === 1 ? Effect.succeed(false) : Effect.fail(error),
      ),
      // Missing origin ref / spawn / timeout: can't prove it's safe → unsafe.
      Effect.catchAll(() => Effect.succeed(false)),
    );
    // Contained → safe to drop. Otherwise refuse: the tip holds work that
    // isn't upstream, so a human must triage a possible name collision (#24).
    yield* contained
      ? runShell(() => $`git -C ${repoDir} branch -D ${branch}`).pipe(
          Effect.mapError(
            (error): HandlerError =>
              new HandlerError({
                reason: `branch_create: could not delete reclaimed branch '${branch}' — ${describeShellError(error)}`,
              }),
          ),
        )
      : Effect.fail(
          new HandlerError({
            reason:
              `branch_create: refusing to delete existing branch '${branch}' — its tip is not ` +
              `contained in origin/${defaultBranch}, so it may hold unmerged work (possible name ` +
              `collision). A human must inspect and remove it before this issue can be retried.`,
          }),
        );
  });
