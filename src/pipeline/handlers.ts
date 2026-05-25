/**
 * One handler per state, plus the `step` dispatcher.
 *
 * Each handler takes its narrowed state variant and returns the next state.
 * Only `fetch_queue` fails fatally — a `ProviderCallError` reading the queue is.
 * Every other handler exposes a `HandlerError` channel; the dispatcher
 * converts these into a `failed` state at the seam by pulling the pipeline
 * context off `current`. Handlers therefore never spread `{issue, branch,
 * worktree, pullRequestIid}` themselves.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Console, Effect, Option } from "effect";
import type { Phase } from "../config";
import { ISSUE_BUDGET_MS, LABELS, MAX_FIX_CYCLES, WORKTREES_DIR } from "../config";
import { describeShellError, runShell, runShellAllowingFailure } from "../shell";
import { GitProvider } from "../provider/provider";
import { describeProviderError } from "../provider/types";
import type { ProviderCallError, PullRequestRef } from "../provider/types";
import type { Environment } from "../preflight";
import { runDir, runLogPath } from "../run-artifacts";
import { phaseTimeoutMs, runPhaseSession } from "../session/phase";
import type { VerdictToken } from "../session/verdict";
import type { PhaseRunError } from "./errors";
import { HandlerError, UnexpectedVerdictError, describePhaseRunError } from "./errors";
import { branchName, worktreePath } from "./naming";
import type { IssueRef, PipelineContext, State } from "./state";

// ─── Constants ────────────────────────────────────────────────────────────

const STATE_FETCH_QUEUE = "fetch_queue" as const;
const STATE_RUN_DOGFOOD = "run_dogfood" as const;
const STATE_OPEN_DRAFT_MR = "open_draft_mr" as const;

// ─── Handler helpers ───────────────────────────────────────────────────────

/** The five shared pipeline fields, copied off any node that carries them. */
const pipelineContext = (state: PipelineContext): PipelineContext => ({
  issue: state.issue,
  branch: state.branch,
  worktree: state.worktree,
  deadline: state.deadline,
  pullRequestIid: state.pullRequestIid,
});

/** Options for running a single phase session. */
type RunPhaseOptions = {
  readonly issueIid: number;
  readonly worktree: string;
  readonly deadline: number;
  readonly iteration: number;
  readonly replacements: Record<string, string>;
};

/**
 * Run one phase and narrow the verdict to the expected set.
 *
 * Keeps the typed `PhaseError` channel of `runPhaseSession`; an out-of-set
 * verdict surfaces as `UnexpectedVerdictError` so callers route on tagged
 * data rather than re-pattern-matching a string reason.
 */
const runPhase = <const V extends VerdictToken>(
  phase: Phase,
  options: RunPhaseOptions,
  expected: readonly V[],
): Effect.Effect<V, PhaseRunError> => {
  const expectedSet: ReadonlySet<string> = new Set(expected);
  const isExpected = (verdict: VerdictToken): verdict is V => expectedSet.has(verdict);
  return runPhaseSession({
    phase,
    issueIid: options.issueIid,
    worktree: options.worktree,
    iteration: options.iteration,
    timeoutMs: phaseTimeoutMs(phase, options.deadline),
    replacements: options.replacements,
  }).pipe(
    Effect.flatMap((verdict) =>
      isExpected(verdict)
        ? Effect.succeed(verdict)
        : Effect.fail(new UnexpectedVerdictError({ phase, verdict, expected })),
    ),
  );
};

/** Build the `RunPhaseOptions` for a PR-bound phase — the `{worktree, mr_iid}` template. */
const mrPhaseOptions = (context: PipelineContext, iteration: number): RunPhaseOptions => ({
  issueIid: context.issue.iid,
  worktree: context.worktree,
  deadline: context.deadline,
  iteration,
  replacements: { worktree: context.worktree, mr_iid: String(context.pullRequestIid) },
});

/** Map a phase-running error into a `HandlerError` with a phase-prefixed reason. */
const phaseRunHandlerError = (prefix: string) =>
  (error: PhaseRunError): HandlerError =>
    new HandlerError({ reason: `${prefix}: ${describePhaseRunError(error)}` });

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
    Effect.flatMap((probe) => {
      const excludeFile = join(probe.stdout.trim(), "info", "exclude");
      return Effect.tryPromise(async () => {
        const current = existsSync(excludeFile) ? await readFile(excludeFile, "utf8") : "";
        if (!current.split("\n").includes(".claude/settings.local.json")) {
          const separator = current === "" || current.endsWith("\n") ? "" : "\n";
          await appendFile(excludeFile, `${separator}.claude/settings.local.json\n`);
        }
      });
    }),
    Effect.catchAll(() => Console.error("  ⚠ could not update the git exclude for .claude/")),
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
): Effect.Effect<State, HandlerError> =>
  Effect.gen(function* () {
    const branch = branchName(issue);
    const worktree = worktreePath(env.repoName, branch);

    yield* Effect.tryPromise(() =>
      mkdir(join(WORKTREES_DIR, env.repoName), { recursive: true }),
    ).pipe(
      Effect.mapError(
        (): HandlerError =>
          new HandlerError({
            reason: "branch_worktree: could not create the worktree parent directory",
          }),
      ),
    );

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

/** Run_impl — start the budget, run the implementer phase. */
const onRunImpl = (
  state: Extract<State, { kind: "run_impl" }>,
): Effect.Effect<State, HandlerError> =>
  Effect.gen(function* () {
    const { issue, branch, worktree } = state;
    const deadline = Date.now() + ISSUE_BUDGET_MS;

    const verdict = yield* runPhase(
      "run_impl",
      {
        issueIid: issue.iid,
        worktree,
        deadline,
        iteration: 0,
        replacements: {
          iid: String(issue.iid),
          title: issue.title,
          branch,
          worktree,
          body: issue.body === "" ? "(no description)" : issue.body,
        },
      },
      ["READY_FOR_REVIEW", "BLOCKER_SUSPECTED"],
    ).pipe(Effect.mapError(phaseRunHandlerError("run_impl")));

    if (verdict === "READY_FOR_REVIEW") {
      return { kind: STATE_OPEN_DRAFT_MR, issue, branch, worktree, deadline };
    }
    return yield* Effect.fail(
      new HandlerError({ reason: "run_impl: the implementer reported a blocker" }),
    );
  });

/** Open_draft_mr — open the Draft PR (idempotent), recording its iid. */
const onOpenDraftMr = (
  state: Extract<State, { kind: "open_draft_mr" }>,
  env: Environment,
): Effect.Effect<State, HandlerError, GitProvider> =>
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

    const description =
      `Closes #${issue.iid}\n\nImplemented and reviewed autonomously by the AFK orchestrator.\n\n` +
      `Run log: \`${runDir}\``;
    const opened = yield* provider
      .createDraftPullRequest({
        sourceBranch: branch,
        targetBranch: env.defaultBranch,
        title: `[AFK] ${issue.title}`,
        description,
      })
      .pipe(Effect.mapError(providerHandlerError(STATE_OPEN_DRAFT_MR)));

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

/** Review — run the review phase; `REVIEW_DONE` leads to evaluate. */
const onReview = (
  state: Extract<State, { kind: "review" }>,
): Effect.Effect<State, HandlerError> =>
  Effect.gen(function* () {
    const { fixCycles } = state;
    yield* runPhase("review", mrPhaseOptions(state, fixCycles), ["REVIEW_DONE"]).pipe(
      Effect.mapError(phaseRunHandlerError(`review[${fixCycles}]`)),
    );
    return { kind: "evaluate", ...pipelineContext(state), fixCycles };
  });

/** Evaluate — the convergence authority; `CONVERGED` leads to dogfood, `NEEDS_FIX` leads to fix. */
const onEvaluate = (
  state: Extract<State, { kind: "evaluate" }>,
): Effect.Effect<State, HandlerError> =>
  Effect.gen(function* () {
    const { fixCycles } = state;
    const verdict = yield* runPhase(
      "evaluate",
      mrPhaseOptions(state, fixCycles),
      ["CONVERGED", "NEEDS_FIX"],
    ).pipe(Effect.mapError(phaseRunHandlerError(`evaluate[${fixCycles}]`)));

    if (verdict === "CONVERGED") {
      return { kind: STATE_RUN_DOGFOOD, ...pipelineContext(state) };
    }
    // NEEDS_FIX — cap is on the number of fix sessions. A 4th NEEDS_FIX is a
    // structural disagreement, not a slow fix — end the issue for a human.
    if (MAX_FIX_CYCLES <= fixCycles) {
      return yield* Effect.fail(
        new HandlerError({
          reason: `fix_cycle_cap: ${MAX_FIX_CYCLES} fix cycles without convergence`,
        }),
      );
    }
    return { kind: "fix", ...pipelineContext(state), fixCycles };
  });

/** Fix — apply the verified fix instructions; `FIX_DONE` leads back to review. */
const onFix = (state: Extract<State, { kind: "fix" }>): Effect.Effect<State, HandlerError> =>
  Effect.gen(function* () {
    const { fixCycles } = state;
    yield* runPhase("fix", mrPhaseOptions(state, fixCycles), ["FIX_DONE"]).pipe(
      Effect.mapError(phaseRunHandlerError(`fix[${fixCycles}]`)),
    );
    // The cycle is spent — carry the incremented count back into the loop.
    return { kind: "review", ...pipelineContext(state), fixCycles: fixCycles + 1 };
  });

/** Run_dogfood — the runtime gate; `DOGFOOD_PASS` leads to merge. */
const onRunDogfood = (
  state: Extract<State, { kind: "run_dogfood" }>,
): Effect.Effect<State, HandlerError> =>
  Effect.gen(function* () {
    const verdict = yield* runPhase(
      STATE_RUN_DOGFOOD,
      mrPhaseOptions(state, 0),
      ["DOGFOOD_PASS", "DOGFOOD_FAIL"],
    ).pipe(Effect.mapError(phaseRunHandlerError(STATE_RUN_DOGFOOD)));

    if (verdict === "DOGFOOD_PASS") {
      return { kind: "merge", ...pipelineContext(state) };
    }
    return yield* Effect.fail(
      new HandlerError({
        reason: `${STATE_RUN_DOGFOOD}: the runtime dogfood gate found an in-scope bug`,
      }),
    );
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
): Effect.Effect<State, never, GitProvider> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const { reason, pullRequestIid, worktree, issue } = state;
    const note = [
      `**AFK failed** — ${reason}`,
      "",
      `- Run log: \`${runLogPath}\``,
      pullRequestIid === null ? null : `- Draft MR (left for inspection): !${pullRequestIid}`,
      worktree === null ? null : `- Worktree (left for inspection): \`${worktree}\``,
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
): Effect.Effect<State, HandlerError, GitProvider> => {
  switch (current.kind) {
    case "claim_issue": {
      return onClaimIssue(current.issue);
    }
    case "branch_worktree": {
      return onBranchWorktree(current.issue, env);
    }
    case "run_impl": {
      return onRunImpl(current);
    }
    case "open_draft_mr": {
      return onOpenDraftMr(current, env);
    }
    case "review": {
      return onReview(current);
    }
    case "evaluate": {
      return onEvaluate(current);
    }
    case "fix": {
      return onFix(current);
    }
    case "run_dogfood": {
      return onRunDogfood(current);
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
): Effect.Effect<State, ProviderCallError, GitProvider> => {
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
        reason: error.reason,
      });
    }),
  );
};
