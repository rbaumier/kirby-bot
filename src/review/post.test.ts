import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { GitProvider } from "../provider/provider";
import { DiscussionId } from "../provider/types";
import type { DiscussionPosition, ProviderCallError } from "../provider/types";
import { RunArtifacts } from "../run-artifacts";
import type { RunArtifactsShape } from "../run-artifacts";
import type { AggregatedReview } from "./aggregate";
import { postReviewToMr } from "./post";

// ─── Test helpers ─────────────────────────────────────────────────────────

type ProviderCalls = {
  discussions: string[];
  notes: string[];
  positions: (DiscussionPosition | undefined)[];
};

/** Build a mock GitProvider that records calls to postDiscussion and postMrNote. */
const makeProvider = (calls: ProviderCalls): Layer.Layer<GitProvider> =>
  Layer.succeed(GitProvider, {
    listIssuesByLabels: () => Effect.succeed([]),
    viewIssue: () => Effect.die("unused"),
    updateIssueLabels: () => Effect.void,
    addIssueNote: () => Effect.void,
    findOpenPullRequestBySource: () => Effect.die("unused"),
    createDraftPullRequest: () => Effect.die("unused"),
    viewPullRequest: () => Effect.die("unused"),
    markPullRequestReady: () => Effect.die("unused"),
    mergePullRequest: () => Effect.die("unused"),
    listDiscussions: () => Effect.succeed([]),
    postDiscussion: (_iid: number, body: string, position?: DiscussionPosition) => {
      calls.discussions.push(body);
      calls.positions.push(position);
      return Effect.succeed(DiscussionId("disc-" + calls.discussions.length));
    },
    postMrNote: (_iid: number, body: string) => {
      calls.notes.push(body);
      return Effect.void;
    },
    replyToDiscussion: () => Effect.void,
    resolveDiscussion: () => Effect.void,
  });

/** Build a no-op RunArtifacts layer for tests. */
const makeArtifacts = (): Layer.Layer<RunArtifacts> =>
  Layer.succeed(RunArtifacts, {
    dir: "/tmp/test",
    logPath: "/tmp/test/run.jsonl",
    sentinelPath: () => "/tmp/test/sentinel",
    tmuxLogPath: () => "/tmp/test/tmux.log",
    promptFilePath: () => "/tmp/test/prompt.md",
    findingsPath: () => "/tmp/test/findings.json",
    triagePath: () => "/tmp/test/triage.json",
    sessionName: () => "test-session",
    logEvent: () => Effect.void,
  } satisfies RunArtifactsShape);

const makeFinding = (
  severity: "bug" | "security" | "performance" | "error_handling" | "suggestion",
  index = 0,
) => ({
  agent: "correctness" as const,
  file: `src/file-${index}.ts`,
  line: 10 + index,
  severity,
  confidence: "high" as const,
  signature: `sig-${index}`,
  title: `Finding ${index}`,
  analysisChain: ["step 1"],
  fixPrompt: "fix this",
});

const runPost = (review: AggregatedReview, calls: ProviderCalls) =>
  Effect.runPromise(
    postReviewToMr({ mrIid: 1, review, issueIid: 42, iteration: 0 }).pipe(
      Effect.provide(makeProvider(calls)),
      Effect.provide(makeArtifacts()),
    ),
  );

const emptyReview = (): AggregatedReview => ({
  agents: [],
  lineAnchoredFindings: [],
  proseFindings: [],
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("postReviewToMr — severity routing", () => {
  test("bug finding creates a resolvable discussion, not a note", async () => {
    const calls: ProviderCalls = { discussions: [], notes: [], positions: [] };
    const review: AggregatedReview = {
      ...emptyReview(),
      lineAnchoredFindings: [makeFinding("bug")],
    };
    await runPost(review, calls);
    expect(calls.discussions).toHaveLength(1);
    expect(calls.notes).toHaveLength(0);
    expect(calls.discussions[0]).toContain("severity: bug");
  });

  test("a line finding passes its file:line as the anchor position", async () => {
    const calls: ProviderCalls = { discussions: [], notes: [], positions: [] };
    const review: AggregatedReview = {
      ...emptyReview(),
      lineAnchoredFindings: [makeFinding("bug", 0)],
    };
    await runPost(review, calls);
    expect(calls.positions[0]).toEqual({ file: "src/file-0.ts", line: 10 });
  });

  test("the prose summary is posted with no position (general discussion)", async () => {
    const calls: ProviderCalls = { discussions: [], notes: [], positions: [] };
    const review: AggregatedReview = {
      ...emptyReview(),
      proseFindings: [{ agent: "thermo-nuclear", tag: "suggestion", text: "architectural concern" }],
    };
    await runPost(review, calls);
    expect(calls.discussions).toHaveLength(1);
    expect(calls.positions[0]).toBeUndefined();
  });

  test("suggestion finding goes to postMrNote, not a discussion", async () => {
    const calls: ProviderCalls = { discussions: [], notes: [], positions: [] };
    const review: AggregatedReview = {
      ...emptyReview(),
      lineAnchoredFindings: [makeFinding("suggestion")],
    };
    await runPost(review, calls);
    expect(calls.discussions).toHaveLength(0);
    expect(calls.notes).toHaveLength(1);
    expect(calls.notes[0]).toContain("Suggestion findings");
  });

  test("mixed review: bug creates a discussion, suggestion goes to the note", async () => {
    const calls: ProviderCalls = { discussions: [], notes: [], positions: [] };
    const review: AggregatedReview = {
      ...emptyReview(),
      lineAnchoredFindings: [makeFinding("bug", 0), makeFinding("suggestion", 1)],
    };
    await runPost(review, calls);
    expect(calls.discussions).toHaveLength(1);
    expect(calls.discussions[0]).toContain("severity: bug");
    expect(calls.notes).toHaveLength(1);
    expect(calls.notes[0]).toContain("Finding 1");
  });

  test("all actionable severities create discussions, not notes", async () => {
    const calls: ProviderCalls = { discussions: [], notes: [], positions: [] };
    const review: AggregatedReview = {
      ...emptyReview(),
      lineAnchoredFindings: [
        makeFinding("bug", 0),
        makeFinding("security", 1),
        makeFinding("performance", 2),
        makeFinding("error_handling", 3),
      ],
    };
    await runPost(review, calls);
    expect(calls.discussions).toHaveLength(4);
    expect(calls.notes).toHaveLength(0);
  });

  test("multiple suggestions are consolidated into one note", async () => {
    const calls: ProviderCalls = { discussions: [], notes: [], positions: [] };
    const review: AggregatedReview = {
      ...emptyReview(),
      lineAnchoredFindings: [
        makeFinding("suggestion", 0),
        makeFinding("suggestion", 1),
        makeFinding("suggestion", 2),
      ],
    };
    await runPost(review, calls);
    expect(calls.discussions).toHaveLength(0);
    expect(calls.notes).toHaveLength(1);
    expect(calls.notes[0]).toContain("Finding 0");
    expect(calls.notes[0]).toContain("Finding 1");
    expect(calls.notes[0]).toContain("Finding 2");
  });
});

describe("postReviewToMr — only-suggestions review", () => {
  test("posts zero resolvable discussions and advances cleanly", async () => {
    const calls: ProviderCalls = { discussions: [], notes: [], positions: [] };
    const review: AggregatedReview = {
      ...emptyReview(),
      lineAnchoredFindings: [makeFinding("suggestion", 0), makeFinding("suggestion", 1)],
    };
    const result = await runPost(review, calls);
    expect(result.posted).toBe(0);
    expect(calls.discussions).toHaveLength(0);
    expect(calls.notes).toHaveLength(1);
  });

  test("empty review posts nothing", async () => {
    const calls: ProviderCalls = { discussions: [], notes: [], positions: [] };
    const result = await runPost(emptyReview(), calls);
    expect(result.posted).toBe(0);
    expect(calls.discussions).toHaveLength(0);
    expect(calls.notes).toHaveLength(0);
  });
});
