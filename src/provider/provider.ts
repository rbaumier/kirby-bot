import { Context } from "effect";
import type { Effect, Option } from "effect";
import type {
  CreateDraftPullRequestInput,
  DiscussionId,
  DiscussionSummary,
  Issue,
  IssueLabelChange,
  ListIssuesQuery,
  MergeInput,
  ProviderCallError,
  PullRequestRef,
} from "./types";

export class GitProvider extends Context.Tag("GitProvider")<
  GitProvider,
  {
    readonly listIssuesByLabels: (
      query: ListIssuesQuery,
    ) => Effect.Effect<readonly Issue[], ProviderCallError>;

    readonly viewIssue: (
      iid: number,
    ) => Effect.Effect<Issue, ProviderCallError>;

    readonly updateIssueLabels: (
      iid: number,
      changes: IssueLabelChange,
    ) => Effect.Effect<void, ProviderCallError>;

    readonly addIssueNote: (
      iid: number,
      body: string,
    ) => Effect.Effect<void, ProviderCallError>;

    readonly findOpenPullRequestBySource: (
      sourceBranch: string,
    ) => Effect.Effect<Option.Option<PullRequestRef>, ProviderCallError>;

    readonly createDraftPullRequest: (
      input: CreateDraftPullRequestInput,
    ) => Effect.Effect<PullRequestRef, ProviderCallError>;

    readonly viewPullRequest: (
      iid: number,
    ) => Effect.Effect<PullRequestRef, ProviderCallError>;

    readonly markPullRequestReady: (
      iid: number,
    ) => Effect.Effect<void, ProviderCallError>;

    readonly mergePullRequest: (
      iid: number,
      input: MergeInput,
    ) => Effect.Effect<PullRequestRef, ProviderCallError>;

    readonly listDiscussions: (
      pullRequestIid: number,
    ) => Effect.Effect<readonly DiscussionSummary[], ProviderCallError>;

    readonly postDiscussion: (
      pullRequestIid: number,
      body: string,
    ) => Effect.Effect<DiscussionId, ProviderCallError>;

    readonly replyToDiscussion: (
      pullRequestIid: number,
      discussionId: DiscussionId,
      body: string,
    ) => Effect.Effect<void, ProviderCallError>;

    readonly resolveDiscussion: (
      pullRequestIid: number,
      discussionId: DiscussionId,
    ) => Effect.Effect<void, ProviderCallError>;
  }
>() {}
