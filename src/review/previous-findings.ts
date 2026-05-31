/**
 * Review/previous-findings.ts — build the `{previous_findings_block}` body.
 * Injected into each agent's prompt on re-review iterations by the fan-out
 * scaffold.
 *
 * **Why this exists.** Re-runs of the review fan-out (review[N], N>0) re-spawn
 * the same 15+ agents over the same diff. They re-flag findings already
 * triaged by `evaluate[N-1]`. The `evaluate` phase resolves the imagined ones;
 * the `fix` phase resolves the fixed ones. Both leave a visible trail on the
 * MR's discussions. Surfacing that trail into the next iteration's prompts
 * lets each agent self-filter without re-justifying every dropped finding.
 *
 * **What this is NOT.** We do not parse the body of `evaluate`'s replies —
 * the `evaluate.md` prompt does not constrain the reply format. A parser over
 * LLM prose is unstable. Instead, the GitLab-native `isResolved` flag is the
 * source of truth: a resolved thread = imagined OR fixed (both equivalent
 * from the next agent's standpoint: "do not re-flag"); an unresolved thread
 * = real-pending (already being fixed in this cycle).
 *
 * The block is shared across all agents — per-agent scoping is unnecessary.
 * Each agent already ignores out-of-scope lines via {@link agentScope}.
 */
import type { DiscussionSummary } from "../provider/types";
import { decodeFindingHeader, REVIEW_SUMMARY_FILE } from "./finding-header";

/** One parsed previous finding — the minimum needed to render the block line. */
type PreviousFinding = {
  readonly file: string;
  readonly line: number;
  readonly severity: string;
  readonly status: "resolved" | "unresolved";
};

/**
 * Parse the first note of a discussion. Returns `null` for the prose-summary
 * thread (synthetic `review-summary:0` location — not actionable as
 * "previously flagged") and for any non-line-anchored body.
 */
const parseDiscussion = (discussion: DiscussionSummary): PreviousFinding | null => {
  const firstNote = discussion.notes.at(0);
  if (firstNote === undefined) {
    return null;
  }
  const firstLine = firstNote.body.split("\n", 1)[0] ?? "";
  const header = decodeFindingHeader(firstLine);
  if (header === null) {
    return null;
  }
  if (header.file === REVIEW_SUMMARY_FILE) {
    return null;
  }
  return {
    file: header.file,
    line: header.line,
    severity: header.severity,
    status: discussion.isResolved ? "resolved" : "unresolved",
  };
};

/**
 * `buildPreviousFindingsBlock` — render the MR's existing discussions as a
 * prompt-pasteable instruction block for the next fan-out's agents.
 *
 * Returns the empty string when there is nothing to surface (first iteration,
 * or the MR has only prose-summary threads). An empty string is the same
 * sentinel the scaffold's `{previous_findings_block}` defaults to today, so
 * the caller can pass the return value through unconditionally.
 */
export const buildPreviousFindingsBlock = (
  discussions: readonly DiscussionSummary[],
): string => {
  const findings = discussions
    .map(parseDiscussion)
    .filter((finding): finding is PreviousFinding => finding !== null);
  if (findings.length === 0) {
    return "";
  }

  const lines = findings.map(
    (finding) =>
      `- ${finding.file}:${finding.line} [${finding.status}] (severity: ${finding.severity})`,
  );
  return [
    "## Previously raised on this MR — do NOT re-flag without new evidence",
    "",
    "These findings were posted on prior review iterations. A `resolved` thread",
    "was either dismissed by the evaluator as imagined, or already fixed. An",
    "`unresolved` thread is being fixed in this cycle. In every case: do not",
    "re-flag the same location unless the code there has materially changed.",
    "",
    ...lines,
  ].join("\n");
};
