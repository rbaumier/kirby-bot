/**
 * Recovery/sweep.ts — the startup crash-recovery sweep (impure shell).
 *
 * A run that dies mid-pipeline (crash, timeout, sentinel failure) leaves its
 * issue labelled `picked-by-agent`. The queue read filters that label out, so
 * the issue is stranded — every later launch ends `fetch_queue → end` with no
 * work (#35). This sweep runs once at startup: it finds claims older than the
 * per-issue budget (no live run could still hold one), removes their orphan
 * worktrees, and returns them to the queue by swapping the labels back.
 *
 * The pure decision logic lives in `./stale.ts`; this module is the glue that
 * talks to the provider and to `git`. Every failure here is best-effort —
 * recovery must never abort a run, so the whole sweep resolves to `void`. A
 * persistent provider outage surfaces fatally at the `fetch_queue` read that
 * follows, not here.
 */
import { $ } from "bun";
import { Clock, Console, Effect } from "effect";
import { LABELS, STALE_CLAIM_MS } from "../config";
import { GitProvider } from "../provider/provider";
import { describeProviderError } from "../provider/types";
import type { Issue } from "../provider/types";
import { RunArtifacts } from "../run-artifacts";
import { runShell } from "../shell";
import { selectStale, worktreePathsForIssue } from "./stale";
import type { ClaimedIssue } from "./stale";

/** Remove every orphan worktree belonging to `iid`, given a porcelain listing. */
const removeWorktreesForIssue = (porcelain: string, iid: number): Effect.Effect<void> =>
  Effect.forEach(
    worktreePathsForIssue(porcelain, iid),
    (path) => runShell(() => $`git worktree remove --force ${path}`).pipe(Effect.ignore),
    { discard: true },
  );

/**
 * Find stale `picked-by-agent` claims and return them to the queue: drop the
 * claim, restore `ready-for-agent`, and remove any orphan worktree. Runs once
 * at startup, before the machine reads the queue.
 */
export const recoverStaleClaims: Effect.Effect<void, never, GitProvider | RunArtifacts> =
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

    const now = yield* Clock.currentTimeMillis;
    const claims: readonly ClaimedIssue[] = claimed.map((issue) => ({
      iid: issue.iid,
      updatedAt: issue.updatedAt,
    }));
    const stale = selectStale(claims, now, STALE_CLAIM_MS);
    if (stale.length === 0) {
      return;
    }

    const porcelain = yield* runShell(() => $`git worktree list --porcelain`).pipe(
      Effect.map((output) => output.stdout),
      Effect.catchAll(() => Effect.succeed("")),
    );

    for (const claim of stale) {
      yield* removeWorktreesForIssue(porcelain, claim.iid);
      yield* provider
        .updateIssueLabels(claim.iid, {
          add: [LABELS.readyForAgent],
          remove: [LABELS.pickedByAgent],
        })
        .pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              const detail = describeProviderError(error);
              return Console.error(`  ⚠ recovery: could not reclaim #${claim.iid}: ${detail}`).pipe(
                Effect.zipRight(
                  artifacts.logEvent({
                    event: "stale_claim_recover_failed",
                    issue: claim.iid,
                    error: detail,
                  }),
                ),
              );
            },
            onSuccess: () =>
              Console.log(`  ↻ recovered stale claim on #${claim.iid} — returned to queue`).pipe(
                Effect.zipRight(
                  artifacts.logEvent({ event: "stale_claim_recovered", issue: claim.iid }),
                ),
              ),
          }),
        );
    }

    yield* runShell(() => $`git worktree prune`).pipe(Effect.ignore);
  });
