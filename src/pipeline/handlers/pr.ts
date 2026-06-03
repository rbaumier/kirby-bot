/**
 * PR-level handlers: the script-only states once a Draft MR exists.
 *
 *   - `open_draft_mr` — open the Draft PR (idempotent), recording its iid.
 *   - `merge` — un-draft the PR and merge it, verifying on a non-zero exit.
 *   - `done` — unlabel the issue, remove the worktree, loop back to the queue.
 *
 * The five interactive Phase handlers (implementation, review, evaluate, fix,
 * qa) live in `src/phases/*` — each Phase owns its own verdict
 * narrowing and verdict-to-state routing.
 */
import { $ } from "bun";
import { Console, Effect, Option } from "effect";
import { LABELS } from "../../config";
import type { Environment } from "../../preflight";
import { GitProvider } from "../../provider/provider";
import type { ProviderCallError } from "../../provider/types";
import { describeProviderError } from "../../provider/types";
import { RunArtifacts } from "../../run-artifacts";
import { notifyIssueEnd } from "../../notify/discord";
import { issueWebUrl, pullRequestWebUrl } from "../../notify/web-links";
import { clearCheckpoint, readCheckpoint } from "../../recovery/checkpoint";
import { clearIssue } from "../../recovery/sidecar";
import { resumeStateFor } from "../resume";
import { describeShellError, runShell } from "../../shell";
import { fateOfProviderError, HandlerError, providerHandlerError } from "../errors";
import { rebaseBranchOntoDefault } from "./rebase-branch";
import type { State } from "../state";

/** Open_draft_mr — open the Draft PR (idempotent), recording its iid. */
export const onOpenDraftMr = (
  state: Extract<State, { kind: "open_draft_mr" }>,
  env: Environment,
): Effect.Effect<State, HandlerError, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const { issue, branch, worktree, deadline } = state;

    // Idempotency check: don't swallow lookup failures — a "no MR found" verdict
    // on a network blip would race into creating a duplicate Draft MR. Surface
    // the error so the seam re-tries the issue cleanly.
    const existing = yield* provider
      .findOpenPullRequestBySource(branch)
      .pipe(Effect.mapError(providerHandlerError("open_draft_mr")));
    if (Option.isSome(existing)) {
      yield* Console.log(`  ↳ reusing open MR !${existing.value.iid} for ${branch}`);
      // Resume routing (#73): an existing MR means a prior attempt reached at
      // least this far, so route to its checkpointed Phase (or `review` if there
      // is none). The create path below never honors a checkpoint — a brand-new
      // MR has no Discussions, so resuming `evaluate` / `fix` would read an empty
      // MR (exactly the MR-inference failure mode this design rejects).
      const checkpoint = yield* readCheckpoint(env.repoName, issue.iid);
      return resumeStateFor(checkpoint, {
        issue,
        branch,
        worktree,
        deadline,
        pullRequestIid: existing.value.iid,
      });
    }

    const artifacts = yield* RunArtifacts;
    const description =
      `Closes #${issue.iid}\n\nImplemented and reviewed autonomously by the AFK orchestrator.\n\n` +
      `Run log: \`${artifacts.dir}\``;
    const opened = yield* provider
      .createDraftPullRequest({
        sourceBranch: branch,
        targetBranch: env.defaultBranch,
        title: `[AFK] ${issue.title}`,
        description,
      })
      .pipe(Effect.mapError(providerHandlerError("open_draft_mr")));

    yield* Console.log(`  ↳ Draft MR !${opened.iid} created for ${branch}`);
    return {
      kind: "review",
      issue,
      branch,
      worktree,
      deadline,
      pullRequestIid: opened.iid,
      fixCycles: 0,
    };
  });

/**
 * GitLab's 422 for a branch that has fallen behind its target. The recovery
 * is a rebase + force-push + retry, not a terminal failure (see issue #40).
 */
const isBranchOutOfDate = (error: ProviderCallError): boolean =>
  error._tag === "ProviderHttpError" &&
  error.status === 422 &&
  error.body.includes("Branch cannot be merged");

/** Merge — un-draft the PR and merge it, verifying on a non-zero exit. */
export const onMerge = (
  state: Extract<State, { kind: "merge" }>,
  env: Environment,
): Effect.Effect<State, HandlerError, GitProvider> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const { issue, branch, worktree, pullRequestIid } = state;

    yield* provider.markPullRequestReady(pullRequestIid).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `merge: could not un-draft — ${describeProviderError(error)}`,
            fate: "interruption",
          }),
      ),
    );

    // One merge attempt. Resolves to `done` when the PR merges — or was already
    // merged, a race with auto-merge (`closed` ≠ `merged`) — and otherwise fails
    // with the raw provider error so the caller can decide whether to recover.
    const attemptMerge: Effect.Effect<State, ProviderCallError, GitProvider> = provider
      .mergePullRequest(pullRequestIid, { shouldSquash: true, shouldAutoMerge: true })
      .pipe(
        Effect.map((): State => ({ kind: "done", issue, worktree, pullRequestIid })),
        Effect.catchAll((mergeError) =>
          provider.viewPullRequest(pullRequestIid).pipe(
            Effect.map((pr) => pr.isMerged),
            Effect.catchAll(() => Effect.succeed(false)),
            Effect.flatMap(
              (isMerged): Effect.Effect<State, ProviderCallError> =>
                isMerged
                  ? Effect.succeed({ kind: "done", issue, worktree, pullRequestIid })
                  : Effect.fail(mergeError),
            ),
          ),
        ),
      );

    // On "branch out of date", rebase onto the default branch, force-push, and
    // retry the merge once before giving up — preserving all review/fix work.
    return yield* attemptMerge.pipe(
      Effect.catchAll((mergeError): Effect.Effect<State, HandlerError, GitProvider> => {
        if (!isBranchOutOfDate(mergeError)) {
          return Effect.fail(
            new HandlerError({
              reason: `merge: ${describeProviderError(mergeError)}`,
              fate: fateOfProviderError(mergeError),
            }),
          );
        }
        return Effect.gen(function* () {
          yield* Console.log(
            `  ↳ merge rejected (branch out of date) — rebasing ${branch} onto ${env.defaultBranch}`,
          );
          yield* rebaseBranchOntoDefault({ worktree, branch, defaultBranch: env.defaultBranch }).pipe(
            Effect.mapError(
              (error): HandlerError =>
                new HandlerError({ reason: `merge: ${error.reason}`, fate: error.fate }),
            ),
          );
          return yield* attemptMerge.pipe(
            Effect.mapError(
              (retryError): HandlerError =>
                new HandlerError({
                  reason: `merge: still failing after rebase — ${describeProviderError(retryError)}`,
                  fate: fateOfProviderError(retryError),
                }),
            ),
          );
        });
      }),
    );
  });

/** Done — unlabel the issue, remove the worktree, loop back to the queue. */
export const onDone = (
  state: Extract<State, { kind: "done" }>,
  env: Environment,
): Effect.Effect<State, never, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const artifacts = yield* RunArtifacts;
    const { issue, worktree, pullRequestIid } = state;
    const unlabelOne = (label: string) =>
      provider.updateIssueLabels(issue.iid, { add: [], remove: [label] }).pipe(
        Effect.catchAll((error) =>
          Console.error(
            `  ⚠ #${issue.iid}: unlabel ${label} failed — ${describeProviderError(error)}`,
          ),
        ),
      );
    yield* Effect.forEach([LABELS.pickedByAgent, LABELS.readyForAgent], unlabelOne, {
      discard: true,
    });
    yield* runShell(() => $`git worktree remove ${worktree} --force`).pipe(
      Effect.catchAll((error) =>
        Console.error(`  ⚠ worktree removal failed: ${describeShellError(error).slice(0, 160)}`),
      ),
    );
    yield* runShell(() => $`git worktree prune`).pipe(Effect.ignore);
    // A success resets the issue's re-queue history — forget it so a future
    // unrelated re-pick starts from a clean Stall/re-pick count (ADR 0004). Its
    // own internal catchAll keeps a swallowed fs error from preserving the count.
    yield* clearIssue(env.repoName, issue.iid);
    yield* clearCheckpoint(env.repoName, issue.iid);
    yield* Console.log(`  ✓ #${issue.iid} merged (!${pullRequestIid})`);
    // Success leaves no issue note (unlike the end-of-attempt fates), so it is
    // off the `announceEnd` seam. The `done` state is not an `EndStateFields`:
    // the ping carries only the PR + title, with no branch / fix-cycle context.
    yield* notifyIssueEnd({
      category: "success",
      headline: "merged",
      issue,
      pullRequestIid,
      issueUrl: issueWebUrl(issue.iid),
      pullRequestUrl: pullRequestWebUrl(pullRequestIid),
      source: { repo: env.repoName, runId: artifacts.runId },
    });
    return { kind: "fetch_queue" };
  });
