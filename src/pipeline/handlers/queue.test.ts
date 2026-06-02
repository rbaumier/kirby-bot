/**
 * Queue.test.ts — the "Blocked by #N" dependency gate in onFetchQueue.
 *
 * The pick itself is random; these tests pin the gate that runs *before* it:
 * an issue naming a still-open blocker is held out of the queue, one whose
 * blockers are all closed is released, an unreadable blocker keeps the
 * dependent issue waiting (fail-safe), and a bare `#ref` is never a blocker.
 * The parser is covered separately in ../blockers.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { GitProvider } from "../../provider/provider";
import { ProviderHttpError } from "../../provider/types";
import type { Issue } from "../../provider/types";
import { onFetchQueue } from "./queue";

type Provider = Context.Tag.Service<typeof GitProvider>;

const anIssue = (over: Partial<Issue> & { iid: number }): Issue => ({
  title: `issue ${over.iid}`,
  description: null,
  labels: ["ready-for-agent"],
  updatedAt: "",
  isOpen: true,
  ...over,
});

/** Every method is a defect; a test overrides only what it touches. */
const stub: Provider = {
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
};

const run = (over: Partial<Provider>) =>
  Effect.runPromise(onFetchQueue.pipe(Effect.provide(Layer.succeed(GitProvider, { ...stub, ...over }))));

describe("onFetchQueue blocker gate", () => {
  it("holds an issue whose blocker is still open", async () => {
    const result = await run({
      listIssuesByLabels: () => Effect.succeed([anIssue({ iid: 10, description: "Blocked by #5" })]),
      viewIssue: () => Effect.succeed(anIssue({ iid: 5, isOpen: true })),
    });
    expect(result.kind).toBe("end");
  });

  it("releases an issue once its blocker is closed", async () => {
    const result = await run({
      listIssuesByLabels: () => Effect.succeed([anIssue({ iid: 10, description: "Blocked by #5" })]),
      viewIssue: () => Effect.succeed(anIssue({ iid: 5, isOpen: false })),
    });
    expect(result.kind).toBe("claim_issue");
    if (result.kind === "claim_issue") expect(result.issue.iid).toBe(10);
  });

  it("skips the blocked issue and picks the free one", async () => {
    const result = await run({
      listIssuesByLabels: () =>
        Effect.succeed([anIssue({ iid: 10, description: "Blocked by #5" }), anIssue({ iid: 20 })]),
      viewIssue: () => Effect.succeed(anIssue({ iid: 5, isOpen: true })),
    });
    expect(result.kind).toBe("claim_issue");
    if (result.kind === "claim_issue") expect(result.issue.iid).toBe(20);
  });

  it("treats an unreadable blocker as still-open (fail-safe)", async () => {
    const result = await run({
      listIssuesByLabels: () =>
        Effect.succeed([anIssue({ iid: 10, description: "Blocked by #999" })]),
      viewIssue: () =>
        Effect.fail(
          new ProviderHttpError({ method: "GET", path: "issues/999", status: 404, body: "" }),
        ),
    });
    expect(result.kind).toBe("end");
  });

  it("does not treat a bare #ref as a blocker (viewIssue stays untouched)", async () => {
    const result = await run({
      listIssuesByLabels: () =>
        Effect.succeed([anIssue({ iid: 10, description: "See #5 for context" })]),
    });
    expect(result.kind).toBe("claim_issue");
    if (result.kind === "claim_issue") expect(result.issue.iid).toBe(10);
  });

  it("holds an issue while only some of its blockers are closed", async () => {
    const result = await run({
      listIssuesByLabels: () =>
        Effect.succeed([anIssue({ iid: 10, description: "Blocked by #5 and #6" })]),
      // #5 closed, #6 still open → one open blocker is enough to hold #10.
      viewIssue: (iid: number) => Effect.succeed(anIssue({ iid, isOpen: iid === 6 })),
    });
    expect(result.kind).toBe("end");
  });

  it("ignores a self-reference (viewIssue stays untouched)", async () => {
    const result = await run({
      listIssuesByLabels: () =>
        Effect.succeed([anIssue({ iid: 10, description: "Blocked by #10" })]),
    });
    expect(result.kind).toBe("claim_issue");
    if (result.kind === "claim_issue") expect(result.issue.iid).toBe(10);
  });
});
