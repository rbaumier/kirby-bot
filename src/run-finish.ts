/**
 * Run-finish.ts — the run_end seam: project the just-finished run once and fan
 * it out to both artifacts (#71 `summary.md`) and the Discord digest (#72).
 *
 * The transcript scan is the heavy part of analytics (see CLAUDE.md), so the
 * run.jsonl read and the cost scan happen exactly once here and feed both
 * outputs. Everything is best-effort: a failure (or a slow/absent cost scan)
 * degrades the report rather than aborting the run.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Clock, Effect, Option } from "effect";
import { type RunDigestNotification, notifyRunDigest } from "./notify/discord";
import { buildAnalyticsReport } from "./stats/aggregate";
import { projectRunFacts, type RunCostTotals, runStartedAtMs } from "./stats/summary";
import { writeSummaryFile } from "./stats/write-summary";

/** Cap the cost scan on this critical path; past it the report drops cost. */
const COST_SCAN_TIMEOUT = "30 seconds";

/** Gather run-level token/cost, or null (no window, slow scan, or failure). */
const gatherCost = (
  runDir: string,
  lines: readonly string[],
): Effect.Effect<RunCostTotals | null> =>
  Effect.gen(function* () {
    // No run window (empty / torn log) → skip the scan rather than fall back to
    // sinceMs=0, which would sweep every transcript since epoch.
    const sinceMs = runStartedAtMs(lines);
    if (sinceMs === null) {
      return null;
    }
    const now = yield* Clock.currentTimeMillis;
    const report = yield* Effect.tryPromise(() =>
      buildAnalyticsReport({ runsDir: dirname(runDir), sinceMs, untilMs: now }),
    ).pipe(Effect.timeout(COST_SCAN_TIMEOUT), Effect.option);
    return Option.isSome(report)
      ? { totalCostUsd: report.value.totalCostUsd, perModel: report.value.perModel }
      : null;
  });

/** Project the run facts into the run-level Discord digest. */
const toDigest = (
  runId: string,
  repo: string,
  lines: readonly string[],
  cost: RunCostTotals | null,
): RunDigestNotification => {
  const facts = projectRunFacts(lines);
  return {
    source: { repo, runId },
    durationMs: facts.durationMs,
    counts: facts.counts,
    totalCostUsd: cost?.totalCostUsd ?? null,
    actionable: facts.issues
      .filter((i) => i.fate === "failed" || i.fate === "stalled" || i.fate === "interrupted")
      .map((i) => ({ iid: i.iid, title: i.title, fate: i.fate })),
    merged: facts.issues
      .filter((i) => i.fate === "done")
      .map((i) => ({ iid: i.iid, title: i.title, pullRequestIid: i.pullRequestIid })),
  };
};

/**
 * Finish a run: write `summary.md` and push the single Discord digest, from one
 * read + one cost scan. Never fails the run.
 */
export const finishRun = (runDir: string, repo: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise(() =>
      readFile(join(runDir, "run.jsonl"), "utf8"),
    ).pipe(Effect.orElseSucceed(() => ""));
    const lines = text.split("\n").filter((line) => line !== "");
    if (lines.length === 0) {
      return;
    }
    const cost = yield* gatherCost(runDir, lines);
    const runId = basename(runDir);
    yield* writeSummaryFile(runDir, runId, lines, cost);
    yield* notifyRunDigest(toDigest(runId, repo, lines, cost));
  }).pipe(Effect.ignore);
