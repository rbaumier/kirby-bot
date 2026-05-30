/**
 * Review.test.ts — unit tests for the sterile fan-out detection added in
 * issue #50: when every review agent fails (okCount === 0), reviewPhase must
 * abort with HandlerError and emit a review_fanout_sterile event instead of
 * advancing to evaluate.
 *
 * Dependencies with I/O side-effects are mocked at the module level so the
 * tests stay in-process. RunArtifacts and GitProvider are provided via
 * Effect service injection.
 */
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer, Option } from "effect";
import type { FanOutResult } from "../session/fanout";
import type { AggregatedReview } from "../review/aggregate";
import type { ReviewAnalysis } from "../review/detect";
import { HandlerError } from "../pipeline/errors";
import { GitProvider } from "../provider/provider";
import { RunArtifacts } from "../run-artifacts";
import type { RunArtifactsShape } from "../run-artifacts";
import type { Environment } from "../preflight";
import type { State } from "../pipeline/state";

// ── Module-level mutable state (read lazily by the mock closures) ─────────────

let currentFanOutResult: FanOutResult;

// ── Module mocks (Bun hoists mock.module calls before static imports) ─────────
// Use require() inside factories to defer package resolution past the hoist.

mock.module("../session/fanout", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const E = require("effect").Effect as typeof Effect;
  return {
    DEFAULT_TEMPLATES_DIR: "/tmp/templates",
    runFanOutPhase: () => E.succeed(currentFanOutResult),
  };
});

mock.module("../review/read-changed-files", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const E = require("effect").Effect as typeof Effect;
  return { readChangedFiles: () => E.succeed([]) };
});

mock.module("../review/aggregate", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const E = require("effect").Effect as typeof Effect;
  return {
    aggregateFindings: () =>
      E.succeed({ agents: [], lineAnchoredFindings: [], proseFindings: [] }),
  };
});

mock.module("../review/post", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const E = require("effect").Effect as typeof Effect;
  return { postReviewToMr: () => E.void };
});

// ── Module under test (imported after mocks are registered) ───────────────────

import { reviewPhase } from "./review";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const emptyAnalysis: ReviewAnalysis = {
  trustBoundaries: [],
  dogfoodRequired: false,
  dogfoodSurfaces: [],
  totalFiles: 0,
  totalLines: 0,
};

const makeFanOutResult = (okCount: number): FanOutResult => ({
  okCount,
  totalCount: 2,
  outcomes: okCount === 0
    ? [
        { kind: "error", agent: "correctness", reason: "SessionTimedOut", totalMs: 35_000 },
        { kind: "error", agent: "tests", reason: "verdict_reprompt then timed out", totalMs: 35_000 },
      ]
    : [
        { kind: "ok", agent: "correctness", findingsPath: "/tmp/findings.json", totalMs: 5_000 },
        { kind: "error", agent: "tests", reason: "timed out", totalMs: 35_000 },
      ],
  analysis: emptyAnalysis,
  routes: [],
  routerTruncated: false,
  fullDiffPath: "/tmp/full.patch",
});

const testState: Extract<State, { kind: "review" }> = {
  kind: "review",
  issue: { iid: 42, title: "test issue", body: "" },
  branch: "test/branch",
  worktree: "/tmp/test-worktree",
  deadline: Date.now() + 3_600_000,
  pullRequestIid: 1,
  fixCycles: 0,
};

const testEnv: Environment = { repoName: "test/repo", defaultBranch: "main" };

/** Minimal RunArtifacts that captures logEvent calls. */
const makeTestArtifacts = (): { artifacts: RunArtifactsShape; events: Record<string, unknown>[] } => {
  const events: Record<string, unknown>[] = [];
  const artifacts: RunArtifactsShape = {
    dir: "/tmp/test-run",
    logPath: "/tmp/test-run/run.jsonl",
    sentinelPath: () => "/tmp/sentinel",
    tmuxLogPath: () => "/tmp/tmux.log",
    promptFilePath: () => "/tmp/prompt.md",
    findingsPath: () => "/tmp/findings.json",
    triagePath: () => "/tmp/triage.json",
    sessionName: () => "test-session",
    logEvent: (event) => {
      events.push(event);
      return Effect.void;
    },
  };
  return { artifacts, events };
};

/** No-op GitProvider — reviewPhase only needs it for postReviewToMr (mocked). */
const noopProviderLayer = Layer.succeed(GitProvider, {
  listIssuesByLabels: () => Effect.succeed([]),
  viewIssue: () => Effect.fail({ _tag: "ProviderCallError", reason: "noop" } as never),
  updateIssueLabels: () => Effect.void,
  addIssueNote: () => Effect.void,
  findOpenPullRequestBySource: () => Effect.succeed(Option.none()),
  createDraftPullRequest: () => Effect.fail({ _tag: "ProviderCallError", reason: "noop" } as never),
  addMrNote: () => Effect.void,
  addMrDiscussion: () => Effect.fail({ _tag: "ProviderCallError", reason: "noop" } as never),
  listDiscussions: () => Effect.succeed([]),
  resolveDiscussion: () => Effect.void,
  mergeMr: () => Effect.fail({ _tag: "ProviderCallError", reason: "noop" } as never),
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reviewPhase — sterile fan-out (okCount === 0)", () => {
  it("fails with HandlerError containing review_fanout_sterile", async () => {
    currentFanOutResult = makeFanOutResult(0);
    const { artifacts, events } = makeTestArtifacts();
    const artifactsLayer = Layer.succeed(RunArtifacts, artifacts);

    const program = reviewPhase(testState, testEnv).pipe(
      Effect.flip, // invert to get the error as the success value
      Effect.provide(Layer.merge(artifactsLayer, noopProviderLayer)),
    );

    const error = await Effect.runPromise(program);
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.reason).toContain("review_fanout_sterile");
    expect(error.reason).toContain("0/2");
  });

  it("emits a review_fanout_sterile event", async () => {
    currentFanOutResult = makeFanOutResult(0);
    const { artifacts, events } = makeTestArtifacts();
    const artifactsLayer = Layer.succeed(RunArtifacts, artifacts);

    await Effect.runPromise(
      reviewPhase(testState, testEnv).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.provide(Layer.merge(artifactsLayer, noopProviderLayer)),
      ),
    );

    const sterileEvent = events.find((e) => e["event"] === "review_fanout_sterile");
    expect(sterileEvent).toBeDefined();
    expect(sterileEvent?.["okCount"]).toBe(0);
    expect(sterileEvent?.["totalCount"]).toBe(2);
    expect(sterileEvent?.["iteration"]).toBe(testState.fixCycles);
    expect(sterileEvent?.["issueIid"]).toBe(testState.issue.iid);
  });

  it("does NOT advance to evaluate state", async () => {
    currentFanOutResult = makeFanOutResult(0);
    const { artifacts } = makeTestArtifacts();
    const artifactsLayer = Layer.succeed(RunArtifacts, artifacts);

    const result = await Effect.runPromise(
      reviewPhase(testState, testEnv).pipe(
        Effect.either,
        Effect.provide(Layer.merge(artifactsLayer, noopProviderLayer)),
      ),
    );

    // Must be a Left (failure), not a Right containing { kind: "evaluate" }
    expect(result._tag).toBe("Left");
  });
});

describe("reviewPhase — healthy fan-out (okCount > 0)", () => {
  it("advances to evaluate state", async () => {
    currentFanOutResult = makeFanOutResult(1);
    const { artifacts } = makeTestArtifacts();
    const artifactsLayer = Layer.succeed(RunArtifacts, artifacts);

    const result = await Effect.runPromise(
      reviewPhase(testState, testEnv).pipe(
        Effect.provide(Layer.merge(artifactsLayer, noopProviderLayer)),
      ),
    );

    expect(result.kind).toBe("evaluate");
    expect((result as Extract<State, { kind: "evaluate" }>).fixCycles).toBe(testState.fixCycles);
  });

  it("does NOT emit a review_fanout_sterile event", async () => {
    currentFanOutResult = makeFanOutResult(1);
    const { artifacts, events } = makeTestArtifacts();
    const artifactsLayer = Layer.succeed(RunArtifacts, artifacts);

    await Effect.runPromise(
      reviewPhase(testState, testEnv).pipe(
        Effect.provide(Layer.merge(artifactsLayer, noopProviderLayer)),
      ),
    );

    const sterileEvent = events.find((e) => e["event"] === "review_fanout_sterile");
    expect(sterileEvent).toBeUndefined();
  });
});
