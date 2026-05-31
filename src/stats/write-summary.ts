/**
 * Stats/write-summary.ts — best-effort `summary.md` write at run_end (#71).
 *
 * Reads the run's `run.jsonl`, reuses {@link buildAnalyticsReport} for the
 * run-level token/cost totals (window = first event → now), renders the
 * markdown via {@link renderRunSummary}, and writes `summary.md` next to the
 * log. Every step is wrapped so a failure can never abort the run.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Clock, Console, Effect, Option } from "effect";
import { buildAnalyticsReport } from "./aggregate";
import {
  type RunCostTotals,
  renderRunSummary,
  runStartedAtMs,
} from "./summary";

/** Write `<runDir>/summary.md`. Never fails — logs and swallows any error. */
export const writeRunSummary = (runDir: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const logPath = join(runDir, "run.jsonl");
    const text = yield* Effect.tryPromise(() => readFile(logPath, "utf8"));
    const lines = text.split("\n").filter((line) => line !== "");

    // No run window (empty / torn log) → skip the cost scan rather than fall
    // back to sinceMs=0, which would sweep every transcript since epoch.
    const sinceMs = runStartedAtMs(lines);
    let cost: RunCostTotals | null = null;
    if (sinceMs !== null) {
      const now = yield* Clock.currentTimeMillis;
      // The transcript scan is the heavy part of analytics (see CLAUDE.md).
      // Cap it at 30s on this critical path: a slow/failed scan degrades the
      // report to its cost-less form rather than stalling run_end.
      const report = yield* Effect.tryPromise(() =>
        buildAnalyticsReport({ runsDir: dirname(runDir), sinceMs, untilMs: now }),
      ).pipe(Effect.timeout("30 seconds"), Effect.option);
      if (Option.isSome(report)) {
        cost = {
          totalCostUsd: report.value.totalCostUsd,
          perModel: report.value.perModel,
        };
      }
    }

    const markdown = renderRunSummary({ runId: basename(runDir), lines, cost });
    yield* Effect.tryPromise(() =>
      writeFile(join(runDir, "summary.md"), markdown),
    );
  }).pipe(
    Effect.tapError((cause) =>
      Console.error(`[summary] write failed: ${String(cause)}`),
    ),
    Effect.ignore,
  );
