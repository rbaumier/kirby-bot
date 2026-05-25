/**
 * Provider/gitlab.ts — GitLab implementation of the {@link GitProvider} seam.
 *
 * Wraps the typed REST operations in `src/gitlab/*` and maps their domain
 * shapes (GitLab issues, MRs, discussions) to the provider-neutral
 * vocabulary the pipeline depends on. The HTTP error shapes are already
 * shared (provider/types.ts) so no error remapping is needed here.
 *
 * Boot-time misconfiguration (ProviderConfigError) is treated as a defect
 * at the seam — the provider contract narrows call errors to
 * ProviderCallError, and a missing token / unparseable remote is a wiring
 * bug, not a routable call failure.
 */
import { Effect, Layer, Option } from "effect";
import {
  addIssueNote as glAddIssueNote,
  createDraftMergeRequest as glCreateDraftMergeRequest,
  findOpenMergeRequestBySource as glFindOpenMergeRequestBySource,
  type GitLabIssue,
  listDiscussions as glListDiscussions,
  listIssuesByLabels as glListIssuesByLabels,
  markMergeRequestReady as glMarkMergeRequestReady,
  mergeMergeRequest as glMergeMergeRequest,
  postDiscussion as glPostDiscussion,
  replyToDiscussion as glReplyToDiscussion,
  resolveDiscussion as glResolveDiscussion,
  updateIssueLabels as glUpdateIssueLabels,
  viewIssue as glViewIssue,
  viewMergeRequest as glViewMergeRequest,
} from "../gitlab/api";
import type { DiscussionSummary as GitLabDiscussionSummary } from "../gitlab/discussion";
import type { GitLabMergeRequest } from "../gitlab/schema";
import { GitProvider } from "./provider";
import {
  type CreateDraftPullRequestInput,
  DiscussionId,
  type DiscussionSummary,
  type Issue,
  type IssueLabelChange,
  type ListIssuesQuery,
  type MergeInput,
  type ProviderCallError,
  type ProviderError,
  type PullRequestRef,
} from "./types";

/** Turn a config failure into a defect; call failures pass through unchanged. */
const adaptCall = <A>(
  effect: Effect.Effect<A, ProviderError>,
): Effect.Effect<A, ProviderCallError> =>
  effect.pipe(
    Effect.catchTag("ProviderConfigError", (error) =>
      Effect.die(`GitLab provider config error: ${error.detail}`),
    ),
  );

const mapIssue = (issue: GitLabIssue): Issue => ({
  iid: issue.iid,
  title: issue.title,
  description: issue.description,
  labels: issue.labels,
});

const mapPullRequest = (mr: GitLabMergeRequest): PullRequestRef => ({
  iid: mr.iid,
  isMerged: mr.state === "merged",
});

const mapDiscussionAuthor = (author: string): string | null =>
  author === "unknown" ? null : author;

const mapDiscussion = (disc: GitLabDiscussionSummary): DiscussionSummary => ({
  id: DiscussionId(disc.id),
  isResolved: disc.resolved,
  notes: disc.notes.map((note) => ({
    author: mapDiscussionAuthor(note.author),
    body: note.body,
  })),
});

/** A GitLab-backed {@link GitProvider} Layer. */
export const GitLabProviderLive: Layer.Layer<GitProvider> = Layer.succeed(
  GitProvider,
  {
    listIssuesByLabels: (query: ListIssuesQuery) =>
      adaptCall(
        glListIssuesByLabels({ include: query.include, exclude: query.exclude }),
      ).pipe(Effect.map((issues) => issues.map(mapIssue))),

    viewIssue: (iid: number) => adaptCall(glViewIssue(iid)).pipe(Effect.map(mapIssue)),

    updateIssueLabels: (iid: number, changes: IssueLabelChange) =>
      adaptCall(glUpdateIssueLabels(iid, { add: changes.add, remove: changes.remove })),

    addIssueNote: (iid: number, body: string) => adaptCall(glAddIssueNote(iid, body)),

    findOpenPullRequestBySource: (sourceBranch: string) =>
      adaptCall(glFindOpenMergeRequestBySource(sourceBranch)).pipe(
        Effect.map((mr) => (mr === undefined ? Option.none() : Option.some(mapPullRequest(mr)))),
      ),

    createDraftPullRequest: (input: CreateDraftPullRequestInput) =>
      adaptCall(glCreateDraftMergeRequest(input)).pipe(Effect.map(mapPullRequest)),

    viewPullRequest: (iid: number) =>
      adaptCall(glViewMergeRequest(iid)).pipe(Effect.map(mapPullRequest)),

    markPullRequestReady: (iid: number) => adaptCall(glMarkMergeRequestReady(iid)),

    mergePullRequest: (iid: number, input: MergeInput) =>
      adaptCall(
        glMergeMergeRequest({
          iid,
          squash: input.shouldSquash,
          autoMerge: input.shouldAutoMerge,
        }),
      ).pipe(Effect.map(mapPullRequest)),

    listDiscussions: (pullRequestIid: number) =>
      adaptCall(glListDiscussions(pullRequestIid)).pipe(
        Effect.map((list) => list.map(mapDiscussion)),
      ),

    postDiscussion: (pullRequestIid: number, body: string) =>
      adaptCall(glPostDiscussion(pullRequestIid, body)),

    replyToDiscussion: (pullRequestIid: number, discussionId: DiscussionId, body: string) =>
      adaptCall(glReplyToDiscussion(pullRequestIid, discussionId, body)),

    resolveDiscussion: (pullRequestIid: number, discussionId: DiscussionId) =>
      adaptCall(glResolveDiscussion(pullRequestIid, discussionId)),
  },
);
