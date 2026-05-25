/**
 * One handler per state, plus the `step` dispatcher.
 *
 * Each handler takes its narrowed state variant and returns the next state.
 * Only `fetch_queue` fails fatally — a `ProviderCallError` reading the queue is.
 * Every other handler exposes a `HandlerError` channel; the dispatcher
 * converts these into a `failed` state at the seam by pulling the pipeline
 * context off `current`. Handlers therefore never spread `{issue, branch,
 * worktree, pullRequestIid}` themselves.
 *
 * The five interactive Phase handlers (run_impl, review, evaluate, fix,
 * run_dogfood) live in `src/phases/*` — each Phase owns its own verdict-set
 * narrowing and verdict-to-state routing. This file keeps the queue-level
 * states (fetch_queue, claim_issue, branch_worktree), the script-only states
 * (open_draft_mr, merge, done), the failure path (failed), and the dispatcher.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Console, Effect, Option } from "effect";
import { LABELS, WORKTREES_DIR } from "../config";
import { describeShellError, runShell, runShellAllowingFailure } from "../shell";
import { evaluatePhase } from "../phases/evaluate";
import { fixPhase } from "../phases/fix";
import { reviewPhase } from "../phases/review";
import { runDogfoodPhase } from "../phases/run-dogfood";
import { runImplPhase } from "../phases/run-impl";
import { GitProvider } from "../provider/provider";
import { describeProviderError } from "../provider/types";
import type { ProviderCallError, PullRequestRef } from "../provider/types";
import type { Environment } from "../preflight";
import { RunArtifacts } from "../run-artifacts";
import { HandlerError } from "./errors";
import { branchName, worktreePath } from "./naming";
import type { IssueRef, State } from "./state";

// ─── Constants ────────────────────────────────────────────────────────────

const STATE_FETCH_QUEUE = "fetch_queue" as const;

/** Services every multi-yield handler / dispatcher requires. */
type HandlerServices = GitProvider | RunArtifacts;

// ─── Handler helpers ───────────────────────────────────────────────────────

/** Map a `ProviderCallError` into a `HandlerError` with a phase-prefixed reason. */
const providerHandlerError = (prefix: string) =>
  (error: ProviderCallError): HandlerError =>
    new HandlerError({ reason: `${prefix}: ${describeProviderError(error)}` });

/** Run `git -C <worktree> <args>` and capture the result. */
const runShellGit = (worktree: string, args: readonly string[]) =>
  runShell(() => $`git -C ${worktree} ${args}`);

/** Find the open pull request for a branch, if any. Never fails. */
const findOpenPullRequest = (
  branch: string,
): Effect.Effect<Option.Option<PullRequestRef>, never, GitProvider> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    return yield* provider.findOpenPullRequestBySource(branch).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none<PullRequestRef>())),
    );
  });

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

// ─── State handlers ────────────────────────────────────────────────────────

/** Fetch_queue — read the ready queue, pick one issue at random, or end. */
const onFetchQueue: Effect.Effect<State, ProviderCallError, GitProvider> = Effect.gen(
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
const onClaimIssue = (
  issue: IssueRef,
): Effect.Effect<State, HandlerError, GitProvider> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    // Re-read the labels right before claiming. This narrows the window
    // where another instance claims the same issue. A label add is not a
    // compare-and-swap. Worst case both work it; the random pick keeps that rare.
    const alreadyClaimed = yield* provider.viewIssue(issue.iid).pipe(
      Effect.map((view) => new Set(view.labels).has(LABELS.pickedByAgent)),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (alreadyClaimed) {
      yield* Console.log(`  ↳ #${issue.iid} already claimed by another instance — skipping`);
      return { kind: STATE_FETCH_QUEUE };
    }

    yield* provider
      .updateIssueLabels(issue.iid, { add: [LABELS.pickedByAgent], remove: [] })
      .pipe(Effect.mapError(providerHandlerError("claim_issue")));

    const banner = "─".repeat(80);
    yield* Console.log(
      `\n${banner}\n#${issue.iid} ${issue.title}\n${banner}\n${issue.body === "" ? "(no description)" : issue.body}\n${banner}\n`,
    );
    return { kind: "branch_worktree", issue };
  });

/** Branch_worktree — create the issue branch in a dedicated worktree, push it. */
const onBranchWorktree = (
  issue: IssueRef,
  env: Environment,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const branch = branchName(issue);
    const worktree = worktreePath(env.repoName, branch);

    yield* Effect.tryPromise({
      try: () => mkdir(join(WORKTREES_DIR, env.repoName), { recursive: true }),
      catch: (cause): HandlerError =>
        new HandlerError({
          reason: `branch_worktree: could not create the worktree parent directory — ${String(cause)}`,
        }),
    });

    // Re-entrancy: a crashed prior run may have left this branch and worktree
    // behind (the sweep removes only the worktree, not the branch). Clear both
    // so the `git worktree add -b` below starts from a clean slate.
    yield* runShellAllowingFailure(() => $`git worktree remove --force ${worktree}`);
    yield* runShellAllowingFailure(() => $`git worktree prune`);
    yield* runShellAllowingFailure(() => $`git branch -D ${branch}`);

    yield* runShell(() => $`git fetch origin ${env.defaultBranch}`).pipe(
      Effect.catchAll(() =>
        Console.error(
          `  ⚠ git fetch failed — branching off a possibly-stale origin/${env.defaultBranch}`,
        ),
      ),
    );
    yield* runShell(
      () => $`git worktree add -b ${branch} ${worktree} origin/${env.defaultBranch}`,
    ).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `branch_worktree: worktree add failed — ${describeShellError(error)}`,
          }),
      ),
    );

    yield* excludeStopHookConfig(worktree);

    // Push: branch/worktree exist on disk by now — surface them on the error
    // so `onFailed` can print the path the operator needs to inspect.
    yield* runShellGit(worktree, ["push", "-u", "origin", branch]).pipe(
      Effect.mapError(
        (error): HandlerError =>
          new HandlerError({
            reason: `branch_worktree: push failed — ${describeShellError(error)}`,
            branch,
            worktree,
          }),
      ),
    );
    return { kind: "run_impl", issue, branch, worktree };
  });

/** Open_draft_mr — open the Draft PR (idempotent), recording its iid. */
const onOpenDraftMr = (
  state: Extract<State, { kind: "open_draft_mr" }>,
  env: Environment,
): Effect.Effect<State, HandlerError, HandlerServices> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const { issue, branch, worktree, deadline } = state;

    const existing = yield* findOpenPullRequest(branch);
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
const onMerge = (
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
const onDone = (
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
    yield* runShellAllowingFailure(() => $`git worktree prune`);
    yield* Console.log(`  ✓ #${issue.iid} merged (!${pullRequestIid})`);
    return { kind: STATE_FETCH_QUEUE };
  });

/** Failed — note the failure on the issue, label it, loop back to the queue. */
const onFailed = (
  state: Extract<State, { kind: "failed" }>,
): Effect.Effect<State, never, HandlerServices> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const artifacts = yield* RunArtifacts;
    const { reason, pullRequestIid, worktree, issue, fixCycles } = state;
    const note = [
      `**AFK failed** — ${reason}`,
      "",
      `- Run log: \`${artifacts.logPath}\``,
      pullRequestIid === null ? null : `- Draft MR (left for inspection): !${pullRequestIid}`,
      worktree === null ? null : `- Worktree (left for inspection): \`${worktree}\``,
      fixCycles === null ? null : `- Fix cycles completed: ${fixCycles}`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    yield* provider.addIssueNote(issue.iid, note).pipe(
      Effect.catchAll((error) =>
        Console.error(
          `  ⚠ #${issue.iid}: could not post the failure note — ${describeProviderError(error)}`,
        ),
      ),
    );
    yield* provider
      .updateIssueLabels(issue.iid, {
        add: [LABELS.failedByAgent],
        remove: [LABELS.pickedByAgent],
      })
      .pipe(
        Effect.catchAll((error) =>
          Console.error(
            `  ⚠ #${issue.iid}: could not set ${LABELS.failedByAgent} — ${describeProviderError(error)}`,
          ),
        ),
      );
    return { kind: STATE_FETCH_QUEUE };
  });

// ─── The step dispatcher ───────────────────────────────────────────────────

/**
 * Dispatch to the handler for any non-`fetch_queue` state.
 *
 * Routable failures from any handler bubble up the shared `HandlerError`
 * channel; the seam in {@link step} converts them to a `failed` state.
 * `onDone`/`onFailed` truly never fail; their `never` error channel
 * widens cleanly into `HandlerError`.
 */
const dispatchHandler = (
  current: Exclude<State, { kind: "fetch_queue" }>,
  env: Environment,
): Effect.Effect<State, HandlerError, HandlerServices> => {
  switch (current.kind) {
    case "claim_issue": {
      return onClaimIssue(current.issue);
    }
    case "branch_worktree": {
      return onBranchWorktree(current.issue, env);
    }
    case "run_impl": {
      return runImplPhase(current);
    }
    case "open_draft_mr": {
      return onOpenDraftMr(current, env);
    }
    case "review": {
      return reviewPhase(current);
    }
    case "evaluate": {
      return evaluatePhase(current);
    }
    case "fix": {
      return fixPhase(current);
    }
    case "run_dogfood": {
      return runDogfoodPhase(current);
    }
    case "merge": {
      return onMerge(current);
    }
    case "done": {
      return onDone(current);
    }
    case "failed": {
      return onFailed(current);
    }
    case "end": {
      return Effect.die("step was called on the end state");
    }
    default: {
      // Exhaustiveness: a new State variant without a case here is a compile error.
      const unreachable: never = current;
      return Effect.die(`unhandled state: ${JSON.stringify(unreachable)}`);
    }
  }
};

/**
 * Extract pipeline fields off the current state to enrich a `failed` state.
 *
 * The `in` operator gives a static narrowing: any variant carrying the
 * field returns the value, others return `null`. A new State variant
 * adding new fields propagates here without any seam edit.
 */
export const failedFieldsOf = (
  state: Exclude<State, { kind: "fetch_queue" | "end" | "failed" }>,
): Omit<Extract<State, { kind: "failed" }>, "kind" | "reason"> => {
  const { issue } = state;
  return {
    issue,
    branch: "branch" in state ? state.branch : null,
    worktree: "worktree" in state ? state.worktree : null,
    pullRequestIid: "pullRequestIid" in state ? state.pullRequestIid : null,
    fixCycles: "fixCycles" in state ? state.fixCycles : null,
  };
};

/**
 * Advance the machine by one state.
 *
 * Only `fetch_queue` can fail — its `ProviderCallError` is fatal.
 * Every other handler exposes a `HandlerError`. This seam catches it once
 * and rebuilds a `failed` state from `current`'s fields. The caller only
 * sees `ProviderCallError`.
 */
export const step = (
  current: State,
  env: Environment,
): Effect.Effect<State, ProviderCallError, HandlerServices> => {
  if (current.kind === "fetch_queue") {
    return onFetchQueue;
  }
  return dispatchHandler(current, env).pipe(
    Effect.catchAll((error: HandlerError): Effect.Effect<State> => {
      if (current.kind === "end" || current.kind === "failed") {
        // Unreachable: end dies inside dispatchHandler, failed has no failure mode.
        return Effect.die(`unexpected handler failure for ${current.kind}: ${error.reason}`);
      }
      const base = failedFieldsOf(current);
      return Effect.succeed({
        kind: "failed",
        issue: base.issue,
        branch: error.branch ?? base.branch,
        worktree: error.worktree ?? base.worktree,
        pullRequestIid: error.pullRequestIid ?? base.pullRequestIid,
        fixCycles: base.fixCycles,
        reason: error.reason,
      });
    }),
  );
};
