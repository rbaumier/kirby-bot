/**
 * Github/discussion.ts — pull-request discussions: the pure model plus the
 * typed REST + GraphQL operations on them.
 *
 * Mirrors `src/gitlab/discussion.ts`, but the two backends differ on the one
 * point that matters to the review→evaluate→fix loop: GitLab has a *general*
 * resolvable thread, GitHub does not. Only **review threads anchored to a diff
 * line** are resolvable, and resolving them is GraphQL-only. So the mapping is:
 *
 *   - A finding whose header carries a real `file:line` → a **review comment**
 *     anchored to that diff line (REST `POST .../pulls/{n}/comments`), which
 *     GitHub turns into a resolvable review thread.
 *   - The prose summary (`review-summary:0`) or a finding whose line is not in
 *     the PR diff (GitHub answers 422) → a plain PR comment, which is *not*
 *     resolvable and is reported as `resolved: true` — exactly how the GitLab
 *     mapper already treats a thread with no resolvable notes (non-blocking),
 *     so the convergence loop stays honest.
 *
 * `toDiscussionSummary` maps a raw GraphQL review-thread node to the trimmed
 * shape the evaluate/fix phases reason about — pure and unit-testable on its
 * own. `parseFindingHeader` reads the `severity: <sev> | <file>:<line>` header
 * contract documented in `src/review/post.ts`, also pure.
 */
import { Effect, Schema } from "effect";
import { ProviderResponseError } from "../provider/types";
import type { ProviderError } from "../provider/types";
import { runGitHubGraphQL, runGitHubRead, runGitHubWrite } from "./http";
import { viewPullRequest } from "./pull-request";

/** A discussion reduced to what the pipeline reasons about (mirrors GitLab). */
export type DiscussionSummary = {
  readonly id: string;
  readonly resolved: boolean;
  readonly notes: readonly { readonly author: string; readonly body: string }[];
};

/** Type guard: returns true if `val` is a non-null object usable as a record. */
const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

// ─── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Parse the review-finding header — the first line of a discussion body, in the
 * form `severity: <sev> | <file>:<line>` (the contract in `src/review/post.ts`).
 *
 * Returns the anchored `{ file, line }` for a real finding, or `null` for the
 * synthetic `review-summary:0` summary (file `review-summary`, line 0) and for
 * any unparseable header. Pure — drives whether `postDiscussion` anchors a
 * review comment or falls back to a plain comment.
 */
export function parseFindingHeader(body: string): { file: string; line: number } | null {
  const firstLine = body.split("\n", 1).at(0) ?? "";
  const pipeIndex = firstLine.indexOf("|");
  if (pipeIndex === -1) {
    return null;
  }
  const location = firstLine.slice(pipeIndex + 1).trim();
  const colonIndex = location.lastIndexOf(":");
  if (colonIndex === -1) {
    return null;
  }
  const file = location.slice(0, colonIndex);
  const line = Number(location.slice(colonIndex + 1));
  // `review-summary:0` and any malformed / non-positive line are not anchorable.
  if (file === "" || file === "review-summary" || !Number.isInteger(line) || line <= 0) {
    return null;
  }
  return { file, line };
}

/**
 * Map one raw GitHub review-thread node (from the `reviewThreads` GraphQL query)
 * to a {@link DiscussionSummary}. `resolved` reads the thread's `isResolved`;
 * each comment's `author.login` falls back to `"unknown"`.
 *
 * Pure and garbage-safe — a non-object node yields an empty summary, non-object
 * comments are dropped, so a malformed page can never throw.
 */
export function toDiscussionSummary(raw: unknown): DiscussionSummary {
  const object: Record<string, unknown> = isRecord(raw) ? raw : {};

  const idValue = object.id;
  const id = typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : "";

  const commentsContainer = isRecord(object.comments) ? object.comments : {};
  const rawNodes = Array.isArray(commentsContainer.nodes) ? commentsContainer.nodes : [];

  return {
    id,
    resolved: object.isResolved === true,
    notes: rawNodes
      .filter((node): node is Record<string, unknown> => isRecord(node))
      .map((node) => ({
        author:
          isRecord(node.author) && typeof node.author.login === "string"
            ? node.author.login
            : "unknown",
        body: typeof node.body === "string" ? node.body : "",
      })),
  };
}

// ─── GraphQL queries / mutations ──────────────────────────────────────────

/**
 * List a PR's review threads. Addressed by the PR's opaque `node_id` so the
 * query needs no `owner/name` (only `githubOwner` is exposed by `./http.ts`).
 */
const REVIEW_THREADS_QUERY = `query($prId: ID!) {
  node(id: $prId) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) { nodes { author { login } body } }
        }
      }
    }
  }
}`;

/** Same navigation, projecting each thread's comment `databaseId`s for matching. */
const THREAD_IDS_QUERY = `query($prId: ID!) {
  node(id: $prId) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes { id comments(first: 100) { nodes { databaseId } } }
      }
    }
  }
}`;

/** Reply inside an existing review thread, addressed by its node id. */
const ADD_REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

/** Resolve a review thread, echoing `isResolved` so the write can be verified. */
const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { isResolved }
  }
}`;

// ─── Response schemas ─────────────────────────────────────────────────────

/** `reviewThreads.nodes` left opaque — `toDiscussionSummary` validates each node. */
const ReviewThreadsSchema = Schema.Struct({
  node: Schema.Struct({
    reviewThreads: Schema.Struct({ nodes: Schema.Array(Schema.Object) }),
  }),
});

/** Thread node ids paired with their comments' `databaseId`s, for post-match. */
const ThreadIdsSchema = Schema.Struct({
  node: Schema.Struct({
    reviewThreads: Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          comments: Schema.Struct({
            nodes: Schema.Array(Schema.Struct({ databaseId: Schema.Number })),
          }),
        }),
      ),
    }),
  }),
});

/** A created review comment carries its REST `id` (databaseId) and `node_id`. */
const ReviewCommentAckSchema = Schema.Struct({
  id: Schema.Number,
  node_id: Schema.String,
});

/** A created plain issue comment carries the opaque `node_id` we key the id on. */
const PlainCommentAckSchema = Schema.Struct({ node_id: Schema.String });

/** A plain PR comment as listed by `GET issues/{n}/comments`. */
const IssueCommentSchema = Schema.Struct({
  node_id: Schema.String,
  body: Schema.optionalWith(Schema.String, { default: () => "" }),
  // `user` is null for a ghost author; the `"unknown"` fallback lives in the
  // mapper below (single source), mirroring GitLab's `toDiscussionSummary`.
  user: Schema.optionalWith(Schema.NullOr(Schema.Struct({ login: Schema.String })), {
    default: () => null,
  }),
});
const IssueCommentsSchema = Schema.Array(IssueCommentSchema);

/** Confirms `addPullRequestReviewThreadReply` took — a comment id came back. */
const AddReplySchema = Schema.Struct({
  addPullRequestReviewThreadReply: Schema.Struct({
    comment: Schema.Struct({ id: Schema.String }),
  }),
});

/** Confirms `resolveReviewThread` took — and whether it actually resolved. */
const ResolveSchema = Schema.Struct({
  resolveReviewThread: Schema.Struct({ thread: Schema.Struct({ isResolved: Schema.Boolean }) }),
});

// ─── Operations ───────────────────────────────────────────────────────────

/** A `comment:`-prefixed id marks a non-resolvable plain comment. */
const PLAIN_COMMENT_PREFIX = "comment:";

/** A 422 from the review-comment POST means the line is not in the PR diff. */
const isLineNotInDiff = (error: ProviderError): boolean =>
  error._tag === "ProviderHttpError" && error.status === 422;

/** Post a plain (non-resolvable) PR comment; its id is `comment:<node_id>`. */
const postPlainComment = (prNumber: number, body: string): Effect.Effect<string, ProviderError> =>
  runGitHubWrite(
    { method: "POST", path: `repos/:owner/:repo/issues/${prNumber}/comments`, body: { body } },
    PlainCommentAckSchema,
  ).pipe(Effect.map((created) => `${PLAIN_COMMENT_PREFIX}${created.node_id}`));

/**
 * Resolve a freshly-created review comment to its enclosing review thread's
 * node id — the id `resolveDiscussion` needs (the thread, not the comment).
 * GitHub gives no direct comment→thread link, so we re-query the PR's threads
 * and match on the comment's `databaseId`.
 */
const threadIdForComment = (
  prNodeId: string,
  commentDatabaseId: number,
): Effect.Effect<string, ProviderError> =>
  runGitHubGraphQL(THREAD_IDS_QUERY, { prId: prNodeId }, ThreadIdsSchema).pipe(
    Effect.flatMap((data) => {
      const thread = data.node.reviewThreads.nodes.find((node) =>
        node.comments.nodes.some((comment) => comment.databaseId === commentDatabaseId),
      );
      return thread === undefined
        ? Effect.fail(
            new ProviderResponseError({
              method: "POST",
              path: "graphql",
              detail: `no review thread found for comment ${commentDatabaseId} on PR node ${prNodeId}`,
            }),
          )
        : Effect.succeed(thread.id);
    }),
  );

/**
 * List every discussion on a PR: resolvable review threads (GraphQL, carrying
 * their real `resolved` state) plus plain PR comments (reported `resolved:
 * true`, non-blocking, with a `comment:`-prefixed id so they round-trip).
 */
export const listDiscussions = (
  prNumber: number,
): Effect.Effect<readonly DiscussionSummary[], ProviderError> =>
  Effect.gen(function* () {
    const pr = yield* viewPullRequest(prNumber);
    const threadsData = yield* runGitHubGraphQL(
      REVIEW_THREADS_QUERY,
      { prId: pr.node_id },
      ReviewThreadsSchema,
    );
    const threads = threadsData.node.reviewThreads.nodes.map((node) => toDiscussionSummary(node));

    const comments = yield* runGitHubRead(
      { method: "GET", path: `repos/:owner/:repo/issues/${prNumber}/comments`, query: { per_page: 100 } },
      IssueCommentsSchema,
    );
    const plain: readonly DiscussionSummary[] = comments.map((comment) => ({
      id: `${PLAIN_COMMENT_PREFIX}${comment.node_id}`,
      resolved: true,
      notes: [{ author: comment.user?.login ?? "unknown", body: comment.body }],
    }));

    return [...threads, ...plain];
  });

/**
 * Post `body` as a discussion. If its header anchors to a `file:line` that the
 * PR diff covers, create a resolvable review comment and return its review
 * **thread** node id. Otherwise (no anchor, or a 422 "line not in diff") fall
 * back to a plain PR comment and return its `comment:<node_id>` id.
 */
export const postDiscussion = (
  prNumber: number,
  body: string,
): Effect.Effect<string, ProviderError> =>
  Effect.gen(function* () {
    const header = parseFindingHeader(body);
    if (header === null) {
      return yield* postPlainComment(prNumber, body);
    }

    const pr = yield* viewPullRequest(prNumber);
    const anchored = runGitHubWrite(
      {
        method: "POST",
        path: `repos/:owner/:repo/pulls/${prNumber}/comments`,
        body: {
          body,
          commit_id: pr.head.sha,
          path: header.file,
          line: header.line,
          side: "RIGHT",
          subject_type: "line",
        },
      },
      ReviewCommentAckSchema,
    ).pipe(Effect.flatMap((created) => threadIdForComment(pr.node_id, created.id)));

    // 422 = the anchored line isn't in the diff → fall back to a plain comment.
    return yield* anchored.pipe(
      Effect.catchIf(isLineNotInDiff, () => postPlainComment(prNumber, body)),
    );
  });

/**
 * Reply to a discussion. A review thread (its node id) gets a true threaded
 * reply over GraphQL; a `comment:` plain comment gets a new top-level PR comment
 * — plain "threads" aren't real threads, so the reply just lands on the PR.
 */
export const replyToDiscussion = (
  prNumber: number,
  discussionId: string,
  body: string,
): Effect.Effect<void, ProviderError> =>
  discussionId.startsWith(PLAIN_COMMENT_PREFIX)
    ? postPlainComment(prNumber, body).pipe(Effect.asVoid)
    : runGitHubGraphQL(
        ADD_REPLY_MUTATION,
        { threadId: discussionId, body },
        AddReplySchema,
      ).pipe(Effect.asVoid);

/**
 * Resolve a discussion, then verify it came back resolved — a 200 that no-ops
 * must not pass for a resolved thread. A `comment:` plain comment is already
 * reported resolved, so resolving it is a no-op success.
 */
export const resolveDiscussion = (
  prNumber: number,
  discussionId: string,
): Effect.Effect<void, ProviderError> => {
  if (discussionId.startsWith(PLAIN_COMMENT_PREFIX)) {
    return Effect.void;
  }
  return runGitHubGraphQL(RESOLVE_MUTATION, { threadId: discussionId }, ResolveSchema).pipe(
    Effect.flatMap((data) =>
      data.resolveReviewThread.thread.isResolved
        ? Effect.void
        : Effect.fail(
            new ProviderResponseError({
              method: "POST",
              path: "graphql",
              detail: `review thread ${discussionId} still unresolved after resolveReviewThread`,
            }),
          ),
    ),
  );
};
