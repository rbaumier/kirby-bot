#!/usr/bin/env bun
/**
 * Review.ts — run kirby's review engine on an arbitrary diff, OUTSIDE the
 * orchestrator. The Standalone Review entry point (see CONTEXT.md).
 *
 * Contract: `(worktree, base) → findings JSON`. The caller (the `kirby-review`
 * skill) owns all the git — it materialises a dedicated throwaway worktree
 * positioned on the head of what's reviewed (a PR head, a commit) and picks the
 * base ref. This file is deliberately dumb: it never fetches, checks out, or
 * posts. It drives the same `readChangedFiles → runFanOutPhase →
 * aggregateFindings` path the `review` Phase wraps, but with no Provider, no
 * state machine, and a temp `RunArtifacts` (the seam the tests use).
 *
 * The engine is reused byte-identical: the desired BASE ref is passed as its
 * `defaultBranch` argument (every diff site is `git diff <base>...HEAD`), and a
 * synthetic `issueIid` (the PID) only seasons artifact slugs / tmux session
 * names — never a Provider lookup. The PID isolates concurrent invocations so
 * two standalone reviews don't collide on tmux session names.
 *
 *   review --worktree <dir> --base <ref> --out <path> [--budget-minutes <n>]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { BunRuntime } from "@effect/platform-bun";
import { Clock, Console, Data, Effect } from "effect";
import { PHASE_CAP_MINUTES } from "../src/config";
import { type AggregatedReview, aggregateFindings } from "../src/review/aggregate";
import { readChangedFiles } from "../src/review/read-changed-files";
import { RunArtifacts, RunArtifactsLive } from "../src/run-artifacts";
import { DEFAULT_MCP_CONFIG_PATH, DEFAULT_TEMPLATES_DIR, runFanOutPhase } from "../src/session/fanout";

/** The CLI was invoked with a missing or malformed argument. */
class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

/** Every review agent failed — there is no review to write. */
class ReviewSterile extends Data.TaggedError("ReviewSterile")<{ readonly message: string }> {}

type Args = {
  readonly worktree: string | null;
  readonly base: string | null;
  readonly out: string | null;
  readonly budgetMinutes: string | null;
};

/** Parse `process.argv` into {@link Args}. Plain — the effectful work is below. */
function parseArgs(argv: readonly string[]): Args {
  const KNOWN_FLAGS = new Set(["--worktree", "--base", "--out", "--budget-minutes"]);
  const flags = new Map<string, string>();
  for (const [index, flag] of argv.entries()) {
    if (KNOWN_FLAGS.has(flag)) {
      flags.set(flag, argv[index + 1] ?? "");
    }
  }
  return {
    worktree: flags.get("--worktree") ?? null,
    base: flags.get("--base") ?? null,
    out: flags.get("--out") ?? null,
    budgetMinutes: flags.get("--budget-minutes") ?? null,
  };
}

/** Require a flag to be present and non-empty. */
const requireFlag = (value: string | null, name: string): Effect.Effect<string, UsageError> =>
  value !== null && value !== ""
    ? Effect.succeed(value)
    : Effect.fail(new UsageError({ message: `missing required flag --${name}` }));

/**
 * Default the budget when absent, else require a positive finite number of
 * minutes. Without this, `Number("abc")` → NaN flows into the deadline and
 * silently degrades every agent to a timeout, surfacing as a misleading
 * "all agents failed" instead of the real usage error.
 */
const requireBudget = (value: string | null): Effect.Effect<number, UsageError> => {
  if (value === null) {
    return Effect.succeed(PHASE_CAP_MINUTES.review);
  }
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0
    ? Effect.succeed(minutes)
    : Effect.fail(
        new UsageError({ message: `--budget-minutes must be a positive number (got ${JSON.stringify(value)})` }),
      );
};

const program = Effect.gen(function* () {
  const args = parseArgs(process.argv.slice(2));
  const worktree = yield* requireFlag(args.worktree, "worktree");
  const base = yield* requireFlag(args.base, "base");
  const out = yield* requireFlag(args.out, "out");
  const budgetMinutes = yield* requireBudget(args.budgetMinutes);

  const artifacts = yield* RunArtifacts;
  // buildRunArtifacts computes the dir but does not create it; the engine
  // writes the full diff + per-agent slices into it, so it must exist first.
  yield* Effect.tryPromise(() => mkdir(artifacts.dir, { recursive: true }));

  const files = yield* readChangedFiles({ worktree, defaultBranch: base });

  // Empty diff is not a failure — it's "nothing changed between base and HEAD".
  // Write an empty review so the caller always has a file of the same shape.
  if (files.length === 0) {
    const empty: AggregatedReview = { agents: [], lineAnchoredFindings: [], proseFindings: [] };
    yield* Effect.tryPromise(() => writeFile(out, JSON.stringify(empty, null, 2)));
    yield* Console.log(`nothing to review: empty diff for ${base}...HEAD in ${worktree}`);
    return;
  }

  const now = yield* Clock.currentTimeMillis;
  const issueIid = process.pid;
  const fanOut = yield* runFanOutPhase({
    phase: "review",
    issueIid,
    iteration: 0,
    worktree,
    deadline: now + budgetMinutes * 60 * 1000,
    defaultBranch: base,
    files,
    templatesDir: DEFAULT_TEMPLATES_DIR,
    mcpConfigPath: DEFAULT_MCP_CONFIG_PATH,
  });

  // Distinct from "no findings": every agent failed (timeout / usage limit /
  // session error), so there is no review at all. Fail loudly rather than
  // writing an empty file the caller would read as a clean run.
  if (fanOut.okCount === 0) {
    return yield* Effect.fail(
      new ReviewSterile({ message: `all ${fanOut.totalCount} review agents failed — no findings produced` }),
    );
  }

  const review = yield* aggregateFindings(fanOut, { issueIid, iteration: 0 });
  yield* Effect.tryPromise(() => writeFile(out, JSON.stringify(review, null, 2)));

  const errored = review.agents.filter((a) => a.result === "error" || a.result === "wrote-nothing").length;
  yield* Console.log(
    `review complete: ${fanOut.okCount}/${fanOut.totalCount} agents ok` +
      `${errored > 0 ? ` (${errored} errored)` : ""} — ` +
      `${review.lineAnchoredFindings.length} line-anchored, ${review.proseFindings.length} prose findings → ${out}`,
  );
}).pipe(Effect.provide(RunArtifactsLive));

BunRuntime.runMain(program);
