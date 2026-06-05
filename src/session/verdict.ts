/**
 * Session/verdict.ts — the strict contract for phase session outcomes.
 *
 * A phase session ends its final assistant message with a strict
 * last line `VERDICT: <TOKEN>`. The Stop hook captures that whole
 * message into the sentinel; the orchestrator reads the sentinel
 * and calls `parseVerdict`.
 *
 * Pure — no Effect, no I/O — so it can be unit-tested exhaustively.
 */

/** Every terminal verdict a phase session may declare. */
export const VERDICT_TOKENS = [
  "READY_FOR_REVIEW",
  "BLOCKER_SUSPECTED",
  "PLAN_DONE",
  "REVIEW_DONE",
  "CONVERGED",
  "NEEDS_FIX",
  "FIX_DONE",
  "QA_PASS",
  "QA_FAIL",
  "AGENT_DONE",
  "ROUTING_DONE",
] as const;

export type VerdictToken = (typeof VERDICT_TOKENS)[number];

/** Set lookup for O(1) membership checks without type narrowing issues. */
const VERDICT_TOKEN_SET: ReadonlySet<string> = new Set(VERDICT_TOKENS);

/** Type predicate: narrows a string to a known verdict token. */
const isVerdictToken = (value: string): value is VerdictToken => VERDICT_TOKEN_SET.has(value);

/** A line is a verdict line iff it is exactly `VERDICT: ` + an uppercase token. */
const VERDICT_LINE = /^VERDICT: ([A-Z_]+)$/;

/**
 * Strip leading/trailing markdown emphasis chars (`*`, `_`) from a line.
 * Models routinely render the verdict as `**VERDICT: TOKEN**` despite the
 * prompt asking for plain text. Treating the emphasis wrappers as cosmetic
 * lets the strict regex match what was clearly meant as a verdict.
 */
const stripEmphasis = (line: string): string => line.replace(/^[*_]+|[*_]+$/g, "");

/**
 * Tokens carried by every line of the verdict shape `VERDICT: <TOKEN>` (after
 * stripping markdown emphasis and surrounding whitespace), in document order.
 * Token *validity* is deliberately NOT checked here — `VERDICT: DONE` yields
 * `["DONE"]` — so the strict {@link parseVerdict} and the lenient
 * {@link containsVerdictLine} share one line scanner.
 */
const verdictLineTokens = (message: string): readonly string[] =>
  message
    .split("\n")
    .map((line) => VERDICT_LINE.exec(stripEmphasis(line.trim())))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] ?? "");

/**
 * Extract the verdict a session declared, or `null` if none found.
 *
 * Strict on the *line* (still no substring scan into prose), lenient on
 * *placement*. A loose substring scan would false-match prose like "not
 * yet READY_FOR_REVIEW" — a false *proceed* is far worse than a false
 * *fail*. A verdict counts only when ALL of these hold:
 *
 *  - Exactly one line (after stripping markdown emphasis wrappers like
 *    `**` / `__`) matches `VERDICT: <KNOWN_TOKEN>` and nothing else.
 *    Zero or two+ is ambiguous → `null`.
 *  - The token is one of the known {@link VERDICT_TOKENS}.
 *
 * The verdict line is **not** required to be the last non-empty line:
 * models often append a "MR !613 opened" pleasantry after the verdict
 * despite the prompt forbidding it. As long as the verdict line itself
 * is well-formed and unique, that trailing prose is harmless.
 *
 * `null` means the caller must treat the session as failed.
 */
export function parseVerdict(message: string): VerdictToken | null {
  const tokens = verdictLineTokens(message);

  // Exactly one verdict line, or it is ambiguous and we refuse to guess.
  if (tokens.length !== 1) {
    return null;
  }

  const token = tokens.at(0);
  return token !== undefined && isVerdictToken(token) ? token : null;
}

/**
 * True iff `message` carries at least one line of the verdict shape
 * `VERDICT: <TOKEN>`, regardless of whether the token is a known
 * {@link VERDICT_TOKENS} member.
 *
 * The Stop hook uses this to pick *which* assistant message to capture: an
 * agent that declares its verdict and then keeps talking — opens the MR,
 * appends a summary, emits content-less closing turns — must not have that
 * verdict clobbered by the verdict-less trailing message. Surfacing even a
 * malformed `VERDICT: DONE` (rather than silently dropping it) lets
 * {@link parseVerdict} reject the bad token and the orchestrator reprompt for
 * a valid one.
 */
export function containsVerdictLine(message: string): boolean {
  return verdictLineTokens(message).length > 0;
}
