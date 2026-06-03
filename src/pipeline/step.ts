/**
 * Pipeline/step.ts — the step dispatcher and the end-of-attempt seam.
 *
 * `step` advances the machine by one state. `fetch_queue` is the only
 * state whose handler can fail fatally (the `ProviderCallError` reading
 * the queue is the orchestrator's terminator). Every other handler routes
 * its failure through `HandlerError`; the seam here catches it once and,
 * reading the error's `fate` (ADR 0004), rebuilds one of three end states
 * from `current` — `failed` (the agent judged), `stalled` (the work consumed
 * its budget without a verdict), or `interrupted` (an external cut-off). A
 * `fatal` fate is a deploy bug and crashes the run.
 */
import { Console, Effect } from "effect";
import { evaluatePhase } from "../phases/evaluate";
import { fixPhase } from "../phases/fix";
import { reviewPhase } from "../phases/review";
import { qaPhase } from "../phases/qa";
import { planPhase } from "../phases/plan";
import { implementationPhase } from "../phases/implementation";
import { LABELS } from "../config";
import { GitProvider } from "../provider/provider";
import type { ProviderCallError } from "../provider/types";
import { describeProviderError } from "../provider/types";
import type { Environment } from "../preflight";
import { RunArtifacts } from "../run-artifacts";
import { notifyIssueEnd, type NotificationCategory } from "../notify/discord";
import { clearCheckpoint } from "../recovery/checkpoint";
import { clearIssue, recordInterruption, recordStall } from "../recovery/sidecar";
import type { Outcome } from "../recovery/sidecar-policy";
import type { HandlerError } from "./errors";
import { onDone, onMerge, onOpenDraftMr } from "./handlers/pr";
import { onBranchCreate, onBranchPush, onClaimIssue, onFetchQueue } from "./handlers/queue";
import type { EndStateFields, State } from "./state";

/** Services every multi-yield handler / dispatcher requires. */
type HandlerServices = GitProvider | RunArtifacts;

/**
 * The note left on the issue when an attempt ends. `header` distinguishes the
 * three fates; the body links the run log and whatever pipeline context the
 * attempt had reached (draft MR, worktree to resume from, fix cycles).
 */
const endNote = (header: string, state: EndStateFields, logPath: string): string =>
  [
    `${header} — ${state.reason}`,
    "",
    `- Run log: \`${logPath}\``,
    state.pullRequestIid === null ? null : `- Draft MR (left for inspection): !${state.pullRequestIid}`,
    state.worktree === null ? null : `- Worktree (left for inspection): \`${state.worktree}\``,
    state.fixCycles === null ? null : `- Fix cycles completed: ${state.fixCycles}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

/** Post an end-of-attempt note; a provider failure is logged, never fatal. */
const postEndNote = (
  issueIid: number,
  note: string,
): Effect.Effect<void, never, GitProvider> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    yield* provider.addIssueNote(issueIid, note).pipe(
      Effect.catchAll((error) =>
        Console.error(
          `  ⚠ #${issueIid}: could not post the end-of-attempt note — ${describeProviderError(error)}`,
        ),
      ),
    );
  });

/** Swap labels at end-of-attempt; a provider failure is logged, never fatal. */
const swapLabels = (
  issueIid: number,
  add: readonly string[],
  remove: readonly string[],
): Effect.Effect<void, never, GitProvider> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    yield* provider.updateIssueLabels(issueIid, { add: [...add], remove: [...remove] }).pipe(
      Effect.catchAll((error) =>
        Console.error(
          `  ⚠ #${issueIid}: could not update labels — ${describeProviderError(error)}`,
        ),
      ),
    );
  });

/**
 * Announce the end of an attempt on both channels: the issue note (always) and,
 * best-effort, a Discord push. Both carry the same `header` + state, so the
 * `EndStateFields → IssueEndNotification` mapping lives here once.
 */
const announceEnd = (
  state: EndStateFields,
  header: string,
  category: NotificationCategory,
  logPath: string,
  source: { readonly repo: string; readonly runId: string },
): Effect.Effect<void, never, GitProvider> =>
  Effect.gen(function* () {
    yield* postEndNote(state.issue.iid, endNote(header, state, logPath));
    yield* notifyIssueEnd({
      category,
      headline: header,
      issue: state.issue,
      branch: state.branch,
      pullRequestIid: state.pullRequestIid,
      fixCycles: state.fixCycles,
      reason: state.reason,
      source,
    });
  });

/**
 * Park an issue as a Failure: note it, label `failed-by-agent`, forget its
 * re-queue history. Shared by `onFailed` (the agent judged) and by `onStalled`
 * / `onInterrupted` when the cap converts a re-queue into a terminal Failure.
 */
const parkAsFailed = (
  state: EndStateFields,
  header: string,
  repoName: string,
): Effect.Effect<void, never, HandlerServices> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    yield* announceEnd(state, header, "failure", artifacts.logPath, {
      repo: repoName,
      runId: artifacts.runId,
    });
    yield* swapLabels(
      state.issue.iid,
      [LABELS.failedByAgent],
      [LABELS.pickedByAgent, LABELS.readyForAgent],
    );
    yield* clearIssue(repoName, state.issue.iid);
    yield* clearCheckpoint(repoName, state.issue.iid);
  });

/**
 * Return an issue to the queue: note the cut-off (with the worktree to resume
 * from), drop the claim, restore `ready-for-agent`. The sidecar history is left
 * in place — it is what eventually trips the cap.
 */
const returnToQueue = (
  state: EndStateFields,
  header: string,
  repoName: string,
): Effect.Effect<void, never, HandlerServices> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    yield* announceEnd(state, header, "requeued", artifacts.logPath, {
      repo: repoName,
      runId: artifacts.runId,
    });
    yield* swapLabels(state.issue.iid, [LABELS.readyForAgent], [LABELS.pickedByAgent]);
  });

/** Failed — the agent judged. Note, label `failed-by-agent`, clear the sidecar. */
const onFailed = (
  state: Extract<State, { kind: "failed" }>,
  env: Environment,
): Effect.Effect<State, never, HandlerServices> =>
  parkAsFailed(state, "**AFK failed**", env.repoName).pipe(Effect.as({ kind: "fetch_queue" }));

/**
 * Stalled — the work consumed its budget without a verdict. Count it; once
 * consecutive Stalls reach `STALL_CAP` (or total re-picks reach `REPICK_CAP`)
 * the issue parks as a Failure, otherwise it returns to the queue (ADR 0004).
 */
const onStalled = (
  state: Extract<State, { kind: "stalled" }>,
  env: Environment,
): Effect.Effect<State, never, HandlerServices> =>
  Effect.gen(function* () {
    const outcome: Outcome = yield* recordStall(env.repoName, state.issue.iid);
    if (outcome.park) {
      yield* parkAsFailed(
        state,
        `**AFK gave up** — stalled ${outcome.counts.consecutiveStalls}× (no verdict)`,
        env.repoName,
      );
    } else {
      yield* returnToQueue(
        state,
        `**AFK stalled** — returned to queue (attempt ${outcome.counts.totalRepicks + 1})`,
        env.repoName,
      );
    }
    return { kind: "fetch_queue" };
  });

/**
 * Interrupted — an external cut-off (signal, transient error, defect). Re-queue
 * for free; only the absolute `REPICK_CAP` backstop converts it to a Failure
 * (ADR 0004). The consecutive-Stall run was already reset by `recordInterruption`.
 */
const onInterrupted = (
  state: Extract<State, { kind: "interrupted" }>,
  env: Environment,
): Effect.Effect<State, never, HandlerServices> =>
  Effect.gen(function* () {
    const outcome: Outcome = yield* recordInterruption(env.repoName, state.issue.iid);
    if (outcome.park) {
      yield* parkAsFailed(
        state,
        `**AFK gave up** — re-picked ${outcome.counts.totalRepicks}× without finishing`,
        env.repoName,
      );
    } else {
      yield* returnToQueue(
        state,
        `**AFK interrupted** — returned to queue (attempt ${outcome.counts.totalRepicks + 1})`,
        env.repoName,
      );
    }
    return { kind: "fetch_queue" };
  });

/**
 * Dispatch to the handler for any non-`fetch_queue` state.
 *
 * Routable failures from any handler bubble up the shared `HandlerError`
 * channel; the seam in {@link step} converts them to an end state.
 * `onDone`/`onFailed`/`onStalled`/`onInterrupted` truly never fail; their
 * `never` error channel widens cleanly into `HandlerError`.
 */
const dispatchHandler = (
  current: Exclude<State, { kind: "fetch_queue" }>,
  env: Environment,
): Effect.Effect<State, HandlerError, HandlerServices> => {
  switch (current.kind) {
    case "claim_issue": {
      return onClaimIssue(current.issue);
    }
    case "branch_create": {
      return onBranchCreate(current.issue, env);
    }
    case "branch_push": {
      return onBranchPush(current, env);
    }
    case "plan": {
      return planPhase(current);
    }
    case "implementation": {
      return implementationPhase(current, env);
    }
    case "open_draft_mr": {
      return onOpenDraftMr(current, env);
    }
    case "review": {
      return reviewPhase(current, env);
    }
    case "evaluate": {
      return evaluatePhase(current);
    }
    case "fix": {
      return fixPhase(current);
    }
    case "qa": {
      return qaPhase(current);
    }
    case "merge": {
      return onMerge(current, env);
    }
    case "done": {
      return onDone(current, env);
    }
    case "failed": {
      return onFailed(current, env);
    }
    case "stalled": {
      return onStalled(current, env);
    }
    case "interrupted": {
      return onInterrupted(current, env);
    }
    case "end": {
      return Effect.die("step was called on the end state");
    }
    default: {
      // Exhaustiveness: a new State variant without a case is a compile error.
      const unreachable: never = current;
      return Effect.die(`unhandled state: ${JSON.stringify(unreachable)}`);
    }
  }
};

/**
 * Extract pipeline fields off the current state to enrich an end state.
 *
 * Exhaustive switch on the state kind. A new State variant fails to compile
 * here until it gets an explicit row. That forces a deliberate decision on
 * which fields propagate into `failed` / `stalled` / `interrupted`.
 */
export const endFieldsOf = (
  state: Exclude<State, { kind: "fetch_queue" | "end" | "failed" | "stalled" | "interrupted" }>,
): Omit<EndStateFields, "reason"> => {
  switch (state.kind) {
    case "claim_issue":
    case "branch_create": {
      return {
        issue: state.issue,
        branch: null,
        worktree: null,
        pullRequestIid: null,
        fixCycles: null,
      };
    }
    case "branch_push":
    case "plan":
    case "implementation": {
      return {
        issue: state.issue,
        branch: state.branch,
        worktree: state.worktree,
        pullRequestIid: null,
        fixCycles: null,
      };
    }
    case "open_draft_mr": {
      return {
        issue: state.issue,
        branch: state.branch,
        worktree: state.worktree,
        pullRequestIid: null,
        fixCycles: null,
      };
    }
    case "review":
    case "evaluate":
    case "fix": {
      return {
        issue: state.issue,
        branch: state.branch,
        worktree: state.worktree,
        pullRequestIid: state.pullRequestIid,
        fixCycles: state.fixCycles,
      };
    }
    case "qa": {
      return {
        issue: state.issue,
        branch: state.branch,
        worktree: state.worktree,
        pullRequestIid: state.pullRequestIid,
        fixCycles: state.fixCycles,
      };
    }
    case "merge": {
      return {
        issue: state.issue,
        branch: state.branch,
        worktree: state.worktree,
        pullRequestIid: state.pullRequestIid,
        fixCycles: null,
      };
    }
    case "done": {
      return {
        issue: state.issue,
        branch: null,
        worktree: state.worktree,
        pullRequestIid: state.pullRequestIid,
        fixCycles: null,
      };
    }
    default: {
      const _exhaustive: never = state;
      throw new Error(`unhandled state: ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/**
 * Advance the machine by one state.
 *
 * Only `fetch_queue` can fail — its `ProviderCallError` is fatal.
 * Every other handler exposes a `HandlerError`. This seam catches it once and,
 * reading `error.fate`, rebuilds the matching end state from `current`'s fields
 * (`failure → failed`, `stall → stalled`, `interruption → interrupted`). A
 * `fatal` fate is a deploy bug and dies the run. The caller only sees
 * `ProviderCallError`.
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
      if (
        current.kind === "end" ||
        current.kind === "failed" ||
        current.kind === "stalled" ||
        current.kind === "interrupted"
      ) {
        // Unreachable: end dies inside dispatchHandler; the end states never fail.
        return Effect.die(`unexpected handler failure for ${current.kind}: ${error.reason}`);
      }
      if (error.fate === "fatal") {
        // A deploy bug (missing prompt, bad auth): crash the run, do not park the issue.
        return Effect.die(`fatal: ${error.reason}`);
      }
      const endFields = { ...endFieldsOf(current), reason: error.reason };
      if (error.fate === "interruption") {
        // A usage-limit hit is an interruption carrying the reset substring; the
        // machine reads it off the `interrupted` state to back off (#78). Every
        // other interruption leaves it null.
        return Effect.succeed({
          kind: "interrupted",
          ...endFields,
          usageLimitResetText: error.usageLimitResetText ?? null,
        });
      }
      return Effect.succeed({ kind: error.fate === "failure" ? "failed" : "stalled", ...endFields });
    }),
  );
};
