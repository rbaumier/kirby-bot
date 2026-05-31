/**
 * Stats/summary.ts — render a single run's `run.jsonl` into a standalone
 * markdown report (#71).
 *
 * Pure function over the log's lines: per-issue structure comes from
 * {@link projectRunStats}; the wall-clock window and the 4-way terminal fate
 * (done / failed / stalled / interrupted — the projection collapses the last
 * two into "incomplete") come from a single extra scan here.
 *
 * Token/cost is **run-level only**: Claude transcripts carry no issue id, so
 * per-issue attribution is impossible. When totals are unavailable the report
 * renders "—" and the footer documents the limit rather than hiding it.
 */
import { formatDuration } from "../duration";
import { projectRunStats } from "./project";

export type Fate = "done" | "failed" | "stalled" | "interrupted" | "incomplete";

/** One issue's run-level facts, folded from the log. */
export type RunFactIssue = {
  readonly iid: number;
  readonly title: string;
  readonly fate: Fate;
  readonly totalMs: number;
  readonly fixCycles: number;
  /** PR/MR iid this issue opened, or null when none was logged. */
  readonly pullRequestIid: number | null;
};

/**
 * The structured facts of one run — the shared projection behind both the
 * markdown report (#71) and the Discord digest (#72). Pure over the log lines.
 */
export type RunFacts = {
  readonly repo: string | undefined;
  readonly defaultBranch: string | undefined;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly durationMs: number | null;
  readonly counts: Record<Fate, number>;
  readonly issues: readonly RunFactIssue[];
};

/** Run-level token/cost totals (from transcripts); null when unavailable. */
export type RunCostTotals = {
  readonly totalCostUsd: number;
  readonly perModel: readonly {
    readonly tier: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly costUsd: number;
  }[];
};

const fmtUsd = (v: number): string => `$${v.toFixed(2)}`;
const fmtInt = (n: number): string => n.toLocaleString("en-US");
const fmtDate = (ms: number): string =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 16);

const TERMINAL_FATES = new Set<string>([
  "done",
  "failed",
  "stalled",
  "interrupted",
]);
const FATE_ORDER: readonly Fate[] = [
  "done",
  "failed",
  "stalled",
  "interrupted",
  "incomplete",
];

type LogScan = {
  startedAtMs: number | null;
  endedAtMs: number | null;
  fateByIid: Map<number, Fate>;
};

/** One pass over the log for the run window and per-issue terminal fate. */
const scanLog = (lines: readonly string[]): LogScan => {
  let startedAtMs: number | null = null;
  let endedAtMs: number | null = null;
  const fateByIid = new Map<number, Fate>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at =
      typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    if (!Number.isNaN(at)) {
      if (startedAtMs === null) {
        startedAtMs = at;
      }
      endedAtMs = at;
    }
    if (parsed.event === "transition") {
      const to = typeof parsed.to === "string" ? parsed.to : undefined;
      const issue = parsed.issue as { iid?: unknown } | null | undefined;
      const iid = typeof issue?.iid === "number" ? issue.iid : undefined;
      if (to !== undefined && iid !== undefined && TERMINAL_FATES.has(to)) {
        fateByIid.set(iid, to as Fate);
      }
    }
  }
  return { startedAtMs, endedAtMs, fateByIid };
};

/** First event timestamp in the log, or null when none parse with an `at`. */
export const runStartedAtMs = (lines: readonly string[]): number | null =>
  scanLog(lines).startedAtMs;

const emptyCounts = (): Record<Fate, number> => ({
  done: 0,
  failed: 0,
  stalled: 0,
  interrupted: 0,
  incomplete: 0,
});

/** Fold a run's log lines into the structured {@link RunFacts}. */
export const projectRunFacts = (lines: readonly string[]): RunFacts => {
  const stats = projectRunStats(lines);
  const { startedAtMs, endedAtMs, fateByIid } = scanLog(lines);
  const counts = emptyCounts();
  const issues = stats.issues.map((issue): RunFactIssue => {
    // No terminal transition for this iid → still mid-flight (incomplete);
    // projection's terminal (done | failed | incomplete) is already a Fate.
    const fate = fateByIid.get(issue.iid) ?? issue.terminal;
    counts[fate] += 1;
    return {
      iid: issue.iid,
      title: issue.title,
      fate,
      totalMs: issue.totalMs,
      fixCycles: issue.fixCycles,
      pullRequestIid: issue.pullRequestIid ?? null,
    };
  });
  return {
    repo: stats.repo,
    defaultBranch: stats.defaultBranch,
    startedAtMs,
    endedAtMs,
    durationMs:
      startedAtMs !== null && endedAtMs !== null ? endedAtMs - startedAtMs : null,
    counts,
    issues,
  };
};

const issueRow = (issue: RunFactIssue): string =>
  // Tokens and cost are "—" by design (no per-issue attribution); see footer.
  `| #${issue.iid} | ${issue.title || "—"} | ${issue.fate} | ${formatDuration(issue.totalMs)} | ${issue.fixCycles} | ${issue.pullRequestIid != null ? `#${issue.pullRequestIid}` : "—"} | — | — |`;

const costSection = (cost: RunCostTotals | null): string => {
  if (cost === null || cost.perModel.length === 0) {
    return [
      "## Tokens & coût (run)",
      "",
      "_Aucun transcript Claude trouvé pour la fenêtre du run._",
      "",
      "**Total : —**",
    ].join("\n");
  }
  const rows = cost.perModel.map(
    (m) =>
      `| ${m.tier} | ${fmtInt(m.inputTokens)} | ${fmtInt(m.outputTokens)} | ${fmtInt(m.cacheReadTokens)} | ${fmtUsd(m.costUsd)} |`,
  );
  return [
    "## Tokens & coût (run)",
    "",
    "| modèle | input | output | cache read | coût |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows,
    `| **Total** | | | | **${fmtUsd(cost.totalCostUsd)}** |`,
  ].join("\n");
};

const LIMITS = [
  "> **Limites de ce rapport**",
  "> - Coût/tokens **par issue** non attribués : les transcripts Claude ne portent pas l'iid de l'issue. Seul le total du run est disponible.",
  "> - La colonne **MR** montre l'iid de la PR/MR, pas une URL cliquable (le host n'est pas dans `run.jsonl`).",
  "> - Le total agrège tous les transcripts AFK de la fenêtre `[début, fin]` du run ; un run concurrent serait compté ensemble.",
].join("\n");

/** Render a run's log lines as a standalone markdown report. */
export const renderRunSummary = (input: {
  readonly runId: string;
  readonly lines: readonly string[];
  readonly cost: RunCostTotals | null;
}): string => {
  const { runId, lines, cost } = input;
  const facts = projectRunFacts(lines);
  const countsLine = FATE_ORDER.map((f) => `${facts.counts[f]} ${f}`).join(", ");

  const issueTable =
    facts.issues.length === 0
      ? "_Aucune issue traitée dans ce run._"
      : [
          "| iid | titre | fate | durée | fix cycles | MR | tokens | coût |",
          "| --- | --- | --- | --- | ---: | --- | ---: | ---: |",
          ...facts.issues.map(issueRow),
        ].join("\n");

  return [
    `# Run summary — ${facts.repo ?? "?"} (${facts.defaultBranch ?? "?"})`,
    "",
    `- **Run ID :** ${runId}`,
    `- **Date :** ${facts.startedAtMs !== null ? fmtDate(facts.startedAtMs) : "—"}`,
    `- **Durée totale :** ${facts.durationMs !== null ? formatDuration(facts.durationMs) : "—"}`,
    `- **Issues :** ${facts.issues.length} — ${countsLine}`,
    "",
    "## Issues",
    "",
    issueTable,
    "",
    costSection(cost),
    "",
    LIMITS,
    "",
  ].join("\n");
};
