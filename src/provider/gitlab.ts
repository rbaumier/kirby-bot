/**
 * Provider/gitlab.ts — the GitLab adapter for the {@link GitProvider} seam.
 *
 * Wraps the typed REST operations in `gitlab/api.ts` + `gitlab/discussion-api.ts`
 * and adapts their shapes to the provider-neutral contract:
 *
 *  - {@link GitLabMergeRequest} → {@link PullRequestRef}
 *  - {@link GitLabError}        → {@link ProviderCallError}
 *  - `undefined`                → `Option.none()`
 *  - raw discussion id (string) → branded {@link DiscussionId}
 *  - call shape `{iid, squash, autoMerge}` → positional `(iid, MergeInput)`
 *
 * The Layer preloads the GitLab config so a missing token surfaces as a
 * `ProviderConfigError` at boot rather than at the first request.
 */
import { Effect, Layer, Option } from "effect";
import {
  addIssueNote,
  createDraftMergeRequest,
  findOpenMergeRequestBySource,
  listIssuesByLabels,
  markMergeRequestReady,
  mergeMergeRequest,
  updateIssueLabels,
  viewIssue,
  viewMergeRequest,
  type GitLabIssue,
} from "../gitlab/api";
import {
  listDiscussions as listDiscussionsRaw,
  postDiscussion as postDiscussionRaw,
  replyToDiscussion as replyToDiscussionRaw,
  resolveDiscussion as resolveDiscussionRaw,
} from "../gitlab/discussion-api";
import type { DiscussionSummary as GitLabDiscussionSummary } from "../gitlab/discussion";
import type { GitLabError } from "../gitlab/errors";
import { gitLabConfig } from "../gitlab/http";
import type { GitLabMergeRequest } from "../gitlab/schema";
import { GitProvider } from "./provider";
import {
  DiscussionId,
  type DiscussionSummary,
  type Issue,
  type ProviderCallError,
  ProviderConfigError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseError,
  type PullRequestRef,
  type PullRequestState,
} from "./types";

const DRAFT_TITLE_PREFIX = /^(?:Draft|WIP)\s*[:\-]\s*/i;

/** Narrow a free-form GitLab MR state to the contract's enum. */
const toPullRequestState = (state: string): PullRequestState => {
  if (state === "opened" || state === "merged" || state === "closed") {
    return state;
  }
  // `locked`, `reopened`, and similar transient values aren't part of the
  // pipeline's vocabulary — fold them into `opened`, the only state for which
  // the pipeline would still act on the MR.
  return "opened";
};

/** Map the GitLab merge-request shape to the provider-neutral PR ref. */
const toPullRequestRef = (mr: GitLabMergeRequest): PullRequestRef => ({
  iid: mr.iid,
  webUrl: mr.web_url,
  state: toPullRequestState(mr.state),
  isDraft: mr.draft || mr.work_in_progress || DRAFT_TITLE_PREFIX.test(mr.title),
  sourceBranch: mr.source_branch,
  targetBranch: mr.target_branch,
});

/** Map the GitLab issue shape to the provider-neutral Issue. */
const toIssue = (issue: GitLabIssue): Issue => ({
  iid: issue.iid,
  title: issue.title,
  description: issue.description,
  labels: issue.labels,
  updatedAt: issue.updated_at,
  // GitLabIssue currently does not carry `web_url`; the queue read does not
  // surface it either. Until issue #5 widens the schema, fall back to empty.
  webUrl: "",
});

/** Map the GitLab discussion shape to the provider-neutral summary. */
const toDiscussionSummary = (raw: GitLabDiscussionSummary): DiscussionSummary => ({
  id: DiscussionId(raw.id),
  isResolved: raw.resolved,
  notes: raw.notes.map((note) => ({ author: note.author, body: note.body })),
});

/**
 * Map a GitLab error to a provider call error.
 *
 * `GitLabConfigError` should not reach here in practice — the Layer preloads
 * the config — but we still need a total mapping, so we surface it as a
 * response error with a tagged detail.
 */
const toProviderCallError = (error: GitLabError): ProviderCallError => {
  switch (error._tag) {
    case "GitLabHttpError": {
      return new ProviderHttpError({
        method: error.method,
        path: error.path,
        status: error.status,
        body: error.body,
      });
    }
    case "GitLabNetworkError": {
      return new ProviderNetworkError({
        method: error.method,
        path: error.path,
        cause: error.cause,
      });
    }
    case "GitLabResponseError": {
      return new ProviderResponseError({
        method: error.method,
        path: error.path,
        detail: error.detail,
      });
    }
    case "GitLabConfigError": {
      return new ProviderResponseError({
        method: "—",
        path: "—",
        detail: `config: ${error.detail}`,
      });
    }
    default: {
      const unreachable: never = error;
      throw new Error(`unreachable GitLab error: ${JSON.stringify(unreachable)}`);
    }
  }
};

/** Helper: convert any GitLab-typed effect into the provider's error channel. */
const adapt = <A>(effect: Effect.Effect<A, GitLabError>): Effect.Effect<A, ProviderCallError> =>
  effect.pipe(Effect.mapError(toProviderCallError));

/** The provider operations themselves, computed once for the Layer. */
const operations = GitProvider.of({
  listIssuesByLabels: (query) =>
    adapt(
      listIssuesByLabels({ include: query.include, exclude: query.exclude }).pipe(
        Effect.map((list) => list.map(toIssue)),
      ),
    ),

  viewIssue: (iid) => adapt(viewIssue(iid).pipe(Effect.map(toIssue))),

  updateIssueLabels: (iid, changes) => adapt(updateIssueLabels(iid, changes)),

  addIssueNote: (iid, body) => adapt(addIssueNote(iid, body)),

  findOpenPullRequestBySource: (sourceBranch) =>
    adapt(
      findOpenMergeRequestBySource(sourceBranch).pipe(
        Effect.map((mr) => Option.fromNullable(mr).pipe(Option.map(toPullRequestRef))),
      ),
    ),

  createDraftPullRequest: (input) =>
    adapt(
      createDraftMergeRequest({
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        title: input.title,
        description: input.description,
      }).pipe(Effect.map(toPullRequestRef)),
    ),

  viewPullRequest: (iid) => adapt(viewMergeRequest(iid).pipe(Effect.map(toPullRequestRef))),

  markPullRequestReady: (iid) => adapt(markMergeRequestReady(iid)),

  mergePullRequest: (iid, input) =>
    adapt(
      mergeMergeRequest({
        iid,
        squash: input.shouldSquash,
        autoMerge: input.shouldAutoMerge,
      }).pipe(Effect.map(toPullRequestRef)),
    ),

  listDiscussions: (pullRequestIid) =>
    adapt(
      listDiscussionsRaw(pullRequestIid).pipe(Effect.map((list) => list.map(toDiscussionSummary))),
    ),

  postDiscussion: (pullRequestIid, body) => adapt(postDiscussionRaw(pullRequestIid, body)),

  replyToDiscussion: (pullRequestIid, discussionId, body) =>
    adapt(replyToDiscussionRaw(pullRequestIid, discussionId, body)),

  resolveDiscussion: (pullRequestIid, discussionId) =>
    adapt(resolveDiscussionRaw(pullRequestIid, discussionId)),
});

/**
 * Live Layer for the GitLab provider.
 *
 * Preloads the GitLab config so a missing token / unparseable remote surfaces
 * once at boot as a typed {@link ProviderConfigError}, instead of randomly at
 * the first request inside a phase.
 */
export const GitLabProviderLive: Layer.Layer<GitProvider, ProviderConfigError> = Layer.effect(
  GitProvider,
  gitLabConfig.pipe(
    Effect.mapError((error) => new ProviderConfigError({ detail: error.detail })),
    Effect.as(operations),
  ),
);
