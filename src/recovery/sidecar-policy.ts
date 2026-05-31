/**
 * Recovery/sidecar-policy.ts — pure counting logic for the interruption sidecar.
 *
 * An issue that does not reach `done` is re-queued, and its re-queue history is
 * counted here so a poison issue eventually converts to a Failure instead of
 * looping forever (ADR 0004). Two counters per issue:
 *
 * - `consecutiveStalls` — Stalls in a row (the work consuming its budget without
 *   a verdict). Reset to zero by any non-Stall outcome. Caps at {@link STALL_CAP}.
 * - `totalRepicks` — every re-pick by any fate. The absolute backstop that bounds
 *   the uncapped-Interruption tail. Caps at {@link REPICK_CAP}.
 *
 * This module is the pure decision (counts in → counts out + park?), unit-tested
 * without the filesystem. The `sidecar.ts` glue persists it.
 */

/** The two per-issue counters. Absent issues start at {@link EMPTY_COUNTS}. */
export type IssueCounts = {
  readonly consecutiveStalls: number;
  readonly totalRepicks: number;
};

export const EMPTY_COUNTS: IssueCounts = { consecutiveStalls: 0, totalRepicks: 0 };

/** The outcome of recording a re-queue: the new counts and whether to park (→ Failure). */
export type Outcome = {
  readonly counts: IssueCounts;
  readonly park: boolean;
};

/**
 * Record a Stall: bump both counters. Park when consecutive Stalls reach the
 * Stall cap, or total re-picks reach the absolute backstop.
 */
export const recordStall = (
  prior: IssueCounts,
  stallCap: number,
  repickCap: number,
): Outcome => {
  const counts: IssueCounts = {
    consecutiveStalls: prior.consecutiveStalls + 1,
    totalRepicks: prior.totalRepicks + 1,
  };
  return { counts, park: counts.consecutiveStalls >= stallCap || counts.totalRepicks >= repickCap };
};

/**
 * Record an Interruption: reset the consecutive-Stall run to zero (an external
 * cut-off is not the issue's fault) but still bump the total — the absolute
 * backstop is the only thing rationing a persistently-interrupted issue.
 */
export const recordInterruption = (prior: IssueCounts, repickCap: number): Outcome => {
  const counts: IssueCounts = {
    consecutiveStalls: 0,
    totalRepicks: prior.totalRepicks + 1,
  };
  return { counts, park: counts.totalRepicks >= repickCap };
};
