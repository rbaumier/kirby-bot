/**
 * Recovery/sidecar.ts — the cross-run interruption sidecar (impure fs).
 *
 * Persists the per-issue re-queue counters that `sidecar-policy.ts` decides on,
 * one JSON per repository under `~/.afk-state/<repo>/interruptions.json`, keyed
 * by issue iid (ADR 0004). The `step` seam calls `recordStall` /
 * `recordInterruption` when an attempt ends without `done`, and reads the
 * returned `park` flag to decide whether to re-queue the issue or convert it to
 * a Failure. `clearIssue` wipes an issue's history once it reaches `done` or is
 * parked, so a later legitimate re-pick starts clean.
 *
 * The pure decision lives in `./sidecar-policy.ts`; this module is the glue.
 * Every fs failure is best-effort: a read that fails reads as "no history", a
 * write that fails is logged and the in-memory outcome is still returned — a
 * lost counter bump costs at most one extra re-pick, never a crash. The whole
 * surface therefore has a `never` error channel.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Console, Effect } from "effect";
import { REPICK_CAP, STALL_CAP, STATE_DIR } from "../config";
import {
  EMPTY_COUNTS,
  recordInterruption as policyRecordInterruption,
  recordStall as policyRecordStall,
} from "./sidecar-policy";
import type { IssueCounts, Outcome } from "./sidecar-policy";

/** All counters for one repository, keyed by issue iid (as a string). */
type CountsByIid = Record<string, IssueCounts>;

/** The sidecar JSON path for a repository. */
const sidecarPath = (repoName: string): string =>
  join(STATE_DIR, repoName, "interruptions.json");

/** Read the whole sidecar map; an unreadable/absent/corrupt file reads as empty. */
const readAll = (repoName: string): Effect.Effect<CountsByIid> =>
  Effect.tryPromise(async () => {
    const path = sidecarPath(repoName);
    if (!existsSync(path)) {
      return {} as CountsByIid;
    }
    return JSON.parse(await readFile(path, "utf8")) as CountsByIid;
  }).pipe(Effect.catchAll(() => Effect.succeed({} as CountsByIid)));

/** Write the whole sidecar map atomically (temp + rename); failures are logged, not fatal. */
const writeAll = (repoName: string, all: CountsByIid): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    const path = sidecarPath(repoName);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2));
    await rename(tmp, path);
  }).pipe(
    Effect.catchAll((cause) =>
      Console.error(`  ⚠ sidecar: could not persist ${repoName} counters — ${String(cause)}`),
    ),
  );

/** Read one issue's counters, defaulting to {@link EMPTY_COUNTS}. */
const countsFor = (all: CountsByIid, iid: number): IssueCounts =>
  all[String(iid)] ?? EMPTY_COUNTS;

/** Apply a policy step to one issue, persist the result, return its outcome. */
const record = (
  repoName: string,
  iid: number,
  step: (prior: IssueCounts) => Outcome,
): Effect.Effect<Outcome> =>
  Effect.gen(function* () {
    const all = yield* readAll(repoName);
    const outcome = step(countsFor(all, iid));
    yield* writeAll(repoName, { ...all, [String(iid)]: outcome.counts });
    return outcome;
  });

/** Record a Stall for `iid`; returns the new counts and whether to park (→ Failure). */
export const recordStall = (repoName: string, iid: number): Effect.Effect<Outcome> =>
  record(repoName, iid, (prior) => policyRecordStall(prior, STALL_CAP, REPICK_CAP));

/** Record an Interruption for `iid`; returns the new counts and whether to park. */
export const recordInterruption = (repoName: string, iid: number): Effect.Effect<Outcome> =>
  record(repoName, iid, (prior) => policyRecordInterruption(prior, REPICK_CAP));

/** Forget `iid`'s re-queue history (it reached `done` or was parked into a Failure). */
export const clearIssue = (repoName: string, iid: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const all = yield* readAll(repoName);
    if (!(String(iid) in all)) {
      return;
    }
    const { [String(iid)]: _dropped, ...rest } = all;
    yield* writeAll(repoName, rest);
  });
