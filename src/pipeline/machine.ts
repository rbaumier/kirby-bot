/**
 * Pipeline/machine.ts — the top-level loop that drives `step` to `end`.
 *
 * One transition at a time: run the handler, time it, print and log the
 * transition, repeat until the machine reaches `end`.
 */
import { Clock, Console, Effect } from "effect";
import {
  USAGE_LIMIT_BACKOFF_FALLBACK_MS,
  USAGE_LIMIT_BACKOFF_MARGIN_MS,
  USAGE_LIMIT_BACKOFF_MIN_MS,
} from "../config";
import { formatDuration } from "../duration";
import type { GitProvider } from "../provider/provider";
import type { ProviderCallError } from "../provider/types";
import type { Environment } from "../preflight";
import { writeCheckpoint } from "../recovery/checkpoint";
import { writeLock } from "../recovery/lockfile";
import { recoverStaleClaims } from "../recovery/sweep";
import { RunArtifacts } from "../run-artifacts";
import { finishRun } from "../run-finish";
import { parseUsageLimitReset } from "../session/usage-limit";
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

/**
 * Compute the usage-limit back-off (#78): sleep until the parsed reset instant
 * plus a clock-skew margin, clamped to a small floor; or a fixed fallback when
 * the reset substring is unparseable. Pure — `now` (epoch ms) is passed in so
 * the result is deterministic and unit-testable.
 */
export const usageLimitBackoffMs = (
  resetText: string,
  now: number,
): { readonly sleepMs: number; readonly resetInstant: number | null } => {
  const resetInstant = parseUsageLimitReset(resetText, now);
  if (resetInstant === null) {
    return { sleepMs: USAGE_LIMIT_BACKOFF_FALLBACK_MS, resetInstant: null };
  }
  const sleepMs = Math.max(
    USAGE_LIMIT_BACKOFF_MIN_MS,
    resetInstant + USAGE_LIMIT_BACKOFF_MARGIN_MS - now,
  );
  return { sleepMs, resetInstant };
};

/**
 * Pause the orchestrator after a usage-limit interruption — until the limit's
 * reset (plus margin) or the fixed fallback — then resume. The `Effect.sleep`
 * is interruptible, so a Ctrl-C unwinds the wait promptly (like `pollSentinel`).
 * The pair of `usage_limit_backoff` / `usage_limit_resume` events lets `run.jsonl`
 * show the run pausing and resuming rather than reading as crashed; an
 * unparseable reset is logged loudly so a new dialog phrasing gets noticed.
 */
export const backOffForUsageLimit = (
  resetText: string,
): Effect.Effect<void, never, RunArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    const now = yield* Clock.currentTimeMillis;
    const { sleepMs, resetInstant } = usageLimitBackoffMs(resetText, now);

    if (resetInstant === null) {
      yield* Console.error(
        `  ⚠ usage-limit back-off: unrecognized reset format in ${JSON.stringify(resetText)} — ` +
          `pausing a fixed ${formatDuration(USAGE_LIMIT_BACKOFF_FALLBACK_MS)} instead. ` +
          `Add a case to session/usage-limit.ts for this phrasing.`,
      );
    }
    yield* Console.log(
      `\n⏸  Claude usage limit hit — pausing ${formatDuration(sleepMs)} before the next issue ` +
        `(resumes ~${new Date(now + sleepMs).toISOString()}).\n`,
    );
    yield* artifacts.logEvent({
      event: "usage_limit_backoff",
      resetText,
      parsed: resetInstant !== null,
      resetInstant,
      sleepMs,
      resumeAt: now + sleepMs,
    });
    yield* Effect.sleep(`${sleepMs} millis`);
    yield* artifacts.logEvent({ event: "usage_limit_resume", pausedMs: sleepMs });
  });

/**
 * Run one handler, then print and log the transition it produced.
 *
 * Exported for the machine seam test: it pins that an end-of-attempt's typed
 * `errorType` round-trips from the `step`-produced state onto the `transition`
 * event (the projection's input). Not part of the public driver — use
 * {@link runMachine}.
 */
export const advance = (
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
    // The typed cause of an end-of-attempt, machine-readable alongside `note`.
    // `null` for a successful transition or a failure with no typed cause.
    const errorType = "errorType" in next ? next.errorType : null;

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
      errorType,
    });

    // Persist where a resumed run should re-enter (#73). The decision is pure
    // (`checkpointAfter`); a write failure is best-effort inside the store.
    const checkpoint = checkpointAfter(state, next);
    if (checkpoint !== null && "issue" in next) {
      yield* writeCheckpoint(env.repoName, next.issue.iid, checkpoint);
    }

    // #78: a usage-limit interruption has now re-queued its issue (the claim is
    // released, ADR 0004's return-to-queue path) and `next` is `fetch_queue`.
    // Pause until the limit resets *before* the loop fetches the next issue,
    // instead of throwing the next session straight back into the same wall.
    if (state.kind === "interrupted" && state.usageLimitResetText !== null) {
      yield* backOffForUsageLimit(state.usageLimitResetText);
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
