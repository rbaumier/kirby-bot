/**
 * Deadline.ts — mint the per-issue wall-clock budget.
 *
 * One issue shares a single `deadline` across all its Phases. It is minted when
 * the attempt's first Phase starts — `implementation` on a fresh run, or
 * `open_draft_mr` when a resume skips `implementation` (#73). Both call this, so
 * the "each resume mints a new budget" rule (CONTEXT.md, Stall) lives in one
 * place rather than being duplicated at two call sites.
 */
import { Clock, Effect } from "effect";
import { ISSUE_BUDGET_MS } from "./config";
import type { Deadline } from "./pipeline/state";

/** A fresh per-issue deadline: the current instant plus the issue budget. */
export const freshDeadline: Effect.Effect<Deadline> = Clock.currentTimeMillis.pipe(
  Effect.map((now) => now + ISSUE_BUDGET_MS),
);
