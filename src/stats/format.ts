/**
 * Stats/format.ts — render {@link RunStats} as a plain-text report for the CLI.
 *
 * Kept separate from the projection so the fold stays pure and testable; this
 * module only turns the computed numbers into lines.
 */
import { formatDuration } from "../duration";
import type { AgentStats, IssueStats, RunStats } from "./project";

const pad = (text: string, width: number): string => text.padEnd(width);
const padNum = (value: number, width: number): string => String(value).padStart(width);

const agentLine = (agent: AgentStats): string => {
  const reliability = agent.error > 0 ? `${agent.ok}ok/${agent.error}err` : `${agent.ok}ok`;
  return (
    `    ${pad(agent.agent, 22)} ` +
    `${padNum(agent.findings, 3)} found  ` +
    `${padNum(agent.accepted, 3)} acc  ${padNum(agent.rejected, 3)} rej  ` +
    `${padNum(agent.punted, 3)} punt  ${padNum(agent.untriaged, 3)} untr  ` +
    `${pad(reliability, 9)} ${formatDuration(agent.totalMs)}`
  );
};

const issueBlock = (issue: IssueStats): string => {
  const lines: string[] = [];
  const terminal =
    issue.terminal === "failed" && issue.failureReason !== undefined
      ? `failed (${issue.failureReason})`
      : issue.terminal;
  lines.push(
    `#${issue.iid} "${issue.title}" — ${formatDuration(issue.totalMs)}  ` +
      `[${terminal}, ${issue.fixCycles} fix-cycle(s), dogfood: ${issue.dogfood}]`,
  );

  const phases = issue.phaseDurations
    .map((phase) => `${phase.phase} ${formatDuration(phase.ms)}`)
    .join("  ");
  if (phases !== "") {
    lines.push(`  phases: ${phases}`);
  }

  if (issue.agents.length > 0) {
    lines.push("  agents:");
    for (const agent of issue.agents) {
      lines.push(agentLine(agent));
    }
  }

  for (const snapshot of issue.routing) {
    const skipped = snapshot.skipped.length > 0 ? `, skipped ${snapshot.skipped.join("/")}` : "";
    const truncated = snapshot.routerTruncated ? ", router-truncated" : "";
    const dogfood = snapshot.dogfoodRequired ? `, dogfood[${snapshot.dogfoodSurfaces.join("/")}]` : "";
    lines.push(
      `  routing[iter ${snapshot.iteration}]: ${snapshot.routed.length} routed` +
        `${skipped}${truncated}` +
        `, boundaries=${snapshot.trustBoundaries.length}${dogfood}`,
    );
  }

  return lines.join("\n");
};

/** Render the whole run as a multi-line report. */
export const formatRunStats = (stats: RunStats): string => {
  const header =
    stats.repo === undefined
      ? "Run stats"
      : `Run stats — ${stats.repo} (${stats.defaultBranch ?? "?"})`;
  if (stats.issues.length === 0) {
    return `${header}\n(no issues processed)`;
  }
  return [header, ...stats.issues.map(issueBlock)].join("\n\n");
};
