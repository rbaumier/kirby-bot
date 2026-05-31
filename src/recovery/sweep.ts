/**
 * Recovery/sweep.ts — the startup crash-recovery sweep (impure shell).
 *
 * A run that dies mid-pipeline (crash, timeout, SIGTERM, `kill -9`, OOM) leaves
 * its issue labelled `picked-by-agent`. The queue read filters that label out, so
 * the issue is stranded — every later launch ends `fetch_queue → end` with no
 * work (#35). This sweep runs once at startup and returns those orphans to the
 * queue as Interruptions (ADR 0004).
 *
 * Liveness is decided by the per-run PID lockfile (`./lockfile.ts`): a claim a
 * *live* run still holds is left alone; one a *dead* lock once held is reaped in
 * seconds; one with no lock at all falls back to the `STALE_CLAIM_MS` age sweep
 * (it may belong to a pre-lockfile or lockless live run). Recovering an orphan
 * also records it in the interruption sidecar (resetting the consecutive-Stall
 * count and bumping the total re-pick count), so the in-band cap and the sweep
 * agree on one history; past the absolute re-pick backstop the sweep parks the
 * issue as a Failure instead of looping it.
 *
 * The pure decisions live in `./stale.ts` / `./sidecar-policy.ts`; this module is
 * the glue. Every failure here is best-effort — recovery must never abort a run,
 * so the whole sweep resolves to `void`. A persistent provider outage surfaces
 * fatally at the `fetch_queue` read that follows, not here.
 */
import { $ } from "bun";
import { Clock, Console, Effect } from "effect";
import { LABELS, STALE_CLAIM_MS } from "../config";
import type { Environment } from "../preflight";
import { GitProvider } from "../provider/provider";
import { describeProviderError } from "../provider/types";
import type { Issue } from "../provider/types";
import { RunArtifacts } from "../run-artifacts";
import { runShell } from "../shell";
import { scanClaims } from "./lockfile";
import { clearIssue, recordInterruption } from "./sidecar";
import { selectStale, worktreePathsForIssue } from "./stale";
import type { ClaimedIssue } from "./stale";

/** Remove every orphan worktree belonging to `iid`, given a porcelain listing. */
const removeWorktreesForIssue = (porcelain: string, iid: number): Effect.Effect<void> =>
  Effect.forEach(
    worktreePathsForIssue(porcelain, iid),
    (path) => runShell(() => $`git worktree remove --force ${path}`).pipe(Effect.ignore),
    { discard: true },
  );

/** Swap an orphan's labels; a provider failure is logged to console + JSONL, never fatal. */
const swapLabels = (
  iid: number,
  add: readonly string[],
  remove: readonly string[],
  successEvent: string,
  successLine: string,
): Effect.Effect<void, never, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const artifacts = yield* RunArtifacts;
    yield* provider.updateIssueLabels(iid, { add: [...add], remove: [...remove] }).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const detail = describeProviderError(error);
          return Console.error(`  ⚠ recovery: could not reclaim #${iid}: ${detail}`).pipe(
            Effect.zipRight(
              artifacts.logEvent({ event: "stale_claim_recover_failed", issue: iid, error: detail }),
            ),
          );
        },
        onSuccess: () =>
          Console.log(successLine).pipe(
            Effect.zipRight(artifacts.logEvent({ event: successEvent, issue: iid })),
          ),
      }),
    );
  });

/** Post the orphan's audit note (with the worktree link to resume from); never fatal. */
const postOrphanNote = (
  iid: number,
  header: string,
  worktree: string | null,
): Effect.Effect<void, never, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const artifacts = yield* RunArtifacts;
    const note = [
      header,
      "",
      `- Run log: \`${artifacts.logPath}\``,
      worktree === null ? null : `- Worktree (left for inspection): \`${worktree}\``,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    yield* provider
      .addIssueNote(iid, note)
      .pipe(Effect.catchAll(() => Console.error(`  ⚠ recovery: could not note #${iid}`)));
  });

/**
 * Recover one orphaned claim as an Interruption. Records it in the sidecar; past
 * the absolute re-pick backstop the issue parks as a Failure (its worktree left
 * for inspection), otherwise it returns to the queue with its orphan worktree
 * cleaned up.
 */
const recoverOrphan = (
  claim: ClaimedIssue,
  porcelain: string,
  env: Environment,
): Effect.Effect<void, never, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const worktree = worktreePathsForIssue(porcelain, claim.iid).at(0) ?? null;
    const outcome = yield* recordInterruption(env.repoName, claim.iid);

    if (outcome.park) {
      yield* postOrphanNote(
        claim.iid,
        `**AFK gave up** — re-picked ${outcome.counts.totalRepicks}× without finishing (recovered orphan)`,
        worktree,
      );
      yield* swapLabels(
        claim.iid,
        [LABELS.failedByAgent],
        [LABELS.pickedByAgent, LABELS.readyForAgent],
        "stale_claim_parked",
        `  ⨯ #${claim.iid} re-picked ${outcome.counts.totalRepicks}× — parked as failed-by-agent`,
      );
      yield* clearIssue(env.repoName, claim.iid);
      return;
    }

    yield* removeWorktreesForIssue(porcelain, claim.iid);
    yield* postOrphanNote(
      claim.iid,
      `**AFK interrupted** — returned to queue (recovered orphan, attempt ${outcome.counts.totalRepicks + 1})`,
      worktree,
    );
    yield* swapLabels(
      claim.iid,
      [LABELS.readyForAgent],
      [LABELS.pickedByAgent],
      "stale_claim_recovered",
      `  ↻ recovered stale claim on #${claim.iid} — returned to queue`,
    );
  });

/**
 * Find orphaned `picked-by-agent` claims and return them to the queue (or park
 * them past the backstop). Runs once at startup, before the machine reads the
 * queue.
 */
export const recoverStaleClaims = (
  env: Environment,
): Effect.Effect<void, never, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const artifacts = yield* RunArtifacts;

    const claimed = yield* provider
      .listIssuesByLabels({ include: [LABELS.pickedByAgent], exclude: [] })
      .pipe(
        Effect.catchAll((error) => {
          const detail = describeProviderError(error);
          return Console.error(`  ⚠ recovery sweep skipped — could not list claims: ${detail}`).pipe(
            Effect.zipRight(artifacts.logEvent({ event: "stale_sweep_skipped", error: detail })),
            Effect.as<readonly Issue[]>([]),
          );
        }),
      );

    const claims: readonly ClaimedIssue[] = claimed.map((issue) => ({
      iid: issue.iid,
      updatedAt: issue.updatedAt,
    }));
    if (claims.length === 0) {
      return;
    }

    const { live, dead } = yield* scanClaims;
    const now = yield* Clock.currentTimeMillis;
    const agedOut = new Set(selectStale(claims, now, STALE_CLAIM_MS).map((claim) => claim.iid));

    // Reap a claim no live lock holds when a dead lock once held it (fast) or it
    // aged past STALE_CLAIM_MS (the lockless fallback). A live lock always wins.
    const orphans = claims.filter(
      (claim) => !live.has(claim.iid) && (dead.has(claim.iid) || agedOut.has(claim.iid)),
    );
    if (orphans.length === 0) {
      return;
    }

    const porcelain = yield* runShell(() => $`git worktree list --porcelain`).pipe(
      Effect.map((output) => output.stdout),
      Effect.catchAll(() => Effect.succeed("")),
    );

    for (const claim of orphans) {
      yield* recoverOrphan(claim, porcelain, env);
    }

    yield* runShell(() => $`git worktree prune`).pipe(Effect.ignore);
  });
