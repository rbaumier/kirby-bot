/**
 * Handlers.test.ts — `endFieldsOf` and the `step` seam.
 *
 * The seam catches a `HandlerError` and rebuilds an end state from `current`,
 * routing on the error's `fate` (failure → failed, stall → stalled,
 * interruption → interrupted). Tests pin the extractor's per-variant output,
 * and the live behaviour when a handler fails with a failing provider.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { STATE_DIR } from "../config";
import type { Environment } from "../preflight";
import { GitProvider } from "../provider/provider";
import { ProviderHttpError } from "../provider/types";
import { writeCheckpoint } from "../recovery/checkpoint";
import { RunArtifacts } from "../run-artifacts";
import type { RunArtifactsShape } from "../run-artifacts";
import { endFieldsOf, step } from "./step";
import type { State } from "./state";

const noopRunArtifacts: RunArtifactsShape = {
  dir: "/tmp/test-run-dir",
  runId: "test-run-dir",
  logPath: "/tmp/test-run-dir/run.jsonl",
  sentinelPath: () => "/tmp/test-run-dir/sentinel.flag",
  tmuxLogPath: () => "/tmp/test-run-dir/tmux.log",
  promptFilePath: () => "/tmp/test-run-dir/prompt.md",
  findingsPath: () => "/tmp/test-run-dir/findings.json",
  triagePath: () => "/tmp/test-run-dir/triage.json",
  sessionName: () => "test-session",
  logEvent: () => Effect.void,
};
const TestRunArtifacts: Layer.Layer<RunArtifacts> = Layer.succeed(RunArtifacts, noopRunArtifacts);

const issue = { iid: 42, title: "Test issue", body: "body" } as const;
const env: Environment = { repoName: "kirby-steptest", defaultBranch: "main" };

describe("endFieldsOf", () => {
  it("issue-only states leave branch/worktree/pullRequestIid/fixCycles null", () => {
    const claim: Extract<State, { kind: "claim_issue" }> = { kind: "claim_issue", issue };
    expect(endFieldsOf(claim)).toEqual({
      issue,
      branch: null,
      worktree: null,
      pullRequestIid: null,
      fixCycles: null,
    });
  });

  it("implementation exposes branch + worktree (pullRequestIid + fixCycles stay null)", () => {
    const runImpl: Extract<State, { kind: "implementation" }> = {
      kind: "implementation",
      issue,
      branch: "issue-42",
      worktree: "/wt/42",
    };
    expect(endFieldsOf(runImpl)).toEqual({
      issue,
      branch: "issue-42",
      worktree: "/wt/42",
      pullRequestIid: null,
      fixCycles: null,
    });
  });

  it("review carries all five fields including fixCycles", () => {
    const review: Extract<State, { kind: "review" }> = {
      kind: "review",
      issue,
      branch: "issue-42",
      worktree: "/wt/42",
      deadline: 999_999,
      pullRequestIid: 7,
      fixCycles: 1,
    };
    expect(endFieldsOf(review)).toEqual({
      issue,
      branch: "issue-42",
      worktree: "/wt/42",
      pullRequestIid: 7,
      fixCycles: 1,
    });
  });

  it("done has worktree + pullRequestIid but no branch or fixCycles", () => {
    const done: Extract<State, { kind: "done" }> = {
      kind: "done",
      issue,
      worktree: "/wt/42",
      pullRequestIid: 7,
    };
    expect(endFieldsOf(done)).toEqual({
      issue,
      branch: null,
      worktree: "/wt/42",
      pullRequestIid: 7,
      fixCycles: null,
    });
  });
});

/**
 * Build a GitProvider Layer where every call is a defect.
 * Only `viewIssue` and `updateIssueLabels` are touched on the `claim_issue` path.
 * `viewIssue` returns a typed error the handler swallows to `false`.
 * `updateIssueLabels` is the one that should surface as `HandlerError`.
 */
const makeClaimFailingProvider = (): Layer.Layer<GitProvider> =>
  Layer.succeed(GitProvider, {
    listIssuesByLabels: () => Effect.die("fake: listIssuesByLabels"),
    viewIssue: () =>
      Effect.fail(
        new ProviderHttpError({ method: "GET", path: "issues/42", status: 500, body: "boom" }),
      ),
    updateIssueLabels: () =>
      Effect.fail(
        new ProviderHttpError({ method: "PUT", path: "issues/42", status: 500, body: "boom" }),
      ),
    addIssueNote: () => Effect.die("fake: addIssueNote"),
    findOpenPullRequestBySource: () => Effect.die("fake: findOpenPullRequestBySource"),
    createDraftPullRequest: () => Effect.die("fake: createDraftPullRequest"),
    viewPullRequest: () => Effect.die("fake: viewPullRequest"),
    markPullRequestReady: () => Effect.die("fake: markPullRequestReady"),
    mergePullRequest: () => Effect.die("fake: mergePullRequest"),
    listDiscussions: () => Effect.die("fake: listDiscussions"),
    postDiscussion: () => Effect.die("fake: postDiscussion"),
    postMrNote: () => Effect.die("fake: postMrNote"),
    replyToDiscussion: () => Effect.die("fake: replyToDiscussion"),
    resolveDiscussion: () => Effect.die("fake: resolveDiscussion"),
  });

describe("step seam", () => {
  it("a transient (HTTP 500) HandlerError from claim_issue becomes an `interrupted` state with the issue copied off `current`", async () => {
    const result = await Effect.runPromise(
      step({ kind: "claim_issue", issue }, env).pipe(
        Effect.provide(makeClaimFailingProvider()),
        Effect.provide(TestRunArtifacts),
      ),
    );
    // status 500 → fateOfProviderError → "interruption" → `interrupted` (ADR 0004).
    const interrupted = result.kind === "interrupted" ? result : null;
    expect(interrupted).not.toBeNull();
    expect(interrupted?.issue).toEqual(issue);
    expect(interrupted?.branch).toBeNull();
    expect(interrupted?.worktree).toBeNull();
    expect(interrupted?.pullRequestIid).toBeNull();
    expect(interrupted?.fixCycles).toBeNull();
    // A non-usage-limit interruption carries no reset substring (#78): the seam
    // defaults the field to null, so the machine never backs off for it.
    expect(interrupted?.usageLimitResetText).toBeNull();
    expect(interrupted?.reason).toContain("claim_issue:");
    expect(interrupted?.reason).toContain("HTTP 500");
  });

  it("a 422 HandlerError from claim_issue becomes a `failed` state (the retry would only re-hit it)", async () => {
    const provider = Layer.succeed(GitProvider, {
      ...providerStub,
      viewIssue: () => Effect.succeed({ labels: [] } as never),
      updateIssueLabels: () =>
        Effect.fail(
          new ProviderHttpError({ method: "PUT", path: "issues/42", status: 422, body: "nope" }),
        ),
    });
    const result = await Effect.runPromise(
      step({ kind: "claim_issue", issue }, env).pipe(
        Effect.provide(provider),
        Effect.provide(TestRunArtifacts),
      ),
    );
    expect(result.kind).toBe("failed");
  });
});

/** A provider stub whose every method is a defect — override only what a test touches. */
const providerStub = {
  listIssuesByLabels: () => Effect.die("stub: listIssuesByLabels"),
  viewIssue: () => Effect.die("stub: viewIssue"),
  updateIssueLabels: () => Effect.die("stub: updateIssueLabels"),
  addIssueNote: () => Effect.die("stub: addIssueNote"),
  findOpenPullRequestBySource: () => Effect.die("stub: findOpenPullRequestBySource"),
  createDraftPullRequest: () => Effect.die("stub: createDraftPullRequest"),
  viewPullRequest: () => Effect.die("stub: viewPullRequest"),
  markPullRequestReady: () => Effect.die("stub: markPullRequestReady"),
  mergePullRequest: () => Effect.die("stub: mergePullRequest"),
  listDiscussions: () => Effect.die("stub: listDiscussions"),
  postDiscussion: () => Effect.die("stub: postDiscussion"),
  postMrNote: () => Effect.die("stub: postMrNote"),
  replyToDiscussion: () => Effect.die("stub: replyToDiscussion"),
  resolveDiscussion: () => Effect.die("stub: resolveDiscussion"),
} as const;

describe("onStalled (cold sidecar)", () => {
  // This suite's repo owns its sidecar; wipe it so a prior run's counters can't park early.
  beforeEach(() => rm(join(STATE_DIR, env.repoName), { recursive: true, force: true }));

  it("returns the issue to the queue (ready-for-agent) and posts an audit note below the cap", async () => {
    const labelCalls: { add: readonly string[]; remove: readonly string[] }[] = [];
    let noted = false;
    const provider = Layer.succeed(GitProvider, {
      ...providerStub,
      addIssueNote: () =>
        Effect.sync(() => {
          noted = true;
        }),
      updateIssueLabels: (_iid, changes) =>
        Effect.sync(() => {
          labelCalls.push(changes);
        }),
    });
    const stalled = {
      kind: "stalled",
      issue,
      branch: null,
      worktree: "/wt/42",
      pullRequestIid: null,
      fixCycles: null,
      reason: "implementation: timed out with no commits ahead of base",
    } as const;

    const result = await Effect.runPromise(
      step(stalled, env).pipe(Effect.provide(provider), Effect.provide(TestRunArtifacts)),
    );
    expect(result.kind).toBe("fetch_queue");
    expect(noted).toBe(true);
    expect(labelCalls).toEqual([{ add: ["ready-for-agent"], remove: ["picked-by-agent"] }]);
  });
});

/**
 * The resume routing the checkpoint feeds (#73), exercised through the real
 * `step` seam + checkpoint store. `open_draft_mr` is the choke point that reads
 * the checkpoint and routes — but ONLY when the MR already exists; a freshly
 * created MR must ignore the checkpoint (an empty MR has no Discussions to
 * resume `evaluate`/`fix` against).
 */
describe("open_draft_mr resume routing (#73)", () => {
  const resumeEnv: Environment = { repoName: "kirby-steptest-resume", defaultBranch: "main" };
  // This suite owns its checkpoint file; wipe it so a prior run can't leak in.
  beforeEach(() => rm(join(STATE_DIR, resumeEnv.repoName), { recursive: true, force: true }));

  const openDraftMr: Extract<State, { kind: "open_draft_mr" }> = {
    kind: "open_draft_mr",
    issue,
    branch: "issue-42",
    worktree: "/wt/42",
    deadline: 999_999,
  };
  const withExistingMr = Layer.succeed(GitProvider, {
    ...providerStub,
    findOpenPullRequestBySource: () => Effect.succeed(Option.some({ iid: 7, isMerged: false })),
  });

  it("an existing MR + a Phase checkpoint resumes that Phase with its fix-cycle count", async () => {
    await Effect.runPromise(writeCheckpoint(resumeEnv.repoName, issue.iid, { phase: "evaluate", fixCycles: 1 }));
    const result = await Effect.runPromise(
      step(openDraftMr, resumeEnv).pipe(Effect.provide(withExistingMr), Effect.provide(TestRunArtifacts)),
    );
    const evaluate = result.kind === "evaluate" ? result : null;
    expect(evaluate).not.toBeNull();
    expect(evaluate?.fixCycles).toBe(1);
    expect(evaluate?.pullRequestIid).toBe(7);
  });

  it("an existing MR with no checkpoint starts the review cycle from scratch", async () => {
    const result = await Effect.runPromise(
      step(openDraftMr, resumeEnv).pipe(Effect.provide(withExistingMr), Effect.provide(TestRunArtifacts)),
    );
    const review = result.kind === "review" ? result : null;
    expect(review).not.toBeNull();
    expect(review?.fixCycles).toBe(0);
    expect(review?.pullRequestIid).toBe(7);
  });

  it("a freshly created MR ignores the checkpoint and routes to review/0 (no empty-MR resume)", async () => {
    await Effect.runPromise(writeCheckpoint(resumeEnv.repoName, issue.iid, { phase: "qa", fixCycles: 2 }));
    const withCreatedMr = Layer.succeed(GitProvider, {
      ...providerStub,
      findOpenPullRequestBySource: () => Effect.succeed(Option.none()),
      createDraftPullRequest: () => Effect.succeed({ iid: 8, isMerged: false }),
    });
    const result = await Effect.runPromise(
      step(openDraftMr, resumeEnv).pipe(Effect.provide(withCreatedMr), Effect.provide(TestRunArtifacts)),
    );
    const review = result.kind === "review" ? result : null;
    expect(review).not.toBeNull();
    expect(review?.fixCycles).toBe(0);
    expect(review?.pullRequestIid).toBe(8);
  });
});
