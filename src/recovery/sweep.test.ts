/**
 * Sweep.test.ts — the startup recovery sweep against a mock provider.
 *
 * The pure staleness/worktree logic is covered in `./stale.test.ts`; here we
 * pin the glue: which claims get returned to the queue, which are left, and
 * that every failure stays best-effort (the sweep never fails).
 *
 * `git worktree list` runs for real here, so the worktree-removal path stays
 * an inert no-op by construction: every test uses synthetic 9000x iids that no
 * real `afk/issue-N-*` worktree can match. The path's branch-matching logic is
 * covered directly in `./stale.test.ts` (`worktreePathsForIssue`).
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { STATE_DIR } from "../config";
import type { Environment } from "../preflight";
import { GitProvider } from "../provider/provider";
import { ProviderHttpError } from "../provider/types";
import type { Issue, IssueLabelChange } from "../provider/types";
import { RunArtifacts } from "../run-artifacts";
import type { RunArtifactsShape } from "../run-artifacts";
import { recoverStaleClaims } from "./sweep";

const STALE_DATE = "2020-01-01T00:00:00Z"; // far older than the budget
const freshDate = () => new Date(Date.now() - 60_000).toISOString(); // 1 min ago

// A repo whose interruption sidecar this suite owns and wipes before each test,
// so the on-disk re-pick counters never accrue across runs into a spurious park.
const env: Environment = { repoName: "kirby-sweep-test", defaultBranch: "main" };
beforeEach(() => rm(join(STATE_DIR, env.repoName), { recursive: true, force: true }));

const issue = (iid: number, updatedAt: string): Issue => ({
  iid,
  title: `issue ${iid}`,
  description: null,
  labels: ["picked-by-agent"],
  updatedAt,
  isOpen: true,
});

type LabelCall = { readonly iid: number; readonly changes: IssueLabelChange };

/** A provider that records label updates and serves a fixed claim list. */
const recordingProvider = (
  claims: readonly Issue[],
  calls: LabelCall[],
  updateResult: () => Effect.Effect<void, ProviderHttpError> = () => Effect.void,
): Layer.Layer<GitProvider> =>
  Layer.succeed(GitProvider, {
    listIssuesByLabels: () => Effect.succeed(claims),
    updateIssueLabels: (iid, changes) => {
      calls.push({ iid, changes });
      return updateResult();
    },
    viewIssue: () => Effect.die("unused: viewIssue"),
    addIssueNote: () => Effect.void,
    findOpenPullRequestBySource: () => Effect.die("unused: findOpenPullRequestBySource"),
    createDraftPullRequest: () => Effect.die("unused: createDraftPullRequest"),
    viewPullRequest: () => Effect.die("unused: viewPullRequest"),
    markPullRequestReady: () => Effect.die("unused: markPullRequestReady"),
    mergePullRequest: () => Effect.die("unused: mergePullRequest"),
    listDiscussions: () => Effect.die("unused: listDiscussions"),
    postDiscussion: () => Effect.die("unused: postDiscussion"),
    postMrNote: () => Effect.die("unused: postMrNote"),
    replyToDiscussion: () => Effect.die("unused: replyToDiscussion"),
    resolveDiscussion: () => Effect.die("unused: resolveDiscussion"),
  });

/** A provider whose claim-list read fails — exercises the catch-all skip. */
const listFailingProvider = (): Layer.Layer<GitProvider> =>
  Layer.succeed(GitProvider, {
    listIssuesByLabels: () =>
      Effect.fail(
        new ProviderHttpError({ method: "GET", path: "issues", status: 500, body: "boom" }),
      ),
    updateIssueLabels: () => Effect.die("unreachable: updateIssueLabels"),
    viewIssue: () => Effect.die("unused"),
    addIssueNote: () => Effect.die("unused"),
    findOpenPullRequestBySource: () => Effect.die("unused"),
    createDraftPullRequest: () => Effect.die("unused"),
    viewPullRequest: () => Effect.die("unused"),
    markPullRequestReady: () => Effect.die("unused"),
    mergePullRequest: () => Effect.die("unused"),
    listDiscussions: () => Effect.die("unused"),
    postDiscussion: () => Effect.die("unused"),
    postMrNote: () => Effect.die("unused"),
    replyToDiscussion: () => Effect.die("unused"),
    resolveDiscussion: () => Effect.die("unused"),
  });

/** A fresh RunArtifacts layer that appends every logged event to `sink`. */
const recordingRunArtifacts = (sink: Record<string, unknown>[]): Layer.Layer<RunArtifacts> =>
  Layer.succeed(RunArtifacts, {
    dir: "/tmp/test-run-dir",
    runId: "test-run-dir",
    logPath: "/tmp/test-run-dir/run.jsonl",
    sentinelPath: () => "/tmp/test-run-dir/sentinel.flag",
    tmuxLogPath: () => "/tmp/test-run-dir/tmux.log",
    promptFilePath: () => "/tmp/test-run-dir/prompt.md",
    findingsPath: () => "/tmp/test-run-dir/findings.json",
    triagePath: () => "/tmp/test-run-dir/triage.json",
    sessionName: () => "test-session",
    logEvent: (event) =>
      Effect.sync(() => {
        sink.push(event);
      }),
  } satisfies RunArtifactsShape);

/** Run the sweep with a fresh event sink per call — no state shared across tests. */
const run = (provider: Layer.Layer<GitProvider>, events: Record<string, unknown>[] = []) =>
  Effect.runPromise(
    recoverStaleClaims(env).pipe(
      Effect.provide(provider),
      Effect.provide(recordingRunArtifacts(events)),
    ),
  );

describe("recoverStaleClaims", () => {
  it("returns a stale claim to the queue, swapping the labels back", async () => {
    const calls: LabelCall[] = [];
    await run(recordingProvider([issue(90007, STALE_DATE)], calls));
    expect(calls).toEqual([
      { iid: 90007, changes: { add: ["ready-for-agent"], remove: ["picked-by-agent"] } },
    ]);
  });

  it("leaves a fresh claim untouched", async () => {
    const calls: LabelCall[] = [];
    await run(recordingProvider([issue(90008, freshDate())], calls));
    expect(calls).toEqual([]);
  });

  it("recovers only the stale claims in a mixed list", async () => {
    const calls: LabelCall[] = [];
    await run(
      recordingProvider(
        [issue(90001, STALE_DATE), issue(90002, freshDate()), issue(90003, STALE_DATE)],
        calls,
      ),
    );
    expect(calls.map((call) => call.iid)).toEqual([90001, 90003]);
  });

  it("logs a stale_claim_recovered event per recovered issue", async () => {
    const events: Record<string, unknown>[] = [];
    await run(recordingProvider([issue(90009, STALE_DATE)], []), events);
    expect(events).toContainEqual({ event: "stale_claim_recovered", issue: 90009 });
  });

  it("swallows a per-issue label-update failure and logs it, without failing the sweep", async () => {
    const calls: LabelCall[] = [];
    const events: Record<string, unknown>[] = [];
    const failing = () =>
      Effect.fail(
        new ProviderHttpError({ method: "PUT", path: "issues/90005", status: 500, body: "boom" }),
      );
    await expect(
      run(recordingProvider([issue(90005, STALE_DATE)], calls, failing), events),
    ).resolves.toBeUndefined();
    expect(calls.map((call) => call.iid)).toEqual([90005]); // attempted...
    expect(events.map((event) => event.event)).toContain("stale_claim_recover_failed"); // ...logged
  });

  it("skips and logs an event when the claim-list read fails", async () => {
    const events: Record<string, unknown>[] = [];
    await expect(run(listFailingProvider(), events)).resolves.toBeUndefined();
    expect(events.map((event) => event.event)).toContain("stale_sweep_skipped");
  });
});
