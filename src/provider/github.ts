/**
 * Provider/github.ts — GitHub implementation of the {@link GitProvider} seam.
 *
 * Wraps the typed REST/GraphQL operations in `src/github/*` and maps their
 * domain shapes (GitHub issues, PRs, review threads) to the provider-neutral
 * vocabulary the pipeline depends on. Mirrors `src/provider/gitlab.ts` 1:1; the
 * HTTP error shapes are already shared (provider/types.ts) so no error
 * remapping is needed here.
 *
 * Boot-time misconfiguration (ProviderConfigError) is treated as a defect at
 * the seam. The provider contract narrows call errors to ProviderCallError; a
 * missing token or unparseable slug is a wiring bug, not a routable failure.
 */
import { Effect, Layer, Option } from "effect";
import {
  addPullRequestNote as ghAddPullRequestNote,
  listDiscussions as ghListDiscussions,
  postDiscussion as ghPostDiscussion,
  replyToDiscussion as ghReplyToDiscussion,
  resolveDiscussion as ghResolveDiscussion,
} from "../github/discussion";
import type { DiscussionSummary as GitHubDiscussionSummary } from "../github/discussion";
import {
  addIssueNote as ghAddIssueNote,
  listIssuesByLabels as ghListIssuesByLabels,
  updateIssueLabels as ghUpdateIssueLabels,
  viewIssue as ghViewIssue,
} from "../github/issue";
import type { GitHubIssue } from "../github/schema";
import {
  createDraftPullRequest as ghCreateDraftPullRequest,
  findOpenPullRequestBySource as ghFindOpenPullRequestBySource,
  markPullRequestReady as ghMarkPullRequestReady,
  mergePullRequest as ghMergePullRequest,
  viewPullRequest as ghViewPullRequest,
} from "../github/pull-request";
import type { GitHubPullRequest } from "../github/schema";
import { GitProvider } from "./provider";
import { DiscussionId } from "./types";
import type {
  CreateDraftPullRequestInput,
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
      Effect.die(`GitHub provider config error: ${error.detail}`),
    ),
  );

const mapIssue = (issue: GitHubIssue): Issue => ({
  iid: issue.iid,
  title: issue.title,
  description: issue.description,
  labels: issue.labels,
  updatedAt: issue.updated_at,
});

// GitHub carries an explicit `merged` boolean (a closed-but-unmerged PR keeps
// `merged: false`), so it is the single source of truth — no title/state sniffing.
const mapPullRequest = (pr: GitHubPullRequest): PullRequestRef => ({
  iid: pr.iid,
  isMerged: pr.merged === true,
});

const pullRequestAsOption = (
  pr: GitHubPullRequest | undefined,
): Option.Option<PullRequestRef> =>
  pr === undefined ? Option.none() : Option.some(mapPullRequest(pr));

const mapDiscussionAuthor = (author: string): string | null =>
  author === "unknown" ? null : author;

const mapDiscussion = (disc: GitHubDiscussionSummary): DiscussionSummary => ({
  id: DiscussionId(disc.id),
  isResolved: disc.resolved,
  notes: disc.notes.map((note) => ({
    author: mapDiscussionAuthor(note.author),
    body: note.body,
  })),
});

/** A GitHub-backed {@link GitProvider} Layer. */
export const GitHubProviderLive: Layer.Layer<GitProvider> = Layer.succeed(
  GitProvider,
  {
    listIssuesByLabels: (query: ListIssuesQuery) =>
      adaptCall(
        ghListIssuesByLabels({ include: query.include, exclude: query.exclude }),
      ).pipe(Effect.map((issues) => issues.map(mapIssue))),

    viewIssue: (iid: number) => adaptCall(ghViewIssue(iid)).pipe(Effect.map(mapIssue)),

    updateIssueLabels: (iid: number, changes: IssueLabelChange) =>
      adaptCall(ghUpdateIssueLabels(iid, { add: changes.add, remove: changes.remove })),

    addIssueNote: (iid: number, body: string) => adaptCall(ghAddIssueNote(iid, body)),

    findOpenPullRequestBySource: (sourceBranch: string) =>
      adaptCall(ghFindOpenPullRequestBySource(sourceBranch)).pipe(
        Effect.map(pullRequestAsOption),
      ),

    createDraftPullRequest: (input: CreateDraftPullRequestInput) =>
      adaptCall(ghCreateDraftPullRequest(input)).pipe(Effect.map(mapPullRequest)),

    viewPullRequest: (iid: number) =>
      adaptCall(ghViewPullRequest(iid)).pipe(Effect.map(mapPullRequest)),

    markPullRequestReady: (iid: number) => adaptCall(ghMarkPullRequestReady(iid)),

    // GitHub's merge endpoint returns a `{ merged }` ack, not a PR. The seam
    // expects a PullRequestRef, so after a successful merge we round-trip
    // through viewPullRequest(iid) to read the now-merged PR shape.
    mergePullRequest: (iid: number, input: MergeInput) =>
      adaptCall(
        ghMergePullRequest({
          iid,
          squash: input.shouldSquash,
          autoMerge: input.shouldAutoMerge,
        }).pipe(Effect.flatMap(() => ghViewPullRequest(iid))),
      ).pipe(Effect.map(mapPullRequest)),

    listDiscussions: (pullRequestIid: number) =>
      adaptCall(ghListDiscussions(pullRequestIid)).pipe(
        Effect.map((list) => list.map(mapDiscussion)),
      ),

    postDiscussion: (pullRequestIid: number, body: string) =>
      adaptCall(ghPostDiscussion(pullRequestIid, body)).pipe(Effect.map(DiscussionId)),

    postMrNote: (pullRequestIid: number, body: string) =>
      adaptCall(ghAddPullRequestNote(pullRequestIid, body)),

    replyToDiscussion: (pullRequestIid: number, discussionId: DiscussionId, body: string) =>
      adaptCall(ghReplyToDiscussion(pullRequestIid, discussionId, body)),

    resolveDiscussion: (pullRequestIid: number, discussionId: DiscussionId) =>
      adaptCall(ghResolveDiscussion(pullRequestIid, discussionId)),
  },
);
