import { Brand, Data } from "effect";

export type Labels = readonly string[];

export type DiscussionId = string & Brand.Brand<"DiscussionId">;
export const DiscussionId = Brand.nominal<DiscussionId>();

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

/** A one-line, human-readable description of a provider error. */
export function describeProviderError(error: ProviderError): string {
  switch (error._tag) {
    case "ProviderHttpError": {
      return `${error.method} ${error.path} → HTTP ${error.status}: ${error.body.slice(0, 200)}`;
    }
    case "ProviderNetworkError": {
      return `${error.method} ${error.path} — network error: ${String(error.cause).slice(0, 200)}`;
    }
    case "ProviderResponseError": {
      return `${error.method} ${error.path} — unexpected response: ${error.detail.slice(0, 200)}`;
    }
    case "ProviderConfigError": {
      return `Provider config error: ${error.detail.slice(0, 200)}`;
    }
    default: {
      const unreachable: never = error;
      throw new Error(`unreachable provider error: ${JSON.stringify(unreachable)}`);
    }
  }
}
