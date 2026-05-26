/**
 * Duration.ts — compact human-readable duration formatting.
 *
 * Effect's `Duration.format` ships a different style (`"1m 5s"`, `"4s 200ms"`)
 * that breaks the single-line transition logs this is for — kept as a bespoke
 * compact form (`"1m05s"`, `"4.2s"`, `"850ms"`).
 */

/** Render a millisecond duration as a compact human string (`1m05s`, `4.2s`). */
export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
};
