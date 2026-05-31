/**
 * Pipeline/machine.ts — the top-level loop that drives `step` to `end`.
 *
 * One transition at a time: run the handler, time it, print and log the
 * transition, repeat until the machine reaches `end`.
 */
import { Clock, Console, Effect } from "effect";
import { formatDuration } from "../duration";
import type { GitProvider } from "../provider/provider";
import type { ProviderCallError } from "../provider/types";
import type { Environment } from "../preflight";
import { writeCheckpoint } from "../recovery/checkpoint";
import { writeLock } from "../recovery/lockfile";
import { recoverStaleClaims } from "../recovery/sweep";
import { RunArtifacts } from "../run-artifacts";
import { finishRun } from "../run-finish";
import { checkpointAfter } from "./resume";
import { step } from "./step";
import type { IssueRef, State } from "./state";

/** Services every machine-level Effect requires. */
type MachineServices = GitProvider | RunArtifacts;

/** Shorten `text` to at most `maxLength` characters, with an ellipsis. */
const truncate = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

type TransitionSummary = {
  readonly issue: IssueRef | null;
  readonly from: string;
  readonly to: string;
  readonly elapsedMs: number;
  readonly note: string | undefined;
};

/** One console line describing a state transition. */
const formatTransition = (transition: TransitionSummary): string => {
  const prefix = transition.issue
    ? `[#${transition.issue.iid} "${truncate(transition.issue.title, 50)}"]`
    : "[—]";
  const tail = transition.note ? ` — ${transition.note}` : "";
  return (
    `${prefix} ${transition.from.toUpperCase()} → ${transition.to.toUpperCase()} ` +
    `(${formatDuration(transition.elapsedMs)})${tail}`
  );
};

/** The issue a state is about, or `null` for the queue-level states. */
const issueOf = (state: State): IssueRef | null => ("issue" in state ? state.issue : null);

/** The PR/MR iid a state carries, or `null` before the draft is opened. */
const prIidOf = (state: State): number | null =>
  "pullRequestIid" in state ? state.pullRequestIid : null;

/** Run one handler, then print and log the transition it produced. */
const advance = (
  state: State,
  env: Environment,
): Effect.Effect<State, ProviderCallError, MachineServices> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    const startedAt = yield* Clock.currentTimeMillis;
    const next = yield* step(state, env);
    const endedAt = yield* Clock.currentTimeMillis;
    const elapsedMs = endedAt - startedAt;

    const issue = issueOf(state) ?? issueOf(next);
    const pullRequestIid = prIidOf(next) ?? prIidOf(state);
    const note =
      next.kind === "failed" || next.kind === "stalled" || next.kind === "interrupted"
        ? next.reason
        : undefined;

    yield* Console.log(
      formatTransition({ issue, from: state.kind, to: next.kind, elapsedMs, note }),
    );
    yield* artifacts.logEvent({
      event: "transition",
      from: state.kind,
      to: next.kind,
      elapsedMs,
      issue: issue ? { iid: issue.iid, title: issue.title } : null,
      pullRequestIid,
      note,
    });

    // Persist where a resumed run should re-enter (#73). The decision is pure
    // (`checkpointAfter`); a write failure is best-effort inside the store.
    const checkpoint = checkpointAfter(state, next);
    if (checkpoint !== null && "issue" in next) {
      yield* writeCheckpoint(env.repoName, next.issue.iid, checkpoint);
    }
    return next;
  });

/**
 * Drive the machine from `fetch_queue` to `end`. A `ProviderCallError` (the
 * fatal queue-read failure) is the only way this fails; every other failure
 * is a `failed` state the loop walks through.
 */
export const runMachine = (
  env: Environment,
): Effect.Effect<void, ProviderCallError, MachineServices> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    yield* Console.log(
      `AFK orchestrator starting. Repo: ${env.repoName}, default branch: ${env.defaultBranch}`,
    );
    yield* Console.log(`Run dir: ${artifacts.dir}\n`);
    yield* artifacts.logEvent({
      event: "run_start",
      repo: env.repoName,
      defaultBranch: env.defaultBranch,
    });

    // Stamp this run's liveness lock (no claim yet) so a sibling instance's
    // sweep can tell our live claims from genuine orphans (ADR 0004).
    yield* writeLock(artifacts.dir, null);

    // Return any claim stranded by a crashed prior run to the queue before
    // reading it — otherwise a stale `picked-by-agent` label hides the issue
    // and the run ends `fetch_queue → end` with no work (#35).
    yield* recoverStaleClaims(env);

    const initialState: State = { kind: "fetch_queue" };
    yield* Effect.iterate(initialState, {
      while: (state: State) => state.kind !== "end",
      body: (state: State) => advance(state, env),
    });

    yield* artifacts.logEvent({ event: "run_end" });
    yield* finishRun(artifacts.dir, artifacts.runId, env.repoName);
    yield* Console.log(
      "\nAFK done. Worktrees and run logs left under ~/.afk-runs/ and ~/.afk-worktrees/.",
    );
  });
