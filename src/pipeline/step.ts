/**
 * Pipeline/step.ts — the step dispatcher and the failed-state seam.
 *
 * `step` advances the machine by one state. `fetch_queue` is the only
 * state whose handler can fail fatally (the `ProviderCallError` reading
 * the queue is the orchestrator's terminator). Every other handler routes
 * its failure through `HandlerError`; the seam here catches it once and
 * rebuilds a `failed` state from `current`.
 */
import { Console, Effect } from "effect";
import { evaluatePhase } from "../phases/evaluate";
import { fixPhase } from "../phases/fix";
import { reviewPhase } from "../phases/review";
import { runDogfoodPhase } from "../phases/run-dogfood";
import { runImplPhase } from "../phases/run-impl";
import { LABELS } from "../config";
import { GitProvider } from "../provider/provider";
import type { ProviderCallError } from "../provider/types";
import { describeProviderError } from "../provider/types";
import type { Environment } from "../preflight";
import { RunArtifacts } from "../run-artifacts";
import type { HandlerError } from "./errors";
import { onDone, onMerge, onOpenDraftMr } from "./handlers/pr";
import { onBranchCreate, onBranchPush, onClaimIssue, onFetchQueue } from "./handlers/queue";
import type { State } from "./state";

/** Services every multi-yield handler / dispatcher requires. */
type HandlerServices = GitProvider | RunArtifacts;

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
    return { kind: "fetch_queue" };
  });

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
    case "branch_create": {
      return onBranchCreate(current.issue, env);
    }
    case "branch_push": {
      return onBranchPush(current);
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
      // Exhaustiveness: a new State variant without a case is a compile error.
      const unreachable: never = current;
      return Effect.die(`unhandled state: ${JSON.stringify(unreachable)}`);
    }
  }
};

/**
 * Extract pipeline fields off the current state to enrich a `failed` state.
 *
 * Exhaustive switch on the state kind. A new State variant fails to compile
 * here until it gets an explicit row. That forces a deliberate decision on
 * which fields propagate into `failed`.
 */
export const failedFieldsOf = (
  state: Exclude<State, { kind: "fetch_queue" | "end" | "failed" }>,
): Omit<Extract<State, { kind: "failed" }>, "kind" | "reason"> => {
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
    case "run_impl": {
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
    case "run_dogfood":
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
      return Effect.succeed({
        kind: "failed",
        ...failedFieldsOf(current),
        reason: error.reason,
      });
    }),
  );
};
