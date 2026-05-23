import { Context, type Effect } from "effect";
import type {
  CreateDraftPrInput,
  DiscussionSummary,
  Issue,
  IssueLabelChange,
  ListIssuesQuery,
  MergeInput,
  ProviderError,
  PullRequestRef,
} from "./types";

export class GitProvider extends Context.Tag("GitProvider")<
  GitProvider,
  {
    readonly listIssuesByLabels: (
      query: ListIssuesQuery,
    ) => Effect.Effect<readonly Issue[], ProviderError>;

    readonly viewIssue: (
      iid: number,
    ) => Effect.Effect<Issue, ProviderError>;

    readonly updateIssueLabels: (
      iid: number,
      changes: IssueLabelChange,
    ) => Effect.Effect<void, ProviderError>;

    readonly addIssueNote: (
      iid: number,
      body: string,
    ) => Effect.Effect<void, ProviderError>;

    readonly findOpenPullRequestBySource: (
      sourceBranch: string,
    ) => Effect.Effect<PullRequestRef | undefined, ProviderError>;

    readonly createDraftPullRequest: (
      input: CreateDraftPrInput,
    ) => Effect.Effect<PullRequestRef, ProviderError>;

    readonly viewPullRequest: (
      iid: number,
    ) => Effect.Effect<PullRequestRef, ProviderError>;

    readonly markPullRequestReady: (
      iid: number,
    ) => Effect.Effect<void, ProviderError>;

    readonly mergePullRequest: (
      input: MergeInput,
    ) => Effect.Effect<PullRequestRef, ProviderError>;

    readonly listDiscussions: (
      prIid: number,
    ) => Effect.Effect<readonly DiscussionSummary[], ProviderError>;

    readonly postDiscussion: (
      prIid: number,
      body: string,
    ) => Effect.Effect<void, ProviderError>;

    readonly replyToDiscussion: (
      prIid: number,
      discussionId: string,
      body: string,
    ) => Effect.Effect<void, ProviderError>;

    readonly resolveDiscussion: (
      prIid: number,
      discussionId: string,
    ) => Effect.Effect<void, ProviderError>;
  }
>() {}
