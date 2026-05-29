/**
 * Github/pull-request.ts — typed REST + GraphQL operations on GitHub PRs.
 *
 * Mirrors `src/gitlab/merge-request.ts`: one function per operation, each
 * wrapping the `runGitHub*` runners from `./http.ts` with the request shape and
 * Effect schema for one PR endpoint — find/create the draft PR, view it,
 * un-draft it, and merge it.
 *
 * Two GitHub-specific differences vs GitLab are handled here:
 *   1. A PR has a native `draft` boolean (GitLab derives it from a title
 *      prefix), so create/markReady don't massage the title.
 *   2. Un-drafting has no REST endpoint — it goes through
 *      `markPullRequestReadyForReview` over GraphQL ({@link runGitHubGraphQL}).
 */
import { Effect, Schema } from "effect";
import type { ProviderError } from "../provider/types";
import { githubOwner, runGitHubGraphQL, runGitHubRead, runGitHubWrite } from "./http";
import { PullRequestSchema } from "./schema";
import type { GitHubPullRequest } from "./schema";

const prArraySchema = Schema.Array(PullRequestSchema);

/**
 * Build the `pulls` list query that finds the one open PR for a branch. The
 * `head` filter requires the `owner:branch` form, not the bare branch name.
 */
const findOpenQuery = (owner: string, sourceBranch: string) => ({
  head: `${owner}:${sourceBranch}`,
  state: "open",
  per_page: 1,
});

/** Find the one open PR for a branch, if any. */
export const findOpenPullRequestBySource = (
  sourceBranch: string,
): Effect.Effect<GitHubPullRequest | undefined, ProviderError> =>
  githubOwner.pipe(
    Effect.flatMap((owner) =>
      runGitHubRead(
        { method: "GET", path: "repos/:owner/:repo/pulls", query: findOpenQuery(owner, sourceBranch) },
        prArraySchema,
      ),
    ),
    Effect.map((list) => list.at(0)),
  );

/** Params for {@link createDraftPullRequest}. */
type CreateDraftPullRequestParams = {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly description: string;
};

/**
 * Create a draft PR. Returns the created PR (its `iid` is the orchestrator's
 * handle). Squash/branch-deletion are merge-time choices on GitHub, not create
 * flags, so the body carries only the five fields below.
 */
export const createDraftPullRequest = (
  params: CreateDraftPullRequestParams,
): Effect.Effect<GitHubPullRequest, ProviderError> =>
  runGitHubWrite(
    {
      method: "POST",
      path: "repos/:owner/:repo/pulls",
      body: {
        head: params.sourceBranch,
        base: params.targetBranch,
        title: params.title,
        body: params.description,
        draft: true,
      },
    },
    PullRequestSchema,
  );

/** Fetch a single PR by iid (GitHub's PR `number`). */
export const viewPullRequest = (iid: number): Effect.Effect<GitHubPullRequest, ProviderError> =>
  runGitHubRead({ method: "GET", path: `repos/:owner/:repo/pulls/${iid}` }, PullRequestSchema);

/** A PR needs the ready-for-review mutation only while it is still a draft. */
const needsReadyMutation = (draft: boolean): boolean => draft;

/**
 * GraphQL is the only way to flip a PR from draft to ready-for-review; there is
 * no REST endpoint. The mutation is addressed by the PR's opaque `node_id`.
 */
const MARK_READY_MUTATION = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) {
    pullRequest { isDraft }
  }
}`;

/** Decode the mutation payload just enough to confirm GitHub accepted it. */
const MarkReadySchema = Schema.Struct({
  markPullRequestReadyForReview: Schema.Struct({
    pullRequest: Schema.Struct({ isDraft: Schema.Boolean }),
  }),
});

/**
 * Mark a draft PR as ready for review. GitHub exposes no REST endpoint for this,
 * so we read the PR for its `node_id` and run the `markPullRequestReadyForReview`
 * GraphQL mutation. If the PR is already non-draft we short-circuit and skip the
 * mutation (mirrors the "already ready" guard in `markMergeRequestReady`).
 */
export const markPullRequestReady = (iid: number): Effect.Effect<void, ProviderError> =>
  Effect.gen(function* () {
    const pr = yield* viewPullRequest(iid);
    if (!needsReadyMutation(pr.draft)) {
      return;
    }
    yield* runGitHubGraphQL(MARK_READY_MUTATION, { id: pr.node_id }, MarkReadySchema);
  });

/** Params for {@link mergePullRequest}. */
type MergePullRequestParams = {
  readonly iid: number;
  readonly squash: boolean;
  /** Accepted for signature parity with the GitLab path; ignored (see below). */
  readonly autoMerge: boolean;
};

/** GitHub's merge methods this bot uses: squash by default, plain merge otherwise. */
const mergeMethod = (squash: boolean): "squash" | "merge" => (squash ? "squash" : "merge");

/**
 * The merge endpoint returns `{ sha, merged, message }` — not a PR object — so
 * decode just the `merged` ack. The provider mapping re-`viewPullRequest`s when
 * it needs the merged PR shape.
 */
const MergeResultSchema = Schema.Struct({ merged: Schema.Boolean });

/** The merge acknowledgement returned by the PR merge endpoint. */
export type GitHubMergeAck = Schema.Schema.Type<typeof MergeResultSchema>;

/**
 * Squash-merge a PR immediately.
 *
 * `autoMerge` is accepted but ignored: kirby-bot targets repos with no CI, and
 * GitHub auto-merge is GraphQL-only and needs the repo setting enabled — so this
 * always does a direct merge, matching how the GitLab path falls through to an
 * immediate merge.
 *
 * Runs exactly once (`runGitHubWrite`, not the idempotent variant): replaying a
 * merge errors on an already-merged PR, so a retry after a lost response must
 * not turn a success into a failure (same reasoning as `mergeMergeRequest`).
 */
export const mergePullRequest = (
  params: MergePullRequestParams,
): Effect.Effect<GitHubMergeAck, ProviderError> =>
  runGitHubWrite(
    {
      method: "PUT",
      path: `repos/:owner/:repo/pulls/${params.iid}/merge`,
      body: { merge_method: mergeMethod(params.squash) },
    },
    MergeResultSchema,
  );

/** Exposed for tests — never used in production code. */
export const __test = { findOpenQuery, needsReadyMutation, mergeMethod };
