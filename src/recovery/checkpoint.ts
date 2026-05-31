/**
 * Recovery/checkpoint.ts — the cross-run Phase-resume checkpoint (impure fs).
 *
 * Records, per issue, the furthest Phase a prior attempt reached, so a resumed
 * run can skip past the work it already did instead of re-running it blind —
 * re-running `implementation` (capped at 180 min) is the waste this removes
 * (#73). One JSON per repository under `~/.afk-state/<repo>/checkpoints.json`,
 * keyed by issue iid, sitting beside the interruption sidecar (ADR 0004) and
 * sharing its contract: every fs failure is best-effort (a read that fails reads
 * as "no checkpoint", a write that fails is logged), so the whole surface has a
 * `never` error channel — a lost checkpoint costs at most one re-run, never a
 * crash.
 *
 * `machine.ts` writes the checkpoint after each transition into a resumable
 * Phase (the decision is `checkpointAfter` in `pipeline/resume.ts`);
 * `onBranchPush` reads it to decide whether to skip `implementation`, and
 * `onOpenDraftMr` reads it to route to the resumed Phase. `clearCheckpoint`
 * wipes it on `done`, on a parked Failure, and on a fresh start — the same
 * lifecycle as the sidecar, plus the fresh-start clear that keeps a recycled
 * branch name from skipping `implementation` (#73 invariant).
 *
 * Concurrency: like the sidecar, each mutation is a read-modify-write of the
 * whole per-repo map (atomic per file via temp + rename). Two co-located runs
 * working different issues can clobber each other's map last-writer-wins — the
 * same mono-host tradeoff `interruptions.json` already accepts (ADR 0004), made
 * rare by the random issue pick. A clobbered entry costs at most one re-run.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Console, Effect } from "effect";
import { STATE_DIR } from "../config";

/**
 * The Phase a resumed run re-enters. `open_draft_mr` is the "implementation
 * finished or salvaged" marker — its mere presence is what lets `onBranchPush`
 * skip `implementation`; the four interactive Phases are the finer resume
 * points. `merge` is deliberately absent: its state carries no `fixCycles`, and
 * a crash entering `merge` resumes from the prior `qa` / `evaluate` checkpoint
 * (both safe to re-run) and lands back on `merge`.
 */
export type ResumePhase = "open_draft_mr" | "review" | "evaluate" | "fix" | "qa";

/** One issue's resume checkpoint: where to re-enter, and the fix-cycle count. */
export type Checkpoint = {
  readonly phase: ResumePhase;
  readonly fixCycles: number;
};

/** All checkpoints for one repository, keyed by issue iid (as a string). */
type CheckpointsByIid = Record<string, Checkpoint>;

/** The checkpoint JSON path for a repository. */
const checkpointPath = (repoName: string): string =>
  join(STATE_DIR, repoName, "checkpoints.json");

/** Read the whole map; an unreadable/absent/corrupt file reads as empty. */
const readAll = (repoName: string): Effect.Effect<CheckpointsByIid> =>
  Effect.tryPromise(async () => {
    const path = checkpointPath(repoName);
    if (!existsSync(path)) {
      return {} as CheckpointsByIid;
    }
    return JSON.parse(await readFile(path, "utf8")) as CheckpointsByIid;
  }).pipe(Effect.catchAll(() => Effect.succeed({} as CheckpointsByIid)));

/** Write the whole map atomically (temp + rename); failures are logged, not fatal. */
const writeAll = (repoName: string, all: CheckpointsByIid): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    const path = checkpointPath(repoName);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2));
    await rename(tmp, path);
  }).pipe(
    Effect.catchAll((cause) =>
      Console.error(`  ⚠ checkpoint: could not persist ${repoName} — ${String(cause)}`),
    ),
  );

/** Read one issue's checkpoint, or `null` if it has none. */
export const readCheckpoint = (
  repoName: string,
  iid: number,
): Effect.Effect<Checkpoint | null> =>
  readAll(repoName).pipe(Effect.map((all) => all[String(iid)] ?? null));

/** Record `iid`'s resume checkpoint (last write wins). */
export const writeCheckpoint = (
  repoName: string,
  iid: number,
  checkpoint: Checkpoint,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const all = yield* readAll(repoName);
    yield* writeAll(repoName, { ...all, [String(iid)]: checkpoint });
  });

/** Forget `iid`'s checkpoint (it reached `done`, was parked, or started fresh). */
export const clearCheckpoint = (repoName: string, iid: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const all = yield* readAll(repoName);
    if (!(String(iid) in all)) {
      return;
    }
    const { [String(iid)]: _dropped, ...rest } = all;
    yield* writeAll(repoName, rest);
  });
