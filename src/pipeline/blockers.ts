/**
 * Pipeline/blockers.ts — read "Blocked by #N" dependency markers from issue text.
 *
 * Neither forge gives kirby-bot a portable native dependency signal: GitHub's
 * issue-dependencies are a 2025 beta (GraphQL-only) and GitLab's "blocked by"
 * links are Premium-only. So the orchestrator reads the convention authors
 * already type by hand — e.g.
 *
 *   "Blocked by #867 (filtered list endpoint), itself blocked by #855 (model)"
 *
 * Only the raw `#N` form is recognized (the source both forges store when an
 * author types `#867`); an explicit markdown link like `[#867](…)` is not — it
 * is vanishingly rare in hand-written bodies. `onFetchQueue` holds a dependent
 * issue out of the random pick until every blocker it names is closed (see
 * src/pipeline/handlers/queue.ts).
 */

/** Introduces a blocker reference: "blocked by" / "bloqué(e)(s) par". */
const BLOCKER_MARKER = /blocked by|bloqu[eé]e?s? par/gi;

/**
 * The run of `#N` references a marker may introduce: one or more `#123`,
 * separated by commas, semicolons, "&", or "and"/"et". Anchored at the start of
 * the post-marker slice, so an unrelated `#42` elsewhere in the text is never
 * read as a blocker. The run is greedy across separators: `"blocked by #1 and
 * #99 are done"` reads BOTH #1 and #99 — every `#N` introduced by the marker
 * counts, even when prose continues after it. That errs on the fail-safe side
 * (an extra blocker over-waits; it never lets dependent work start early).
 */
const BLOCKER_RUN = /^[\s:]*((?:#\d+\s*(?:[,;&]|and|et)?\s*)+)/i;

/**
 * Extract the distinct issue numbers a text marks as blockers, in first-seen
 * order. Recognizes the English "blocked by" and French "bloqué par" markers,
 * case-insensitively. Out-of-range ids (non-positive or beyond safe-integer)
 * are dropped. Text with no marker — or a marker followed by no `#N` — yields
 * an empty list.
 *
 * @example
 *   parseBlockers("Blocked by #867, itself blocked by #855") // => [867, 855]
 *   parseBlockers("See #5 for context")                      // => []
 */
export const parseBlockers = (text: string): readonly number[] => {
  const out: number[] = [];
  const seen = new Set<number>();
  // `matchAll` iterates a private clone of the global regex, so there is no
  // shared `lastIndex` to reset between calls.
  for (const marker of text.matchAll(BLOCKER_MARKER)) {
    const run = BLOCKER_RUN.exec(text.slice(marker.index + marker[0].length));
    if (run === null) continue;
    for (const digits of (run[1] ?? "").match(/\d+/g) ?? []) {
      const iid = Number.parseInt(digits, 10);
      if (Number.isSafeInteger(iid) && iid > 0 && !seen.has(iid)) {
        seen.add(iid);
        out.push(iid);
      }
    }
  }
  return out;
};
