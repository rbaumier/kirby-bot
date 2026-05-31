/**
 * Review/finding-header.ts — the single Module that owns the textual encoding
 * of a posted **Finding**'s discussion header.
 *
 * Every review **Finding** posted to an MR opens its first note with the line
 * `severity: <severity> | <file>:<line>`. That line is the contract the next
 * iteration re-reads to self-filter (see `previous-findings.ts`). Before this
 * Module the format was *written* in `post.ts` by string concatenation and
 * *re-parsed* in `previous-findings.ts` by a private regex — a convention
 * dispersed across two files with no shared schema, so a change to one side
 * broke the other silently (the regex returns `null`, the Finding disappears
 * with no error and no log).
 *
 * Here the format lives in one place: {@link encodeFindingHeader} writes it,
 * {@link decodeFindingHeader} reads it, and `decode∘encode` round-trips. The
 * synthetic prose-summary location is a named value ({@link REVIEW_SUMMARY_LOCATION})
 * rather than a magic string repeated on both sides.
 */

/** A decoded finding header — the minimum the format carries. */
export type FindingHeader = {
  readonly severity: string;
  readonly file: string;
  readonly line: number;
};

/**
 * Synthetic file used for the single prose-summary discussion thread. Not a
 * real path: `previous-findings.ts` recognises it to skip the summary thread
 * when surfacing prior findings, and `post.ts` writes it as the summary's
 * location. Named here so both ends reference one constant.
 */
export const REVIEW_SUMMARY_FILE = "review-summary";

/** The full synthetic location for the prose-summary thread (`review-summary:0`). */
export const REVIEW_SUMMARY_LOCATION: FindingHeader = {
  severity: "suggestion",
  file: REVIEW_SUMMARY_FILE,
  line: 0,
};

/** The first line of every posted finding follows this shape. */
const HEADER_RE = /^severity:\s+(\S+)\s+\|\s+(\S+):(\d+)\s*$/;

/** Encode a finding header into its first-note line. */
export const encodeFindingHeader = (header: FindingHeader): string =>
  `severity: ${header.severity} | ${header.file}:${header.line}`;

/**
 * Decode a finding-header line. Returns `null` for any line that does not match
 * the format (a non-line-anchored body, a prose paragraph, an empty string) —
 * the caller treats that as "not a previously-flagged finding".
 */
export const decodeFindingHeader = (line: string): FindingHeader | null => {
  const match = HEADER_RE.exec(line);
  if (match === null) {
    return null;
  }
  const [, severity, file, lineStr] = match;
  if (severity === undefined || file === undefined || lineStr === undefined) {
    return null;
  }
  return { severity, file, line: Number(lineStr) };
};
