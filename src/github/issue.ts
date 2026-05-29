/**
 * Github/issue.ts — typed REST operations on GitHub issues.
 *
 * Mirrors `src/gitlab/issue.ts`: one function per endpoint, each wrapping the
 * `runGitHub*` runners from `./http.ts` with the request shape and Effect schema
 * for one issue endpoint.
 *
 * Two GitHub-specific gaps vs GitLab are handled here:
 *   1. `GET /repos/:owner/:repo/issues` returns PRs too (a PR *is* an issue on
 *      GitHub); each PR entry carries a `pull_request` object — filtered out
 *      client-side so the queue never claims a PR as an issue.
 *   2. The list endpoint has no label-exclusion parameter (GitLab's
 *      `not[labels]`), so the `exclude` set is applied client-side after fetch.
 */
import { Effect, Schema } from "effect";
import type { ProviderError } from "../provider/types";
import { runGitHubIdempotentWrite, runGitHubRead, runGitHubWrite } from "./http";
import { IssueSchema, type GitHubIssue } from "./schema";

const issueArraySchema = Schema.Array(IssueSchema);

/** Params for {@link listIssuesByLabels}. */
type ListIssuesByLabelsParams = {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly perPage?: number;
};

/** Comma-join a label list, or `undefined` if the list is empty/missing. */
const joinOrUndefined = (labels: readonly string[] | undefined): string | undefined =>
  labels !== undefined && labels.length > 0 ? labels.join(",") : undefined;

/**
 * Drop the two kinds of entry the GitHub list endpoint returns that the queue
 * must never claim: pull requests (any entry carrying a `pull_request` object)
 * and issues bearing an `exclude` label (no server-side negation on this REST
 * endpoint, so it is done here).
 */
const filterIssues = (
  issues: readonly GitHubIssue[],
  exclude: readonly string[] | undefined,
): readonly GitHubIssue[] => {
  const excluded = new Set(exclude ?? []);
  return issues.filter(
    (issue) => issue.pull_request === undefined && !issue.labels.some((label) => excluded.has(label)),
  );
};

/** List issues filtered by label, with optional exclusions (PRs always removed). */
export const listIssuesByLabels = (
  params: ListIssuesByLabelsParams,
): Effect.Effect<readonly GitHubIssue[], ProviderError> =>
  runGitHubRead(
    {
      method: "GET",
      path: "repos/:owner/:repo/issues",
      query: {
        // GitHub names the open state `open` (GitLab uses `opened`).
        state: "open",
        // Omit `labels` entirely when `include` is empty, rather than send `labels=`.
        labels: joinOrUndefined(params.include),
        per_page: params.perPage ?? 100,
      },
    },
    issueArraySchema,
  ).pipe(Effect.map((issues) => filterIssues(issues, params.exclude)));

/** Fetch a single issue by iid. */
export const viewIssue = (iid: number): Effect.Effect<GitHubIssue, ProviderError> =>
  runGitHubRead({ method: "GET", path: `repos/:owner/:repo/issues/${iid}` }, IssueSchema);

/** Label add/remove changes for an issue. At least one side must be set. */
type LabelChanges = {
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
};

// The label add/remove responses are discarded (only the HTTP status confirms
// the write), so decode them loosely: GitHub echoes the label array on 200, but
// pinning a precise shape would turn any empty/204-style body into a spurious
// ProviderResponseError on an otherwise-successful write.
const LabelAckSchema = Schema.Unknown;

/** Schema for issue-comment creation — confirms the comment exists by checking an id. */
const NoteAckSchema = Schema.Struct({
  id: Schema.Union(Schema.String, Schema.Number),
});

/** A 404 from the label-remove DELETE means the label was already absent. */
const isNotFound = (error: ProviderError): boolean =>
  error._tag === "ProviderHttpError" && error.status === 404;

/**
 * Swallow a 404 as success — deleting a label GitHub no longer has on the issue
 * returns 404, but the post-condition (label absent) already holds, so label
 * removal stays idempotent.
 */
const swallowNotFound = (
  effect: Effect.Effect<void, ProviderError>,
): Effect.Effect<void, ProviderError> => effect.pipe(Effect.catchIf(isNotFound, () => Effect.void));

/**
 * Update an issue's labels (add and/or remove). At least one side must be set.
 *
 * GitHub has no single endpoint for add+remove, so this fans out:
 *   - add via `POST .../labels` (idempotent server-side, but a POST → no retry);
 *   - remove via one `DELETE .../labels/:name` per label (idempotent → retried),
 *     each tolerating a 404 (the label is already gone).
 */
export const updateIssueLabels = (
  iid: number,
  changes: LabelChanges,
): Effect.Effect<void, ProviderError> => {
  const add = changes.add ?? [];
  const remove = changes.remove ?? [];
  // No labels to add or remove → don't fire a request that would only no-op.
  if (add.length === 0 && remove.length === 0) {
    return Effect.void;
  }
  const addLabels =
    add.length > 0
      ? runGitHubWrite(
          { method: "POST", path: `repos/:owner/:repo/issues/${iid}/labels`, body: { labels: add } },
          LabelAckSchema,
        ).pipe(Effect.asVoid)
      : Effect.void;
  const removeLabels = Effect.forEach(
    remove,
    (name) =>
      swallowNotFound(
        runGitHubIdempotentWrite(
          {
            method: "DELETE",
            path: `repos/:owner/:repo/issues/${iid}/labels/${encodeURIComponent(name)}`,
          },
          LabelAckSchema,
        ).pipe(Effect.asVoid),
      ),
    { discard: true },
  );
  return addLabels.pipe(Effect.zipRight(removeLabels));
};

/** Post a new comment on an issue. */
export const addIssueNote = (iid: number, body: string): Effect.Effect<void, ProviderError> =>
  runGitHubWrite(
    { method: "POST", path: `repos/:owner/:repo/issues/${iid}/comments`, body: { body } },
    NoteAckSchema,
  ).pipe(Effect.asVoid);

/** Exposed for tests — never used in production code. */
export const __test = { filterIssues, isNotFound, swallowNotFound };
