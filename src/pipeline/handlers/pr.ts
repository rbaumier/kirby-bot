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
import { describeProviderError } from "../../provider/types";
import { RunArtifacts } from "../../run-artifacts";
import { describeShellError, runShell } from "../../shell";
import { HandlerError, providerHandlerError } from "../errors";
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
      return {
        kind: "review",
        issue,
        branch,
        worktree,
        deadline,
        pullRequestIid: existing.value.iid,
        fixCycles: 0,
      };
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

/** Merge — un-draft the PR and merge it, verifying on a non-zero exit. */
export const onMerge = (
  state: Extract<State, { kind: "merge" }>,
): Effect.Effect<State, HandlerError, GitProvider> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const { issue, worktree, pullRequestIid } = state;

    yield* provider.markPullRequestReady(pullRequestIid).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `merge: could not un-draft — ${describeProviderError(error)}`,
          }),
      ),
    );

    // The merge API can return an error while the PR is in fact merged or
    // queued (race with auto-merge) — verify the state before failing.
    // `closed` ≠ `merged`.
    return yield* provider
      .mergePullRequest(pullRequestIid, { shouldSquash: true, shouldAutoMerge: true })
      .pipe(
        Effect.map((): State => ({ kind: "done", issue, worktree, pullRequestIid })),
        Effect.catchAll(
          (mergeError): Effect.Effect<State, HandlerError, GitProvider> =>
            Effect.gen(function* () {
              const isMerged = yield* provider.viewPullRequest(pullRequestIid).pipe(
                Effect.map((pr) => pr.isMerged),
                Effect.catchAll(() => Effect.succeed(false)),
              );
              if (isMerged) {
                return { kind: "done", issue, worktree, pullRequestIid };
              }
              return yield* Effect.fail(
                new HandlerError({ reason: `merge: ${describeProviderError(mergeError)}` }),
              );
            }),
        ),
      );
  });

/** Done — unlabel the issue, remove the worktree, loop back to the queue. */
export const onDone = (
  state: Extract<State, { kind: "done" }>,
): Effect.Effect<State, never, GitProvider> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
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
    yield* Console.log(`  ✓ #${issue.iid} merged (!${pullRequestIid})`);
    return { kind: "fetch_queue" };
  });
