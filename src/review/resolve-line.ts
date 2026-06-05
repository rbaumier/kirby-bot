/**
 * Review/resolve-line.ts — deterministic, LLM-free positioning of line-anchored
 * findings via the verbatim snippet the evidence gate forces into
 * `analysis_chain[0]`.
 *
 * A line-anchored finding carries a `{ file, line }` *reported by the Agent*.
 * That line number is the Agent's count and drifts: an off-by-N, or a count
 * against the full file when the MR only exposes the diff, anchors the
 * discussion on the wrong line — or fails to anchor at all when the target
 * line isn't part of the diff. We never trust it on its own.
 *
 * The scaffold's evidence gate already pins `analysis_chain[0]` to the
 * offending code *verbatim* (`assets/code-review-templates/_line-anchored-scaffold.md`):
 * a backtick-quoted snippet copied from the file the Agent read. This module
 * matches that snippet against the new-side lines of the Agent's own diff
 * slice and recomputes the real line number — exactly the position-accuracy
 * trick `alibaba/open-code-review` uses (`internal/diff/resolver.go`), minus
 * their LLM relocation fallback (cut from scope: measure the match rate first).
 *
 * Pure and deterministic: no I/O, no Effect, no LLM. The caller
 * ({@link aggregateFindings}) reads the slice files off disk and feeds the
 * content in.
 *
 * Policy on "no match": a finding whose snippet is genuinely absent from the
 * diff is degraded to a non-anchored note rather than dropped — consistent with
 * *findings over > under*. A mispositioned finding is still a finding; we
 * re-attach it to a consolidated note instead of throwing it away.
 */
import type { AgentName } from "./agents";
import type { LineAnchoredFinding, ParsedLineFinding } from "./aggregate";

/**
 * Outcome of resolving one finding's snippet against its diff slice.
 *  - `resolved` — snippet matched a unique (or closest tie-broken) new-side
 *    line; `line` is the real diff line number.
 *  - `unmatched` — the finding's file IS in the diff but the snippet matches no
 *    new-side line. The offending code is out-of-diff (or removed): degrade to
 *    a note, don't anchor.
 *  - `kept` — can't resolve (no quotable snippet, or the file isn't in the
 *    slice at all). Keep the reported line and stay anchored — a missing or
 *    truncated slice must not silently degrade every finding.
 */
export type LineMatch =
  | { readonly kind: "resolved"; readonly line: number }
  | { readonly kind: "unmatched" }
  | { readonly kind: "kept" };

/** One finding whose resolved line differs from the line the Agent reported. */
export type DriftRecord = {
  readonly agent: AgentName;
  readonly file: string;
  readonly title: string;
  readonly reportedLine: number;
  readonly resolvedLine: number;
};

/** Aggregate measurement of one resolution pass — emitted as a run event. */
export type ResolutionStats = {
  readonly total: number;
  /** Findings whose snippet matched a new-side line. */
  readonly resolved: number;
  /** Subset of `resolved` whose matched line differed from the reported line. */
  readonly drifted: number;
  /** Findings degraded to a note (file in diff, snippet absent). */
  readonly unmatched: number;
  readonly drifts: readonly DriftRecord[];
};

/** One new-side line of a diff: its new-file line number and stripped text. */
type NewLine = { readonly line: number; readonly text: string };

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff into its new-side lines (added + context) per file,
 * keyed by the `+++ b/<path>` header (`b/` stripped, `/dev/null` skipped).
 *
 * Robust to body lines that look like headers: `+++ `/`--- ` are only treated
 * as file headers outside a hunk body (`!inHunk`), so an added line whose
 * content happens to start with `++ ` is classified as content, not a header.
 */
const parseNewSide = (diff: string): Map<string, NewLine[]> => {
  const byFile = new Map<string, NewLine[]>();
  let current: NewLine[] | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      current = null;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      if (path === "/dev/null") {
        current = null;
      } else {
        const file = path.startsWith("b/") ? path.slice(2) : path;
        current = [];
        byFile.set(file, current);
      }
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = HUNK_RE.exec(raw);
      if (match !== null) {
        newLine = Number(match[1]);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk || current === null) {
      continue;
    }
    // Hunk body — classify by the column-0 prefix char.
    if (raw.startsWith("+")) {
      current.push({ line: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith(" ")) {
      current.push({ line: newLine, text: raw.slice(1) });
      newLine++;
    }
    // `-` (removed → not new-side, no increment), `\` (no-newline marker),
    // and `` (blank separator) are skipped.
  }
  return byFile;
};

/**
 * Extract the verbatim code from an `analysis_chain[0]` bullet. The scaffold
 * format is `` `code` — commentary ``: take the first backtick span and drop
 * the trailing prose. A fenced block (```` ``` ````) wins over an inline span
 * so multi-line snippets survive. No backticks → the Agent didn't quote → "".
 */
const extractCode = (bullet: string): string => {
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(bullet);
  if (fence !== null) {
    return fence[1] ?? "";
  }
  const inline = /`([^`]+)`/.exec(bullet);
  return inline !== null ? (inline[1] ?? "") : "";
};

/**
 * Normalize one line for matching: strip a stray leading `+` (a diff prefix the
 * Agent may have copied), collapse internal whitespace runs, trim. Applied to
 * both the snippet and the diff text so indentation drift doesn't block a match.
 */
const normalize = (line: string): string =>
  line.replace(/^\+/, "").replace(/\s+/g, " ").trim();

/**
 * `resolveLine` — match one finding's verbatim snippet against the new-side
 * lines of its diff slice and recompute the real line number. See
 * {@link LineMatch} for the three outcomes.
 */
export const resolveLine = (input: {
  readonly file: string;
  readonly snippet: string;
  readonly reportedLine: number;
  readonly diff: string;
}): LineMatch => {
  const code = extractCode(input.snippet);
  const snippetLines = code.split("\n").map(normalize).filter((s) => s.length > 0);
  if (snippetLines.length === 0) {
    return { kind: "kept" }; // no quotable snippet → fall back to the reported line
  }

  const newLines = parseNewSide(input.diff).get(input.file);
  if (newLines === undefined || newLines.length === 0) {
    return { kind: "kept" }; // file absent from the slice → can't resolve, don't degrade
  }

  const normed = newLines.map((nl) => ({ line: nl.line, text: normalize(nl.text) }));
  const runLen = snippetLines.length;
  const matches: number[] = [];
  for (let i = 0; i + runLen <= normed.length; i++) {
    let ok = true;
    for (let k = 0; k < runLen; k++) {
      if (normed[i + k]!.text !== snippetLines[k]) {
        ok = false;
        break;
      }
      // Multi-line run must be contiguous in the file (no hunk-boundary jump).
      if (k > 0 && normed[i + k]!.line !== normed[i + k - 1]!.line + 1) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(normed[i]!.line);
    }
  }

  if (matches.length === 0) {
    return { kind: "unmatched" }; // file in diff, snippet not found → degrade to note
  }
  if (matches.length === 1) {
    return { kind: "resolved", line: matches[0]! };
  }
  // Ambiguous: the snippet appears more than once. Pick the line closest to the
  // Agent's reported line — deterministic, and the Agent's guess is the best
  // available tie-break.
  const best = matches.reduce((a, b) =>
    Math.abs(b - input.reportedLine) < Math.abs(a - input.reportedLine) ? b : a,
  );
  return { kind: "resolved", line: best };
};

/**
 * `applyResolutions` — resolve every parsed finding against its emitting
 * Agent's diff slice, stamping the final `anchored` flag and (when resolved)
 * the corrected line. Returns the finalized findings plus drift measurement.
 *
 * Pure: the caller supplies each Agent's diff slice content via `diffByAgent`.
 * A missing entry (`?? ""`) yields `kept` for every one of that Agent's
 * findings — they stay anchored on their reported line.
 */
export const applyResolutions = (
  findings: readonly ParsedLineFinding[],
  diffByAgent: ReadonlyMap<AgentName, string>,
): { readonly findings: readonly LineAnchoredFinding[]; readonly stats: ResolutionStats } => {
  let resolved = 0;
  let drifted = 0;
  let unmatched = 0;
  const drifts: DriftRecord[] = [];

  const out = findings.map((finding): LineAnchoredFinding => {
    const match = resolveLine({
      file: finding.file,
      snippet: finding.analysisChain[0] ?? "",
      reportedLine: finding.line,
      diff: diffByAgent.get(finding.agent) ?? "",
    });
    if (match.kind === "resolved") {
      resolved++;
      if (match.line !== finding.line) {
        drifted++;
        drifts.push({
          agent: finding.agent,
          file: finding.file,
          title: finding.title,
          reportedLine: finding.line,
          resolvedLine: match.line,
        });
      }
      return { ...finding, line: match.line, anchored: true };
    }
    if (match.kind === "unmatched") {
      unmatched++;
      return { ...finding, anchored: false };
    }
    return { ...finding, anchored: true }; // kept
  });

  return {
    findings: out,
    stats: { total: findings.length, resolved, drifted, unmatched, drifts },
  };
};
