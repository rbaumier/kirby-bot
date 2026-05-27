/**
 * Stats.ts — CLI that prints statistics for one run.
 *
 * Usage:
 *   bun src/stats.ts                 # the most recent run under ~/.afk-runs/
 *   bun src/stats.ts <run-dir>       # a specific run directory
 *   bun src/stats.ts <path/run.jsonl>
 *
 * Pure read: it only parses an existing `run.jsonl` (ADR 0002). The fold and
 * the rendering live in `src/stats/` so they stay testable; this file is just
 * the entry point that locates the log and prints.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./config";
import { formatRunStats } from "./stats/format";
import { projectRunStats } from "./stats/project";

/** Most-recently-modified run directory under {@link RUNS_DIR}. */
const latestRunDir = (): string => {
  const dirs = readdirSync(RUNS_DIR)
    .map((name) => join(RUNS_DIR, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
  const latest = dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (latest === undefined) {
    throw new Error(`no runs found under ${RUNS_DIR}`);
  }
  return latest;
};

/** Resolve the CLI argument (a dir, a .jsonl file, or nothing) to a log path. */
const resolveLogPath = (arg: string | undefined): string => {
  if (arg === undefined) {
    return join(latestRunDir(), "run.jsonl");
  }
  return arg.endsWith(".jsonl") ? arg : join(arg, "run.jsonl");
};

const main = (): void => {
  const logPath = resolveLogPath(process.argv[2]);
  if (!existsSync(logPath)) {
    console.error(`run log not found: ${logPath}`);
    process.exit(1);
  }
  const lines = readFileSync(logPath, "utf8").split("\n");
  console.log(formatRunStats(projectRunStats(lines)));
};

if (import.meta.main) {
  main();
}
