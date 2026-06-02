import { Brand, Data } from "effect";

export type Labels = readonly string[];

export type DiscussionId = string & Brand.Brand<"DiscussionId">;
export const DiscussionId = Brand.nominal<DiscussionId>();

export type Issue = {
  readonly iid: number;
  readonly title: string;
  readonly description: string | null;
  readonly labels: Labels;
  /** ISO-8601 last-update time, or `""` when the endpoint omits it. */
  readonly updatedAt: string;
  /** Whether the issue is still open — the bit the "Blocked by #N" gate resolves a blocker on. */
  readonly isOpen: boolean;
};

export type PullRequestRef = {
  readonly iid: number;
  readonly isMerged: boolean;
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

/**
 * The provider-neutral anchor a line-anchored Finding rides on when posted.
 * `{ file, line }` on the new side of the diff — SHAs stay inside each Adapter
 * (see ADR 0003). A Finding the forge won't anchor falls back to a general
 * discussion, so this is optional on {@link GitProvider.postDiscussion}.
 */
export type DiscussionPosition = {
  readonly file: string;
  readonly line: number;
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

const MAX_DESCRIBE_CHARS = 200;

/** A one-line, human-readable description of a provider error. */
export const describeProviderError = (error: ProviderError): string => {
  switch (error._tag) {
    case "ProviderHttpError": {
      return `${error.method} ${error.path} → HTTP ${error.status}: ${error.body.slice(0, MAX_DESCRIBE_CHARS)}`;
    }
    case "ProviderNetworkError": {
      return `${error.method} ${error.path} — network error: ${String(error.cause).slice(0, MAX_DESCRIBE_CHARS)}`;
    }
    case "ProviderResponseError": {
      return `${error.method} ${error.path} — unexpected response: ${error.detail.slice(0, MAX_DESCRIBE_CHARS)}`;
    }
    case "ProviderConfigError": {
      return `Provider config error: ${error.detail.slice(0, MAX_DESCRIBE_CHARS)}`;
    }
    default: {
      const _exhaustive: never = error;
      return `unknown provider error: ${String(_exhaustive)}`;
    }
  }
};
