/**
 * Gitlab/issue.ts — typed REST operations on GitLab issues.
 *
 * Each function wraps `runGitLabRead`/`runGitLabWrite` from `./http.ts` with
 * the request shape and Effect schema for one issue endpoint. The queue read,
 * the claim-time label updates, and the failure-note posting all live here.
 */
import { Effect, Schema } from "effect";
import type { ProviderError } from "../provider/types";
import { runGitLabIdempotentWrite, runGitLabRead, runGitLabWrite } from "./http";
import { IssueSchema } from "./schema";

/** A trimmed issue, as the pipeline consumes it. */
export type GitLabIssue = Schema.Schema.Type<typeof IssueSchema>;

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

/** List issues filtered by label, with optional exclusions. */
export const listIssuesByLabels = (
  params: ListIssuesByLabelsParams,
): Effect.Effect<readonly GitLabIssue[], ProviderError> =>
  runGitLabRead(
    {
      method: "GET",
      path: "projects/:id/issues",
      query: {
        state: "opened",
        labels: params.include.join(","),
        // GitLab REST uses bracket-notation `not[labels]` for the negation —
        // `not_labels` is silently ignored by the server.
        "not[labels]": joinOrUndefined(params.exclude),
        per_page: params.perPage ?? 100,
      },
    },
    issueArraySchema,
  );

/** Fetch a single issue by iid. */
export const viewIssue = (iid: number): Effect.Effect<GitLabIssue, ProviderError> =>
  runGitLabRead({ method: "GET", path: `projects/:id/issues/${iid}` }, IssueSchema);

/** Schema for issue-note creation — confirms the note exists by checking an id. */
const NoteAckSchema = Schema.Struct({
  id: Schema.Union(Schema.String, Schema.Number),
});

/** Label add/remove changes for an issue. At least one side must be set. */
type LabelChanges = {
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
};

/**
 * Update an issue's labels (add and/or remove). At least one side must be set.
 * Maps to the `PUT /issues/:iid` endpoint's `add_labels` / `remove_labels` fields.
 */
export const updateIssueLabels = (
  iid: number,
  changes: LabelChanges,
): Effect.Effect<void, ProviderError> => {
  const addLabels = joinOrUndefined(changes.add);
  const removeLabels = joinOrUndefined(changes.remove);
  const body: Record<string, unknown> = {
    ...(addLabels === undefined ? {} : { add_labels: addLabels }),
    ...(removeLabels === undefined ? {} : { remove_labels: removeLabels }),
  };
  // No labels to add or remove → don't fire an empty PUT that would no-op
  // server-side but still bump `updated_at` and waste a write.
  if (Object.keys(body).length === 0) {
    return Effect.void;
  }
  return runGitLabIdempotentWrite(
    { method: "PUT", path: `projects/:id/issues/${iid}`, body },
    IssueSchema,
  ).pipe(Effect.asVoid);
};

/** Post a new note (comment) on an issue. */
export const addIssueNote = (iid: number, body: string): Effect.Effect<void, ProviderError> =>
  runGitLabWrite(
    {
      method: "POST",
      path: `projects/:id/issues/${iid}/notes`,
      body: { body },
    },
    NoteAckSchema,
  ).pipe(Effect.asVoid);
