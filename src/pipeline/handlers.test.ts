/**
 * Handlers.test.ts — `failedFieldsOf` and the `step` seam.
 *
 * The seam catches a `HandlerError` and rebuilds a `failed` state from
 * `current`. Tests pin the extractor's per-variant output, and the live
 * behaviour when a handler fails with a failing provider.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import type { Environment } from "../preflight";
import { GitProvider } from "../provider/provider";
import { ProviderHttpError } from "../provider/types";
import { RunArtifacts, type RunArtifactsShape } from "../run-artifacts";
import { UnexpectedVerdictError, describePhaseRunError } from "./errors";
import { failedFieldsOf, step } from "./handlers";
import type { State } from "./state";

const noopRunArtifacts: RunArtifactsShape = {
  dir: "/tmp/test-run-dir",
  logPath: "/tmp/test-run-dir/run.jsonl",
  sentinelPath: () => "/tmp/test-run-dir/sentinel.flag",
  tmuxLogPath: () => "/tmp/test-run-dir/tmux.log",
  promptFilePath: () => "/tmp/test-run-dir/prompt.md",
  sessionName: () => "test-session",
  logEvent: () => Effect.void,
};
const TestRunArtifacts: Layer.Layer<RunArtifacts> = Layer.succeed(RunArtifacts, noopRunArtifacts);

const issue = { iid: 42, title: "Test issue", body: "body" } as const;
const env: Environment = { repoName: "test-repo", defaultBranch: "main" };

describe("failedFieldsOf", () => {
  it("issue-only states leave branch/worktree/pullRequestIid null", () => {
    const claim: Extract<State, { kind: "claim_issue" }> = { kind: "claim_issue", issue };
    expect(failedFieldsOf(claim)).toEqual({
      issue,
      branch: null,
      worktree: null,
      pullRequestIid: null,
    });
  });

  it("run_impl exposes branch + worktree (pullRequestIid stays null)", () => {
    const runImpl: Extract<State, { kind: "run_impl" }> = {
      kind: "run_impl",
      issue,
      branch: "issue-42",
      worktree: "/wt/42",
    };
    expect(failedFieldsOf(runImpl)).toEqual({
      issue,
      branch: "issue-42",
      worktree: "/wt/42",
      pullRequestIid: null,
    });
  });

  it("review carries all four fields", () => {
    const review: Extract<State, { kind: "review" }> = {
      kind: "review",
      issue,
      branch: "issue-42",
      worktree: "/wt/42",
      deadline: 999_999,
      pullRequestIid: 7,
      fixCycles: 1,
    };
    expect(failedFieldsOf(review)).toEqual({
      issue,
      branch: "issue-42",
      worktree: "/wt/42",
      pullRequestIid: 7,
    });
  });

  it("done has worktree + pullRequestIid but no branch", () => {
    const done: Extract<State, { kind: "done" }> = {
      kind: "done",
      issue,
      worktree: "/wt/42",
      pullRequestIid: 7,
    };
    expect(failedFieldsOf(done)).toEqual({
      issue,
      branch: null,
      worktree: "/wt/42",
      pullRequestIid: 7,
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
    replyToDiscussion: () => Effect.die("fake: replyToDiscussion"),
    resolveDiscussion: () => Effect.die("fake: resolveDiscussion"),
  });

describe("describePhaseRunError", () => {
  it("formats UnexpectedVerdictError with the verdict + expected list", () => {
    const error = new UnexpectedVerdictError({
      phase: "review",
      verdict: "BLOCKER_SUSPECTED",
      expected: ["REVIEW_DONE"],
    });
    expect(describePhaseRunError(error)).toBe(
      "unexpected verdict BLOCKER_SUSPECTED (expected: REVIEW_DONE)",
    );
  });
});

describe("step seam", () => {
  it("HandlerError from claim_issue becomes a `failed` state with the issue copied off `current`", async () => {
    const result = await Effect.runPromise(
      step({ kind: "claim_issue", issue }, env).pipe(
        Effect.provide(makeClaimFailingProvider()),
        Effect.provide(TestRunArtifacts),
      ),
    );
    const failed = result.kind === "failed" ? result : null;
    expect(failed).not.toBeNull();
    expect(failed?.issue).toEqual(issue);
    expect(failed?.branch).toBeNull();
    expect(failed?.worktree).toBeNull();
    expect(failed?.pullRequestIid).toBeNull();
    expect(failed?.reason).toContain("claim_issue:");
    expect(failed?.reason).toContain("HTTP 500");
  });
});
