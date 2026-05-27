/**
 * Stats/events.ts — the shared contract for the two stats-bearing events.
 *
 * `run.jsonl` is the single source of truth (see ADR 0002). Most stats are
 * already derivable from the `transition` / `fanout_*` events the orchestrator
 * logs today; the one gap is per-Finding Triage. These two event shapes close
 * it, joined offline by the projection on `discussionId`, scoped per
 * `(issueIid, iteration)`:
 *
 *  - `review_findings` — logged by `post.ts` once it knows each posted thread's
 *    id; carries kirby-bot's authoritative Agent attribution.
 *  - `triage_results` — logged by `evaluatePhase` from the `triage.json` the
 *    evaluate session writes; carries the raw Triage per thread.
 *
 * This module is shared by both producers and the projection so the on-disk
 * shape has exactly one definition.
 */

/**
 * The evaluator's per-Finding judgment (CONTEXT.md: Triage). `real` /
 * `real-but-bloated-remedy` are accepted (left for `fix`); `imagined` is
 * rejected; `punt` is a `severity: suggestion` finding left for a human.
 * `unknown` is the tolerant fallback for an unparseable value.
 */
export type TriageValue =
  | "real"
  | "real-but-bloated-remedy"
  | "imagined"
  | "punt"
  | "unknown";

const KNOWN_TRIAGE: ReadonlySet<string> = new Set([
  "real",
  "real-but-bloated-remedy",
  "imagined",
  "punt",
]);

/** One review Finding mapped to the discussion thread it was posted as. */
export type ReviewFindingRow = {
  readonly discussionId: string;
  readonly agent: string;
  readonly file: string;
  readonly line: number;
  readonly severity: string;
};

/** The collapsed prose summary thread: one discussion, many Agents. */
export type ProseSummaryRow = {
  readonly discussionId: string;
  /** Per-Agent prose finding counts collapsed into the single summary thread. */
  readonly byAgent: ReadonlyArray<{ readonly agent: string; readonly count: number }>;
};

/** The `review_findings` event — one per review iteration that posted threads. */
export type ReviewFindingsEvent = {
  readonly event: "review_findings";
  readonly issueIid: number;
  readonly iteration: number;
  readonly findings: ReadonlyArray<ReviewFindingRow>;
  readonly prose?: ProseSummaryRow;
};

/** One evaluator Triage mapped to the discussion thread it judged. */
export type TriageRow = {
  readonly discussionId: string;
  readonly triage: TriageValue;
};

/** The `triage_results` event — one per evaluate iteration. */
export type TriageResultsEvent = {
  readonly event: "triage_results";
  readonly issueIid: number;
  readonly iteration: number;
  readonly triages: ReadonlyArray<TriageRow>;
};

/**
 * Parse the `triage.json` the evaluate session writes into `TriageRow[]`.
 *
 * Tolerant by design (mirrors `aggregate.ts`): the file is LLM-written, so a
 * missing field, an unknown triage value, or malformed JSON degrades the row
 * (or the whole file) to empty rather than failing the phase. A row with a
 * non-string `discussionId` is dropped; an unrecognized `triage` becomes
 * `"unknown"` so it still counts as a triaged thread.
 */
export const parseTriageFile = (content: string): TriageRow[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const rows: TriageRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { discussionId, triage } = entry as Record<string, unknown>;
    if (typeof discussionId !== "string" || discussionId === "") {
      continue;
    }
    rows.push({
      discussionId,
      triage: typeof triage === "string" && KNOWN_TRIAGE.has(triage) ? (triage as TriageValue) : "unknown",
    });
  }
  return rows;
};
