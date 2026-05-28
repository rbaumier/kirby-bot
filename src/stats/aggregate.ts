/**
 * Stats/aggregate.ts — roll up many runs + their backing Claude transcripts
 * into one analytics snapshot.
 *
 * Inputs:
 *   - `~/.afk-runs/<ts>-<id>/run.jsonl` — kirby-bot event log
 *   - `~/.afk-runs/<ts>-<id>/findings-*.json` — raw reviewer dumps
 *   - `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl` — Claude session
 *     transcripts. Multiple per run (one per phase, plus per-review-agent fan-out).
 *
 * Output: one {@link AnalyticsReport} with totals + per-issue + per-agent +
 * per-model + per-session breakdowns, ready for HTML rendering.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readRunFindings, type FindingsDump } from "./findings-files";
import { modelTier, usageCostUsd, type ModelTier } from "./pricing";
import { projectRunStats, type RunStats } from "./project";
import { summarizeTranscriptFile, type TranscriptSummary } from "./transcripts";

/** One run dir + its parsed stats + findings dumps. */
export type RunSummary = {
  readonly runDir: string;
  readonly startedAtMs: number;
  readonly stats: RunStats;
  readonly findings: readonly FindingsDump[];
};

/** Per-agent rollup across the window. */
export type AgentRollup = {
  readonly agent: string;
  ran: number;
  ok: number;
  error: number;
  lineFindings: number;
  proseDumps: number;
  /** Sum across all dumps. */
  proseChars: number;
  accepted: number;
  rejected: number;
  punted: number;
  untriaged: number;
  /** Σ session totalMs from fanout_complete outcomes. */
  totalMs: number;
};

/** Per-model token + cost rollup. */
export type ModelRollup = {
  readonly tier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  costUsd: number;
};

/** Final report shape — feeds the HTML renderer. */
export type AnalyticsReport = {
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly runs: readonly RunSummary[];
  readonly agents: readonly AgentRollup[];
  readonly perModel: readonly ModelRollup[];
  readonly transcripts: readonly TranscriptSummary[];
  readonly totalCostUsd: number;
  readonly totalIssues: number;
  readonly issuesDone: number;
  readonly issuesFailed: number;
  readonly issuesIncomplete: number;
};

const safeStat = async (path: string): Promise<{ mtimeMs: number } | null> => {
  try { return await stat(path); } catch { return null; }
};

const inWindow = (mtimeMs: number, sinceMs: number, untilMs: number): boolean =>
  mtimeMs >= sinceMs && mtimeMs <= untilMs;

/** Discover run dirs touched within [since, until]. */
const findRunsInWindow = async (
  runsDir: string,
  sinceMs: number,
  untilMs: number,
): Promise<string[]> => {
  let entries: string[];
  try { entries = await readdir(runsDir); } catch { return []; }
  const matches: string[] = [];
  for (const name of entries) {
    const path = join(runsDir, name);
    const st = await safeStat(path);
    if (st !== null && inWindow(st.mtimeMs, sinceMs, untilMs)) { matches.push(path); }
  }
  return matches.toSorted();
};

/** Load one run dir: parse run.jsonl + walk findings files. */
const loadRun = async (runDir: string): Promise<RunSummary | null> => {
  const jsonlPath = join(runDir, "run.jsonl");
  let text: string;
  try { text = await readFile(jsonlPath, "utf8"); } catch { return null; }
  const lines = text.split("\n").filter((l) => l !== "");
  const stats = projectRunStats(lines);
  const st = await safeStat(jsonlPath);
  const findings = await readRunFindings(runDir);
  return {
    runDir,
    startedAtMs: st?.mtimeMs ?? 0,
    stats,
    findings,
  };
};

/** Discover Claude session transcripts touched within [since, until]. */
const findTranscriptsInWindow = async (
  sinceMs: number,
  untilMs: number,
): Promise<string[]> => {
  const projectsRoot = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try { dirs = await readdir(projectsRoot); } catch { return []; }
  const matches: string[] = [];
  for (const name of dirs) {
    const dir = join(projectsRoot, name);
    let files: string[];
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) { continue; }
      const path = join(dir, file);
      const st = await safeStat(path);
      if (st !== null && inWindow(st.mtimeMs, sinceMs, untilMs)) { matches.push(path); }
    }
  }
  return matches;
};

const emptyAgentRollup = (agent: string): AgentRollup => ({
  agent,
  ran: 0,
  ok: 0,
  error: 0,
  lineFindings: 0,
  proseDumps: 0,
  proseChars: 0,
  accepted: 0,
  rejected: 0,
  punted: 0,
  untriaged: 0,
  totalMs: 0,
});

const emptyModelRollup = (tier: ModelTier): ModelRollup => ({
  tier,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
});

const rollupAgents = (runs: readonly RunSummary[]): AgentRollup[] => {
  const map = new Map<string, AgentRollup>();
  const getRollup = (name: string): AgentRollup => {
    const existing = map.get(name);
    if (existing !== undefined) { return existing; }
    const fresh = emptyAgentRollup(name);
    map.set(name, fresh);
    return fresh;
  };
  for (const run of runs) {
    for (const issue of run.stats.issues) {
      for (const agent of issue.agents) {
        const r = getRollup(agent.agent);
        r.ran += agent.ran;
        r.ok += agent.ok;
        r.error += agent.error;
        r.totalMs += agent.totalMs;
        r.lineFindings += agent.findings;
        r.accepted += agent.accepted;
        r.rejected += agent.rejected;
        r.punted += agent.punted;
        r.untriaged += agent.untriaged;
      }
    }
    for (const dump of run.findings) {
      if (dump.proseChars > 0) {
        const r = getRollup(dump.agent);
        r.proseDumps += 1;
        r.proseChars += dump.proseChars;
      }
    }
  }
  return [...map.values()].toSorted((a, b) => (b.lineFindings + b.proseDumps) - (a.lineFindings + a.proseDumps));
};

const rollupModels = (transcripts: readonly TranscriptSummary[]): ModelRollup[] => {
  const map = new Map<ModelTier, ModelRollup>();
  const ensure = (tier: ModelTier): ModelRollup => {
    const existing = map.get(tier);
    if (existing !== undefined) { return existing; }
    const fresh = emptyModelRollup(tier);
    map.set(tier, fresh);
    return fresh;
  };
  for (const t of transcripts) {
    for (const u of t.perModel) {
      const r = ensure(u.tier);
      r.inputTokens += u.inputTokens;
      r.outputTokens += u.outputTokens;
      r.cacheCreation5mTokens += u.cacheCreation5mTokens;
      r.cacheCreation1hTokens += u.cacheCreation1hTokens;
      r.cacheReadTokens += u.cacheReadTokens;
      r.costUsd += usageCostUsd(u);
    }
  }
  return [...map.values()].toSorted((a, b) => b.costUsd - a.costUsd);
};

const isAfkTranscript = (t: TranscriptSummary): boolean =>
  (t.cwd ?? "").includes(".afk-worktrees") ||
  (t.cwd ?? "").includes("kirby-bot");

/** Build the full {@link AnalyticsReport} for a date range. */
export const buildAnalyticsReport = async (input: {
  readonly runsDir: string;
  readonly sinceMs: number;
  readonly untilMs: number;
  /** When false, transcript scanning is skipped (test/perf escape). */
  readonly includeTranscripts?: boolean;
}): Promise<AnalyticsReport> => {
  const { runsDir, sinceMs, untilMs } = input;
  const runDirs = await findRunsInWindow(runsDir, sinceMs, untilMs);
  const runs: RunSummary[] = [];
  for (const dir of runDirs) {
    const summary = await loadRun(dir);
    if (summary !== null) { runs.push(summary); }
  }

  const transcripts: TranscriptSummary[] = [];
  if (input.includeTranscripts !== false) {
    const paths = await findTranscriptsInWindow(sinceMs, untilMs);
    const summaries = await Promise.all(paths.map(summarizeTranscriptFile));
    for (const s of summaries) {
      if (s !== null && isAfkTranscript(s)) { transcripts.push(s); }
    }
  }
  transcripts.sort((a, b) => (b.costUsd) - (a.costUsd));

  const agents = rollupAgents(runs);
  const perModel = rollupModels(transcripts);
  const totalCostUsd = perModel.reduce((sum, m) => sum + m.costUsd, 0);

  let totalIssues = 0;
  let issuesDone = 0;
  let issuesFailed = 0;
  let issuesIncomplete = 0;
  for (const run of runs) {
    for (const issue of run.stats.issues) {
      totalIssues += 1;
      if (issue.terminal === "done") { issuesDone += 1; }
      else if (issue.terminal === "failed") { issuesFailed += 1; }
      else { issuesIncomplete += 1; }
    }
  }

  return {
    sinceMs,
    untilMs,
    runs,
    agents,
    perModel,
    transcripts,
    totalCostUsd,
    totalIssues,
    issuesDone,
    issuesFailed,
    issuesIncomplete,
  };
};
