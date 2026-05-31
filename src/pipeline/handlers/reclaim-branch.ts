/**
 * Pipeline/handlers/reclaim-branch.ts — reclaim a crashed run's leftover agent
 * branch, locally and on origin, before a fresh attempt.
 *
 * The re-entry sweep in `branch_create` used to force-delete any leftover
 * branch unconditionally (`git branch -D`). The branch name is slugified from
 * the issue title/iid, so it can collide with a human's branch. A blind `-D`
 * would then silently discard their unmerged commits (#24).
 *
 * {@link reclaimAgentBranch} — the *local* side — decides, in order:
 *   - branch absent                  → nothing to reclaim (no-op).
 *   - tip ⊆ origin/<defaultBranch>   → fully contained upstream, safe to delete.
 *   - otherwise / can't confirm safe → refuse, fail with an explicit reason.
 *
 * Refusing never loses data; a false delete does. So every uncertain branch
 * (missing origin ref, spawn/timeout on the probe) is treated as unsafe and
 * left for a human to triage.
 *
 * {@link dropStaleRemoteAgentBranch} — the *remote* side (#36) — is deliberately
 * less conservative: it drops the remote branch unconditionally once present,
 * because the `afk/` namespace is the bot's own (see that function's doc).
 *
 * Pure data in / Effect out: the only side effects are the `git` shell-outs.
 */
import { $ } from "bun";
import { Console, Effect } from "effect";
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
                fate: "interruption",
              }),
          ),
        )
      : Effect.fail(
          new HandlerError({
            reason:
              `branch_create: refusing to delete existing branch '${branch}' — its tip is not ` +
              `contained in origin/${defaultBranch}, so it may hold unmerged work (possible name ` +
              `collision). A human must inspect and remove it before this issue can be retried.`,
            fate: "failure",
          }),
        );
  });

/** Input for {@link resumableRemoteBranch}. */
export type ResumableRemoteBranchInput = {
  /** Repo directory to run git in (`.` in production = the orchestrator cwd). */
  readonly repoDir: string;
  /** Slugified issue branch the orchestrator owns. */
  readonly branch: string;
  /** Upstream branch the pushed work must be *ahead of* to count as resumable. */
  readonly defaultBranch: string;
};

/**
 * Whether `origin/<branch>` exists and holds commits beyond `origin/<defaultBranch>`
 * — the fingerprint of an attempt that pushed work before it was interrupted
 * (ADR 0004, G1.5). When true, `branch_create` rebuilds the worktree *from that
 * remote branch* (resume) instead of reclaiming the local ref and recreating from
 * the default branch (fresh start).
 *
 * Assumes the caller has already fetched `origin/<branch>` and
 * `origin/<defaultBranch>`. Any probe failure (missing ref, spawn/timeout)
 * resolves to `false`, so an uncertain case falls back to the conservative
 * fresh-start path rather than resuming onto a tip it could not verify.
 */
export const resumableRemoteBranch = (
  input: ResumableRemoteBranchInput,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { repoDir, branch, defaultBranch } = input;

    const exists = yield* runShell(
      () => $`git -C ${repoDir} rev-parse --verify --quiet refs/remotes/origin/${branch}`,
    ).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (!exists) {
      return false;
    }

    const ahead = yield* runShell(
      () => $`git -C ${repoDir} rev-list --count origin/${defaultBranch}..origin/${branch}`,
    ).pipe(
      Effect.map((output) => parseInt(output.stdout.trim(), 10)),
      Effect.catchAll(() => Effect.succeed(0)),
    );
    return !Number.isNaN(ahead) && ahead > 0;
  });

/** Input for {@link dropStaleRemoteAgentBranch}. */
export type DropStaleRemoteAgentBranchInput = {
  /** Repo directory to run git in (`.` in production = the orchestrator cwd). */
  readonly repoDir: string;
  /** Slugified issue branch the orchestrator owns on origin. */
  readonly branch: string;
};

/**
 * Drop the bot's stale *remote* agent branch so the fresh push fast-forwards (#36).
 *
 * A sentinel-failed run can leave commits on `origin/<branch>`; the next run
 * branches fresh from the default branch and `git push -u` is then rejected
 * non-fast-forward. The delete is unconditional once the branch is present:
 * unlike the local reclaim, no containment check guards it, because the `afk/`
 * namespace is the bot's own and the remote tip is disposable on the fresh-start
 * path.
 *
 * Only reached on the fresh-start path: when the remote branch carries resumable
 * work ({@link resumableRemoteBranch}), `branch_create` rebuilds *from* it and
 * skips this drop entirely (ADR 0004, G1.5).
 *
 * An absent branch — the common fresh case — is a silent no-op. A genuine
 * delete failure (auth, permissions) is logged, not fatal: otherwise the push
 * would later surface only a confusing non-fast-forward with no trace of why.
 */
export const dropStaleRemoteAgentBranch = (
  input: DropStaleRemoteAgentBranchInput,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { repoDir, branch } = input;

    const present = yield* runShell(
      () => $`git -C ${repoDir} ls-remote --exit-code --heads origin ${branch}`,
    ).pipe(
      Effect.as(true),
      // Exit 2 = no matching remote ref (absent). Spawn/timeout/offline: can't
      // confirm — skip the delete; a real push failure reports the cause.
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (!present) {
      return;
    }

    yield* runShell(() => $`git -C ${repoDir} push origin --delete ${branch}`).pipe(
      Effect.tapError((error) =>
        Console.error(
          `  ⚠ could not delete stale remote branch '${branch}' (${error._tag}) — push may be rejected non-fast-forward`,
        ),
      ),
      Effect.ignore,
    );
  });
