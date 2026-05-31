/**
 * Recovery/lockfile.ts — the per-run PID liveness lock (mono-host).
 *
 * A live run writes one lockfile in its run dir holding `{ pid, startTime,
 * claimedIssueIid }` (ADR 0004). It is the *primary* signal the startup sweep
 * uses to tell a genuinely-orphaned `picked-by-agent` claim (the owning process
 * died — SIGTERM, `kill -9`, OOM) from one a sibling run still holds. Recovery
 * is then in seconds, at zero API cost, instead of waiting out the 4h30 age
 * sweep (`STALE_CLAIM_MS`, demoted to a last-ditch backstop).
 *
 * `startTime` is load-bearing, not decorative: on a single host the kernel
 * recycles PIDs, so a bare `kill -0` can hit an unrelated live process and make
 * a dead claim look alive forever. Pairing the pid with its start instant makes
 * the liveness check exact — a recycled pid has a different start time.
 *
 * Every fs/`ps` failure is best-effort: a lock that cannot be written/read/probed
 * resolves conservatively (write logs and moves on; an unreadable lock counts as
 * not-live; an unreadable runs dir flips `ok` so the sweep falls back to age).
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Console, Effect } from "effect";
import { RUNS_DIR } from "../config";

/** The lockfile's basename inside a run dir. */
export const LOCK_FILENAME = "lock.json";

/** A run's liveness lock: which process owns which claim right now. */
export type RunLock = {
  readonly pid: number;
  /** The process's wall-clock start instant (from `ps -o lstart=`), pinning the pid. */
  readonly startTime: string;
  /** The issue iid this run currently holds, or null between issues. */
  readonly claimedIssueIid: number | null;
};

/** A pid's wall-clock start string from `ps`, or null if the pid is dead/unknown. */
const processStartTime = (pid: number): Effect.Effect<string | null> =>
  Effect.tryPromise(async () => {
    const out = await $`ps -o lstart= -p ${pid}`.nothrow().text();
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

/** A lock is live iff its pid is still running with the same start time. */
const isAlive = (lock: RunLock): Effect.Effect<boolean> =>
  processStartTime(lock.pid).pipe(Effect.map((now) => now !== null && now === lock.startTime));

/**
 * Write (or update) this run's lockfile to claim `claimedIssueIid`. Called once
 * at run start with `null`, then by `onClaimIssue` *before* it labels the issue
 * `picked-by-agent`, so the lock always precedes the label a sweep would see.
 */
export const writeLock = (dir: string, claimedIssueIid: number | null): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pid = process.pid;
    const startTime = (yield* processStartTime(pid)) ?? "";
    const lock: RunLock = { pid, startTime, claimedIssueIid };
    yield* Effect.tryPromise(async () => {
      await mkdir(dir, { recursive: true });
      const path = join(dir, LOCK_FILENAME);
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(lock));
      await rename(tmp, path);
    }).pipe(
      Effect.catchAll((cause) =>
        Console.error(`  ⚠ lockfile: could not write ${dir} — ${String(cause)}`),
      ),
    );
  });

/** The iids partitioned by lock liveness across every run's lockfile. */
export type ScannedClaims = {
  /** Iids a *live* run still holds — never reaped. */
  readonly live: ReadonlySet<number>;
  /** Iids a *dead* lock (pid gone / start-time mismatch) once claimed — fast-reap. */
  readonly dead: ReadonlySet<number>;
};

/**
 * Scan `~/.afk-runs/​*​/lock.json` and partition the claimed iids by liveness.
 *
 * The sweep reaps a `picked-by-agent` claim when a *dead* lock once held it (a
 * crashed run — SIGTERM, `kill -9`, OOM: recovery in seconds), and leaves one
 * with no lock at all to the age sweep (it may belong to a pre-lockfile or
 * lockless live run). A *live* lock always protects its claim.
 *
 * Every fs/probe failure is swallowed: an unreadable runs dir / lock yields
 * empty sets, so the sweep simply falls back to the age heuristic.
 */
export const scanClaims: Effect.Effect<ScannedClaims> = Effect.gen(function* () {
  const entries = yield* Effect.tryPromise(() => readdir(RUNS_DIR)).pipe(
    Effect.catchAll(() => Effect.succeed([] as readonly string[])),
  );

  const live = new Set<number>();
  const dead = new Set<number>();
  for (const entry of entries) {
    const path = join(RUNS_DIR, entry, LOCK_FILENAME);
    if (!existsSync(path)) {
      continue;
    }
    const lock = yield* Effect.tryPromise(
      async () => JSON.parse(await readFile(path, "utf8")) as RunLock,
    ).pipe(Effect.catchAll(() => Effect.succeed(null as RunLock | null)));
    if (lock === null || lock.claimedIssueIid === null) {
      continue;
    }
    const alive = yield* isAlive(lock);
    (alive ? live : dead).add(lock.claimedIssueIid);
  }
  // A live lock anywhere wins over a stale dead one for the same iid.
  for (const iid of live) {
    dead.delete(iid);
  }
  return { live, dead };
});
