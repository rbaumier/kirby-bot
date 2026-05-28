#!/usr/bin/env bun
/**
 * Analytics.ts — all-in-one CLI that turns recent kirby-bot runs (and the
 * backing Claude session transcripts) into one self-contained HTML report.
 *
 * Usage:
 *   bun run scripts/analytics.ts                 # last 24h, writes ./kirby-analytics.html
 *   bun run scripts/analytics.ts --since 24h     # last 24h (alias of default)
 *   bun run scripts/analytics.ts --since 12h
 *   bun run scripts/analytics.ts --since 2026-05-27T20:00 --until 2026-05-28T07:00
 *   bun run scripts/analytics.ts --out night.html
 *   bun run scripts/analytics.ts --runs-dir /path/to/.afk-runs
 *
 * Read sources:
 *   - `<runs-dir>/<ts>-<id>/run.jsonl` + `findings-*.json`
 *   - `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl`
 *
 * Output: one HTML file. No external assets, opens straight in a browser.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAnalyticsReport } from "../src/stats/aggregate";
import { RUNS_DIR } from "../src/config";
import { renderAnalyticsHtml } from "../src/stats/html";

type Args = {
  sinceMs: number;
  untilMs: number;
  runsDir: string;
  outPath: string;
  includeTranscripts: boolean;
};

const DURATION_RE = /^(\d+)([smhd])$/;

const parseDurationAgo = (text: string, nowMs: number): number | null => {
  const m = DURATION_RE.exec(text);
  if (m === null) { return null; }
  const n = Number(m[1]);
  const unit = m[2];
  const scale =
    unit === "s" ? 1000
      : unit === "m" ? 60_000
      : unit === "h" ? 60 * 60_000
      : 24 * 60 * 60_000;
  return nowMs - n * scale;
};

const parseAbsoluteOrRelative = (text: string, nowMs: number): number | null => {
  const rel = parseDurationAgo(text, nowMs);
  if (rel !== null) { return rel; }
  const abs = Date.parse(text);
  return Number.isFinite(abs) ? abs : null;
};

const parseArgs = (argv: readonly string[]): Args => {
  const nowMs = Date.now();
  let sinceMs = nowMs - 24 * 60 * 60_000;
  let untilMs = nowMs;
  let runsDir = RUNS_DIR;
  let outPath = "kirby-analytics.html";
  let includeTranscripts = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case "--since": {
        if (next === undefined) { throw new Error("--since needs a value"); }
        const v = parseAbsoluteOrRelative(next, nowMs);
        if (v === null) { throw new Error(`--since: unparseable "${next}"`); }
        sinceMs = v;
        i += 1;
        break;
      }
      case "--until": {
        if (next === undefined) { throw new Error("--until needs a value"); }
        const v = parseAbsoluteOrRelative(next, nowMs);
        if (v === null) { throw new Error(`--until: unparseable "${next}"`); }
        untilMs = v;
        i += 1;
        break;
      }
      case "--runs-dir": {
        if (next === undefined) { throw new Error("--runs-dir needs a value"); }
        runsDir = resolve(next);
        i += 1;
        break;
      }
      case "--out": {
        if (next === undefined) { throw new Error("--out needs a value"); }
        outPath = resolve(next);
        i += 1;
        break;
      }
      case "--no-transcripts":
        includeTranscripts = false;
        break;
      case "--help":
      case "-h":
        console.error(
          [
            "Usage: bun run scripts/analytics.ts [--since 24h|<iso>] [--until <iso>]",
            "                                    [--runs-dir <path>] [--out <path>]",
            "                                    [--no-transcripts]",
            "",
            "Defaults: last 24h, runs from " + RUNS_DIR + ", out to kirby-analytics.html.",
          ].join("\n"),
        );
        process.exit(0);
      // ignore unknown so callers can chain flags through bun
    }
  }
  if (untilMs <= sinceMs) {
    throw new Error(`--until (${new Date(untilMs).toISOString()}) must be after --since (${new Date(sinceMs).toISOString()})`);
  }
  return { sinceMs, untilMs, runsDir, outPath, includeTranscripts };
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  console.error(
    `kirby-analytics: window ${new Date(args.sinceMs).toISOString()} → ${new Date(args.untilMs).toISOString()}`,
  );
  console.error(`kirby-analytics: runs-dir = ${args.runsDir}`);

  const report = await buildAnalyticsReport({
    runsDir: args.runsDir,
    sinceMs: args.sinceMs,
    untilMs: args.untilMs,
    includeTranscripts: args.includeTranscripts,
  });
  console.error(
    `kirby-analytics: ${report.runs.length} run(s), ${report.totalIssues} issue(s), ` +
      `${report.transcripts.length} transcript(s), total $${report.totalCostUsd.toFixed(2)}`,
  );

  const html = renderAnalyticsHtml(report);
  await writeFile(args.outPath, html);
  console.error(`kirby-analytics: wrote ${args.outPath} (${html.length} bytes)`);
};

await main();
