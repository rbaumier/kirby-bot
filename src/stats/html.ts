/**
 * Stats/html.ts — render an {@link AnalyticsReport} as one self-contained HTML.
 *
 * No external assets, no JS framework. The styling is inlined; sections are
 * plain `<section>` blocks. Designed for "open in browser" first, but the
 * markup degrades cleanly when piped to lynx / Reader mode.
 */
import { formatDuration } from "../duration";
import type { AgentRollup, AnalyticsReport, ModelRollup, RunSummary } from "./aggregate";
import type { TranscriptSummary } from "./transcripts";

const escape = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const fmtUsd = (v: number): string => `$${v.toFixed(2)}`;
const fmtPct = (num: number, den: number): string =>
  den === 0 ? "—" : `${((num / den) * 100).toFixed(0)}%`;
const fmtInt = (n: number): string => n.toLocaleString("en-US");
const fmtDate = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

const STYLE = `
  body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1200px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 28px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 15px; margin: 16px 0 6px; color: #444; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 4px 8px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
  th { font-weight: 600; color: #555; background: #fafafa; position: sticky; top: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .badge-done   { background: #d3f9d8; color: #2b8a3e; }
  .badge-failed { background: #ffe3e3; color: #c92a2a; }
  .badge-incomplete { background: #fff3bf; color: #8a6d00; }
  .tier-opus   { background: #f3d9fa; color: #862e9c; }
  .tier-sonnet { background: #d0ebff; color: #1864ab; }
  .tier-haiku  { background: #e6fcf5; color: #087f5b; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin: 12px 0; }
  .card { border: 1px solid #e6e6e6; border-radius: 6px; padding: 10px 12px; }
  .card-label { font-size: 11px; color: #777; text-transform: uppercase; letter-spacing: 0.04em; }
  .card-value { font-size: 20px; font-weight: 600; margin-top: 2px; }
  .small { color: #888; font-size: 12px; }
  details { margin: 8px 0; }
  summary { cursor: pointer; font-weight: 600; }
`;

const renderHeader = (report: AnalyticsReport): string =>
  `<header>
    <h1>kirby-bot analytics</h1>
    <div class="meta">
      window: <strong>${escape(fmtDate(report.sinceMs))}</strong> →
      <strong>${escape(fmtDate(report.untilMs))}</strong> ·
      ${report.runs.length} run(s) · ${report.transcripts.length} Claude session(s)
    </div>
  </header>`;

const renderTotals = (report: AnalyticsReport): string => {
  const cards = [
    { label: "Total cost", value: fmtUsd(report.totalCostUsd) },
    { label: "Issues done", value: `${report.issuesDone} / ${report.totalIssues}` },
    { label: "Issues failed", value: String(report.issuesFailed) },
    { label: "Issues incomplete", value: String(report.issuesIncomplete) },
    { label: "Reviewers active", value: String(report.agents.length) },
  ];
  return `<section><h2>Totals</h2><div class="cards">${cards
    .map((c) => `<div class="card"><div class="card-label">${escape(c.label)}</div><div class="card-value">${escape(c.value)}</div></div>`)
    .join("")}</div></section>`;
};

const tierBadge = (tier: string): string =>
  `<span class="badge tier-${escape(tier)}">${escape(tier)}</span>`;

const cacheHitPct = (m: ModelRollup): string => {
  const totalIn = m.inputTokens + m.cacheCreation5mTokens + m.cacheCreation1hTokens + m.cacheReadTokens;
  return fmtPct(m.cacheReadTokens, totalIn);
};

const renderModels = (report: AnalyticsReport): string => {
  if (report.perModel.length === 0) {
    return `<section><h2>Cost by model</h2><p class="small">No Claude transcripts in window.</p></section>`;
  }
  const rows = report.perModel
    .map((m) =>
      `<tr>
        <td>${tierBadge(m.tier)}</td>
        <td class="num">${fmtInt(m.inputTokens)}</td>
        <td class="num">${fmtInt(m.outputTokens)}</td>
        <td class="num">${fmtInt(m.cacheCreation5mTokens)}</td>
        <td class="num">${fmtInt(m.cacheCreation1hTokens)}</td>
        <td class="num">${fmtInt(m.cacheReadTokens)}</td>
        <td class="num">${cacheHitPct(m)}</td>
        <td class="num"><strong>${fmtUsd(m.costUsd)}</strong></td>
      </tr>`,
    )
    .join("");
  return `<section><h2>Cost by model</h2>
    <table>
      <thead><tr>
        <th>tier</th>
        <th class="num">input</th>
        <th class="num">output</th>
        <th class="num">cache-5m</th>
        <th class="num">cache-1h</th>
        <th class="num">cache-read</th>
        <th class="num">cache-hit%</th>
        <th class="num">cost</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></section>`;
};

const renderAgents = (report: AnalyticsReport): string => {
  if (report.agents.length === 0) {
    return `<section><h2>Reviewers</h2><p class="small">No reviewer activity in window.</p></section>`;
  }
  const rows = report.agents
    .map((a: AgentRollup) =>
      `<tr>
        <td>${escape(a.agent)}</td>
        <td class="num">${a.ran}</td>
        <td class="num">${a.ok}</td>
        <td class="num">${a.error}</td>
        <td class="num">${a.lineFindings}</td>
        <td class="num">${a.proseDumps}</td>
        <td class="num">${a.accepted}</td>
        <td class="num">${a.rejected}</td>
        <td class="num">${a.punted}</td>
        <td class="num">${formatDuration(a.totalMs)}</td>
      </tr>`,
    )
    .join("");
  return `<section><h2>Reviewers</h2>
    <p class="small">line = line-anchored findings (posted as GitLab thread). prose = number of prose-only dumps written.</p>
    <table>
      <thead><tr>
        <th>agent</th>
        <th class="num">ran</th>
        <th class="num">ok</th>
        <th class="num">err</th>
        <th class="num">line</th>
        <th class="num">prose</th>
        <th class="num">accept</th>
        <th class="num">reject</th>
        <th class="num">punt</th>
        <th class="num">wall-clock</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></section>`;
};

const issueRows = (run: RunSummary): string =>
  run.stats.issues
    .map((issue) =>
      `<tr>
        <td><strong>#${issue.iid}</strong></td>
        <td>${escape(issue.title)}</td>
        <td><span class="badge badge-${escape(issue.terminal)}">${escape(issue.terminal)}</span></td>
        <td class="num">${formatDuration(issue.totalMs)}</td>
        <td class="num">${issue.fixCycles}</td>
        <td>${escape(issue.qa)}</td>
        <td class="num">${issue.agents.length}</td>
      </tr>`,
    )
    .join("");

const renderRuns = (report: AnalyticsReport): string => {
  if (report.runs.length === 0) {
    return `<section><h2>Runs</h2><p class="small">No runs in window.</p></section>`;
  }
  const blocks = report.runs
    .map((run) =>
      `<details open>
        <summary>${escape(run.runDir.split("/").pop() ?? run.runDir)} — ${run.stats.issues.length} issue(s) · ${escape(run.stats.repo ?? "?")}</summary>
        <table>
          <thead><tr>
            <th>iid</th><th>title</th><th>status</th>
            <th class="num">wall</th><th class="num">fix</th>
            <th>qa</th><th class="num">agents</th>
          </tr></thead>
          <tbody>${issueRows(run)}</tbody>
        </table>
      </details>`,
    )
    .join("");
  return `<section><h2>Runs</h2>${blocks}</section>`;
};

const transcriptRow = (t: TranscriptSummary): string => {
  const dur = t.firstTs !== null && t.lastTs !== null ? formatDuration(t.lastTs - t.firstTs) : "—";
  const models = t.perModel.map((u) => `${u.tier}`).join(", ") || "—";
  const branch = t.gitBranch ?? "";
  const tail = (t.path.split("/").pop() ?? "").replace(".jsonl", "");
  return `<tr>
    <td>${escape(fmtDate(t.firstTs ?? 0))}</td>
    <td class="num">${escape(dur)}</td>
    <td>${escape(models)}</td>
    <td>${escape(branch)}</td>
    <td class="num"><strong>${fmtUsd(t.costUsd)}</strong></td>
    <td class="small">${escape(tail.slice(0, 12))}</td>
  </tr>`;
};

const renderTopTranscripts = (report: AnalyticsReport): string => {
  if (report.transcripts.length === 0) {
    return `<section><h2>Top Claude sessions by cost</h2><p class="small">No transcripts in window.</p></section>`;
  }
  const top = report.transcripts.slice(0, 30);
  const rows = top.map(transcriptRow).join("");
  return `<section><h2>Top Claude sessions by cost</h2>
    <p class="small">Top ${top.length} of ${report.transcripts.length} sessions.</p>
    <table>
      <thead><tr>
        <th>started</th>
        <th class="num">wall</th>
        <th>models</th>
        <th>branch</th>
        <th class="num">cost</th>
        <th>session</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></section>`;
};

/** The whole report → one HTML string. */
export const renderAnalyticsHtml = (report: AnalyticsReport): string =>
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>kirby-bot analytics — ${escape(fmtDate(report.sinceMs))} → ${escape(fmtDate(report.untilMs))}</title>
  <style>${STYLE}</style>
</head>
<body>
${renderHeader(report)}
${renderTotals(report)}
${renderModels(report)}
${renderAgents(report)}
${renderRuns(report)}
${renderTopTranscripts(report)}
</body>
</html>
`;
