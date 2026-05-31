/**
 * Stats/write-summary.ts — write `summary.md` from already-gathered run facts.
 *
 * The read + cost-scan happens once in `run-finish.ts` and feeds both this
 * writer and the Discord digest; this module only renders and writes. Wrapped
 * so a failure can never abort the run.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Console, Effect } from "effect";
import { renderRunSummary, type RunCostTotals } from "./summary";

/** Write `<runDir>/summary.md`. Never fails — logs and swallows any error. */
export const writeSummaryFile = (
  runDir: string,
  runId: string,
  lines: readonly string[],
  cost: RunCostTotals | null,
): Effect.Effect<void> =>
  Effect.tryPromise(() =>
    writeFile(join(runDir, "summary.md"), renderRunSummary({ runId, lines, cost })),
  ).pipe(
    Effect.tapError((cause) =>
      Console.error(`[summary] write failed: ${String(cause)}`),
    ),
    Effect.ignore,
  );
