import { Data } from "effect";

export type Labels = readonly string[];

export type DiscussionId = string & { readonly __brand: "DiscussionId" };

export type Issue = {
  readonly iid: number;
  readonly title: string;
  readonly description: string | null;
  readonly labels: Labels;
  readonly updatedAt: string;
  readonly webUrl: string;
};

export type PullRequestState = "opened" | "merged" | "closed";

export type PullRequestRef = {
  readonly iid: number;
  readonly webUrl: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly sourceBranch: string;
  readonly targetBranch: string;
};

export type CreateDraftPullRequestInput = {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly description: string;
};

export type MergeInput = {
  readonly iid: number;
  readonly shouldSquash: boolean;
  readonly shouldAutoMerge: boolean;
};

export type DiscussionNote = {
  readonly author: string | null;
  readonly body: string;
};

export type DiscussionSummary = {
  readonly id: DiscussionId;
  readonly isResolved: boolean;
  readonly notes: readonly DiscussionNote[];
};

export type ListIssuesQuery = {
  readonly include: Labels;
  readonly exclude: Labels;
};

export type IssueLabelChange = {
  readonly add: Labels;
  readonly remove: Labels;
};

export class ProviderHttpError extends Data.TaggedError("ProviderHttpError")<{
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: string;
}> {}

export class ProviderNetworkError extends Data.TaggedError(
  "ProviderNetworkError",
)<{
  readonly method: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

export class ProviderResponseError extends Data.TaggedError(
  "ProviderResponseError",
)<{
  readonly method: string;
  readonly path: string;
  readonly detail: string;
}> {}

export class ProviderConfigError extends Data.TaggedError(
  "ProviderConfigError",
)<{
  readonly detail: string;
}> {}

export type ProviderCallError =
  | ProviderHttpError
  | ProviderNetworkError
  | ProviderResponseError;

export type ProviderError = ProviderCallError | ProviderConfigError;
