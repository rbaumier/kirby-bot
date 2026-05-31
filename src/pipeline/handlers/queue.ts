/**
 * Queue-level handlers: the states that do not yet have a PR.
 *
 *   - `fetch_queue` — read the ready queue, pick one issue at random, or end.
 *   - `claim_issue` — re-check the labels, then claim by adding `picked-by-agent`.
 *   - `branch_create` — create the issue branch in a dedicated worktree.
 *   - `branch_push` — push the freshly-created branch to origin.
 *
 * Only `onFetchQueue` fails fatally (the `ProviderCallError` it surfaces is the
 * orchestrator's terminator). The others route their failures through
 * `HandlerError`; the `step` seam rebuilds a `failed` state from `current`.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Console, Effect } from "effect";
import { LABELS, WORKTREES_DIR } from "../../config";
import type { Environment } from "../../preflight";
import { GitProvider } from "../../provider/provider";
import type { ProviderCallError } from "../../provider/types";
import { RunArtifacts } from "../../run-artifacts";
import { describeShellError, runShell, runShellGit } from "../../shell";
import { writeLock } from "../../recovery/lockfile";
import { HandlerError, providerHandlerError } from "../errors";
import { branchName, worktreePath } from "../naming";
import {
  dropStaleRemoteAgentBranch,
  reclaimAgentBranch,
  resumableRemoteBranch,
} from "./reclaim-branch";
import { worktreePathsForIssue } from "../../recovery/stale";
import type { IssueRef, State } from "../state";

/**
 * Exclude `.claude/settings.local.json` from git in a fresh worktree.
 *
 * Uses the repo's git exclude file so a phase agent's `git add -A` cannot
 * commit the orchestrator's Stop-hook config into the MR. Best-effort:
 * a failure is logged, not fatal.
 */
const excludeStopHookConfig = (worktree: string): Effect.Effect<void> =>
  runShellGit(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
    Effect.matchEffect({
      // Probe failure: silent skip — the worktree may be transiently unreadable.
      onFailure: () => Effect.void,
      onSuccess: (probe) => {
        const excludeFile = join(probe.stdout.trim(), "info", "exclude");
        return Effect.tryPromise(async () => {
          const current = existsSync(excludeFile) ? await readFile(excludeFile, "utf8") : "";
          if (!current.split("\n").includes(".claude/settings.local.json")) {
            const separator = current === "" || current.endsWith("\n") ? "" : "\n";
            await appendFile(excludeFile, `${separator}.claude/settings.local.json\n`);
          }
        }).pipe(
          Effect.catchAll(() =>
            Console.error("  ⚠ could not update the git exclude for .claude/"),
          ),
        );
      },
    }),
  );

/** Fetch_queue — read the ready queue, pick one issue at random, or end. */
export const onFetchQueue: Effect.Effect<State, ProviderCallError, GitProvider> = Effect.gen(
  function* () {
    const provider = yield* GitProvider;
    const issues = yield* provider.listIssuesByLabels({
      include: [LABELS.readyForAgent],
      exclude: [LABELS.failedByAgent, LABELS.pickedByAgent],
    });
    const count = issues.length;
    if (count === 0) {
      return { kind: "end" };
    }

    // Random pick keeps multi-instance collisions probabilistically rare.
    const picked = issues.at(Math.floor(Math.random() * count));
    if (picked === undefined) {
      return { kind: "end" };
    }
    return {
      kind: "claim_issue",
      issue: { iid: picked.iid, title: picked.title, body: picked.description ?? "" },
    };
  },
);

/** Claim_issue — re-check the labels, then claim by adding `picked-by-agent`. */
export const onClaimIssue = (
  issue: IssueRef,
): Effect.Effect<State, HandlerError, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const artifacts = yield* RunArtifacts;
    // Re-read the labels right before claiming. This narrows the window
    // where another instance claims the same issue. A label add is not a
    // compare-and-swap. Worst case both work it; the random pick keeps that rare.
    const alreadyClaimed = yield* provider.viewIssue(issue.iid).pipe(
      Effect.map((view) => new Set(view.labels).has(LABELS.pickedByAgent)),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (alreadyClaimed) {
      yield* Console.log(`  ↳ #${issue.iid} already claimed by another instance — skipping`);
      return { kind: "fetch_queue" };
    }

    // Record liveness *before* the label so a concurrent sweep never sees a
    // `picked-by-agent` claim without a live lock behind it (ADR 0004).
    yield* writeLock(artifacts.dir, issue.iid);

    yield* provider
      .updateIssueLabels(issue.iid, {
        add: [LABELS.pickedByAgent],
        remove: [LABELS.readyForAgent],
      })
      .pipe(Effect.mapError(providerHandlerError("claim_issue")));

    const banner = "─".repeat(80);
    yield* Console.log(
      `\n${banner}\n#${issue.iid} ${issue.title}\n${banner}\n${issue.body === "" ? "(no description)" : issue.body}\n${banner}\n`,
    );
    return { kind: "branch_create", issue };
  });

/** Branch_create — materialize the branch + worktree on disk. */
export const onBranchCreate = (
  issue: IssueRef,
  env: Environment,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    const branch = branchName(issue);
    const worktree = worktreePath(env.repoName, branch);

    yield* Effect.tryPromise({
      try: () => mkdir(join(WORKTREES_DIR, env.repoName), { recursive: true }),
      catch: (cause): HandlerError =>
        new HandlerError({
          reason: `branch_create: could not create the worktree parent directory — ${String(cause)}`,
          fate: "interruption",
        }),
    });

    // Re-entrancy: a crashed prior run may have left this branch and worktree
    // behind (the sweep removes only the worktree, not the branch). Remove the
    // worktree and refresh origin first, so both the resume probe and the
    // containment check below see a current origin/<defaultBranch> and
    // origin/<branch>.
    yield* runShell(() => $`git worktree remove --force ${worktree}`).pipe(Effect.ignore);
    yield* runShell(() => $`git worktree prune`).pipe(Effect.ignore);

    // Also drop any OTHER worktree still holding this issue's branch (a manual
    // checkout, or a path-scheme change across runs). git refuses to delete or
    // re-add a branch that is checked out elsewhere, so without this the later
    // `branch -D` / `worktree add -b` fails and the issue loops on re-pick — on
    // both the resume and fresh-start paths.
    const priorWorktrees = yield* runShell(() => $`git worktree list --porcelain`).pipe(
      Effect.map((output) => worktreePathsForIssue(output.stdout, issue.iid)),
      Effect.catchAll(() => Effect.succeed([] as readonly string[])),
    );
    yield* Effect.forEach(
      priorWorktrees,
      (path) => runShell(() => $`git worktree remove --force ${path}`).pipe(Effect.ignore),
      { discard: true },
    );

    yield* runShell(() => $`git fetch origin ${env.defaultBranch}`).pipe(
      Effect.catchAll(() =>
        Console.error(
          `  ⚠ git fetch failed — branching off a possibly-stale origin/${env.defaultBranch}`,
        ),
      ),
    );
    // Best-effort: learn whether origin/<branch> carries pushed work from a prior
    // interrupted attempt. Absent → exits non-zero → ignored.
    yield* runShell(() => $`git fetch origin ${branch}`).pipe(Effect.ignore);

    const resume = yield* resumableRemoteBranch({
      repoDir: ".",
      branch,
      defaultBranch: env.defaultBranch,
    });

    if (resume) {
      // Resume (ADR 0004, G1.5): origin/<branch> holds commits beyond the default
      // branch. Rebuild the worktree FROM that tip so the implementer continues
      // where the interrupted run left off — do NOT reclaim or drop the remote
      // branch, that work is exactly what we resume from. Drop only the stale
      // LOCAL ref so `worktree add -b` can recreate it on the pushed tip.
      // Count the salvaged commits for the audit trail — this is the prompt-only
      // softness of the resume path (the implementer re-runs blind to the MR), so
      // a structured event makes every resume greppable in run.jsonl for review.
      const ahead = yield* runShell(
        () => $`git rev-list --count origin/${env.defaultBranch}..origin/${branch}`,
      ).pipe(
        Effect.map((output) => parseInt(output.stdout.trim(), 10)),
        Effect.catchAll(() => Effect.succeed(Number.NaN)),
      );
      const commitsAhead = Number.isNaN(ahead) ? null : ahead;
      yield* Console.log(
        `  ↻ #${issue.iid}: resuming from origin/${branch}` +
          ` (${commitsAhead ?? "?"} commit(s) of prior work pushed before it was interrupted)`,
      );
      yield* artifacts.logEvent({
        event: "branch_resume",
        issue: issue.iid,
        branch,
        commitsAhead,
      });
      yield* runShell(() => $`git branch -D ${branch}`).pipe(Effect.ignore);
      yield* runShell(
        () => $`git worktree add -b ${branch} ${worktree} origin/${branch}`,
      ).pipe(
        Effect.mapError(
          (error): HandlerError =>
            new HandlerError({
              reason: `branch_create: worktree add (resume) failed — ${describeShellError(error)}`,
              fate: "interruption",
            }),
        ),
      );
    } else {
      // Fresh start: reclaim the leftover branch — but only if it holds nothing
      // that isn't already upstream, so a colliding human branch is never
      // clobbered (#24)...
      yield* reclaimAgentBranch({ repoDir: ".", branch, defaultBranch: env.defaultBranch });

      // ...and drop a stale origin/<branch> left by a sentinel-failed run, else
      // the fresh push is rejected non-fast-forward (#36).
      yield* dropStaleRemoteAgentBranch({ repoDir: ".", branch });

      yield* runShell(
        () => $`git worktree add -b ${branch} ${worktree} origin/${env.defaultBranch}`,
      ).pipe(
        Effect.mapError(
          (error): HandlerError =>
            new HandlerError({
              reason: `branch_create: worktree add failed — ${describeShellError(error)}`,
              fate: "interruption",
            }),
        ),
      );
    }

    yield* excludeStopHookConfig(worktree);
    return { kind: "branch_push", issue, branch, worktree };
  });

/** Branch_push — push the freshly-created branch to origin. */
export const onBranchPush = (
  state: Extract<State, { kind: "branch_push" }>,
): Effect.Effect<State, HandlerError> =>
  Effect.gen(function* () {
    const { issue, branch, worktree } = state;
    yield* runShellGit(worktree, ["push", "-u", "origin", branch]).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `branch_push: push failed — ${describeShellError(error)}`,
            fate: "interruption",
          }),
      ),
    );
    return { kind: "implementation", issue, branch, worktree };
  });
