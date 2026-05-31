/**
 * Provider/gitlab.ts — GitLab implementation of the {@link GitProvider} seam.
 *
 * Wraps the typed REST operations in `src/gitlab/*` and maps their domain
 * shapes (GitLab issues, MRs, discussions) to the provider-neutral
 * vocabulary the pipeline depends on. The HTTP error shapes are already
 * shared (provider/types.ts) so no error remapping is needed here.
 *
 * Boot-time misconfiguration (ProviderConfigError) is treated as a defect
 * at the seam. The provider contract narrows call errors to
 * ProviderCallError; a missing token or unparseable remote is a wiring
 * bug, not a routable call failure.
 */
import { Effect, Layer, Option } from "effect";
import {
  listDiscussions as glListDiscussions,
  postDiscussion as glPostDiscussion,
  replyToDiscussion as glReplyToDiscussion,
  resolveDiscussion as glResolveDiscussion,
} from "../gitlab/discussion";
import type { DiscussionSummary as GitLabDiscussionSummary } from "../gitlab/discussion";
import {
  addIssueNote as glAddIssueNote,
  listIssuesByLabels as glListIssuesByLabels,
  updateIssueLabels as glUpdateIssueLabels,
  viewIssue as glViewIssue,
} from "../gitlab/issue";
import type { GitLabIssue } from "../gitlab/issue";
import {
  addMergeRequestNote as glAddMergeRequestNote,
  createDraftMergeRequest as glCreateDraftMergeRequest,
  findOpenMergeRequestBySource as glFindOpenMergeRequestBySource,
  markMergeRequestReady as glMarkMergeRequestReady,
  mergeMergeRequest as glMergeMergeRequest,
  viewMergeRequest as glViewMergeRequest,
  viewMergeRequestDiffRefs as glViewMergeRequestDiffRefs,
} from "../gitlab/merge-request";
import type { GitLabDiffRefs, GitLabMergeRequest } from "../gitlab/schema";
import { GitProvider } from "./provider";
import { DiscussionId } from "./types";
import type {
  CreateDraftPullRequestInput,
  DiscussionPosition,
  DiscussionSummary,
  Issue,
  IssueLabelChange,
  ListIssuesQuery,
  MergeInput,
  ProviderCallError,
  ProviderError,
  PullRequestRef,
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
  updatedAt: issue.updated_at,
});

const mapPullRequest = (mr: GitLabMergeRequest): PullRequestRef => ({
  iid: mr.iid,
  isMerged: mr.state === "merged",
});

const pullRequestAsOption = (
  mr: GitLabMergeRequest | undefined,
): Option.Option<PullRequestRef> =>
  mr === undefined ? Option.none() : Option.some(mapPullRequest(mr));

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
export const GitLabProviderLive: Layer.Layer<GitProvider> = Layer.effect(
  GitProvider,
  Effect.gen(function* () {
    // `diff_refs` are constant for an MR head, so a review posting N findings
    // resolves them once and reuses the result — `Effect.cachedFunction`
    // memoizes by iid (ADR 0003).
    const diffRefsFor: (iid: number) => Effect.Effect<GitLabDiffRefs, ProviderCallError> =
      yield* Effect.cachedFunction((iid: number) => adaptCall(glViewMergeRequestDiffRefs(iid)));

    const postDiscussion = (
      pullRequestIid: number,
      body: string,
      position?: DiscussionPosition,
    ): Effect.Effect<DiscussionId, ProviderCallError> =>
      (position === undefined
        ? adaptCall(glPostDiscussion(pullRequestIid, body))
        : diffRefsFor(pullRequestIid).pipe(
            Effect.flatMap((refs) =>
              adaptCall(
                glPostDiscussion(pullRequestIid, body, {
                  file: position.file,
                  line: position.line,
                  refs,
                }),
              ),
            ),
          )
      ).pipe(Effect.map(DiscussionId));

    return {
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
          Effect.map(pullRequestAsOption),
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

      postDiscussion,

      postMrNote: (pullRequestIid: number, body: string) =>
        adaptCall(glAddMergeRequestNote(pullRequestIid, body)),

      replyToDiscussion: (pullRequestIid: number, discussionId: DiscussionId, body: string) =>
        adaptCall(glReplyToDiscussion(pullRequestIid, discussionId, body)),

      resolveDiscussion: (pullRequestIid: number, discussionId: DiscussionId) =>
        adaptCall(glResolveDiscussion(pullRequestIid, discussionId)),
    };
  }),
);
