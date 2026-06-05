/**
 * Retry.ts — the one transient-retry cadence shared by every kirby boundary.
 *
 * The HTTP runners (`gitlab/http.ts`, `github/http.ts`) and the shell-out
 * chokepoint (`shell.ts`) all retry transient failures with the same jittered
 * exponential backoff, capped at 3 attempts (1 try + 2 retries). They differ
 * only in the base delay — a contended `.git` clears slower than a network
 * blip — so each passes its own `base` and shares the shape. Single-sourcing
 * the cadence stops the copies from drifting (e.g. someone bumping `recurs` in
 * one place but not the others).
 */
import { type Duration, Schedule } from "effect";

/** Jittered exponential backoff, 3 attempts total (1 try + `recurs(2)`). */
export const transientSchedule = (base: Duration.DurationInput) =>
  Schedule.exponential(base).pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(2)));
