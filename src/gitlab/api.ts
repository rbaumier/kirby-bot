/**
 * Gitlab/api.ts — typed REST operations the pipeline calls.
 *
 * Each function wraps `runGitLabRead`/`runGitLabWrite` from `./http.ts` with
 * the request shape and Effect schema for one endpoint. Handlers call these
 * named operations rather than threading raw HTTP details — the boundary's
 * vocabulary lives here. Issue, MR, and Discussion endpoints share this
 * module since they are all thin REST wrappers over the same HTTP seam.
 */
import { Effect, Schema } from "effect";
import { toDiscussionSummary } from "./discussion";
import type { DiscussionSummary } from "./discussion";
import { ProviderResponseError } from "../provider/types";
import type { ProviderError } from "../provider/types";
import { runGitLabRead, runGitLabWrite } from "./http";
import { IssueSchema, MergeRequestSchema } from "./schema";
import type { GitLabMergeRequest } from "./schema";

/** A trimmed issue, as the pipeline consumes it. */
export type GitLabIssue = Schema.Schema.Type<typeof IssueSchema>;

// ─── Issue operations ──────────────────────────────────────────────────────

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
  return runGitLabWrite(
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

// ─── Merge request operations ──────────────────────────────────────────────

const mrArraySchema = Schema.Array(MergeRequestSchema);

/** Find the one open MR for a branch, if any. */
export const findOpenMergeRequestBySource = (
  sourceBranch: string,
): Effect.Effect<GitLabMergeRequest | undefined, ProviderError> =>
  runGitLabRead(
    {
      method: "GET",
      path: "projects/:id/merge_requests",
      query: { source_branch: sourceBranch, state: "opened", per_page: 1 },
    },
    mrArraySchema,
  ).pipe(Effect.map((list) => list.at(0)));

/** Params for {@link createDraftMergeRequest}. */
type CreateDraftMergeRequestParams = {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly description: string;
};

/** Create a draft MR. Returns the created MR (its iid is the orchestrator's handle). */
export const createDraftMergeRequest = (
  params: CreateDraftMergeRequestParams,
): Effect.Effect<GitLabMergeRequest, ProviderError> =>
  runGitLabWrite(
    {
      method: "POST",
      path: "projects/:id/merge_requests",
      body: {
        source_branch: params.sourceBranch,
        target_branch: params.targetBranch,
        // GitLab derives the "draft" flag from the title prefix.
        title: `Draft: ${params.title}`,
        description: params.description,
        remove_source_branch: true,
        squash: true,
      },
    },
    MergeRequestSchema,
  );

/** Fetch a single MR by iid. */
export const viewMergeRequest = (iid: number): Effect.Effect<GitLabMergeRequest, ProviderError> =>
  runGitLabRead(
    { method: "GET", path: `projects/:id/merge_requests/${iid}` },
    MergeRequestSchema,
  );

/** Schema for the title-bearing read used to compute the un-drafted title. */
const TitledMrSchema = Schema.Struct({ title: Schema.String });

/**
 * Strip a leading `Draft:` / `Draft -` / `WIP:` / `WIP -` prefix (and any
 * surrounding whitespace). Case-insensitive.
 */
const DRAFT_PREFIX = /^(?:Draft|WIP)\s*[:-]\s*/i;

/**
 * Mark a draft MR as ready by stripping the "Draft:" / "WIP:" prefix from its
 * title. The GitLab API derives the draft flag from the title prefix, so the
 * canonical way to "un-draft" is to PUT a clean title.
 */
export const markMergeRequestReady = (iid: number): Effect.Effect<void, ProviderError> =>
  Effect.gen(function* () {
    const current = yield* runGitLabRead(
      { method: "GET", path: `projects/:id/merge_requests/${iid}` },
      TitledMrSchema,
    );
    const stripped = current.title.replace(DRAFT_PREFIX, "");
    if (stripped === current.title) {
      return; // already ready
    }
    yield* runGitLabWrite(
      {
        method: "PUT",
        path: `projects/:id/merge_requests/${iid}`,
        body: { title: stripped },
      },
      MergeRequestSchema,
    );
  });

/** Params for {@link mergeMergeRequest}. */
type MergeMergeRequestParams = {
  readonly iid: number;
  readonly squash: boolean;
  readonly autoMerge: boolean;
};

/**
 * Merge a merge request. `autoMerge` requests merge-when-pipeline-succeeds,
 * which falls through to an immediate merge when no pipeline is configured.
 */
export const mergeMergeRequest = (
  params: MergeMergeRequestParams,
): Effect.Effect<GitLabMergeRequest, ProviderError> =>
  runGitLabWrite(
    {
      method: "PUT",
      path: `projects/:id/merge_requests/${params.iid}/merge`,
      body: {
        squash: params.squash,
        merge_when_pipeline_succeeds: params.autoMerge,
      },
    },
    MergeRequestSchema,
  );

// ─── Discussion operations ────────────────────────────────────────────────
//
// The pipeline uses a merge request's discussions as its review medium:
// `review` posts findings, `evaluate` replies and resolves, `fix` resolves
// what it fixed. The CLI in `scripts/mr-discussion.ts` exposes these to the
// phase prompts.

const discussionsPath = (mergeRequestIid: number): string =>
  `projects/:id/merge_requests/${mergeRequestIid}/discussions`;

/** Confirms a mutation took: the API response carries an `id`. */
const HasIdSchema = Schema.Struct({
  id: Schema.Union(Schema.NonEmptyString, Schema.Number),
});

/** The discussions list endpoint returns an array of opaque objects. */
const DiscussionListSchema = Schema.Array(Schema.Object);

/** A single discussion comes back as an opaque object (validated by the model). */
const DiscussionSchema = Schema.Object;

/** List every discussion on a merge request. */
export const listDiscussions = (
  mergeRequestIid: number,
): Effect.Effect<readonly DiscussionSummary[], ProviderError> =>
  runGitLabRead(
    {
      method: "GET",
      path: discussionsPath(mergeRequestIid),
      query: { per_page: 100 },
    },
    DiscussionListSchema,
  ).pipe(Effect.map((raw) => raw.map((disc) => toDiscussionSummary(disc))));

/** Create a new general, resolvable discussion carrying `body`. */
export const postDiscussion = (
  mergeRequestIid: number,
  body: string,
): Effect.Effect<void, ProviderError> =>
  runGitLabWrite(
    {
      method: "POST",
      path: discussionsPath(mergeRequestIid),
      body: { body },
    },
    HasIdSchema,
  ).pipe(Effect.asVoid);

/**
 * Add a note (a reply) to an existing discussion thread. The response is
 * verified — a note with an `id` must come back — so a silent half-success
 * cannot pass for a delivered reply.
 */
export const replyToDiscussion = (
  mergeRequestIid: number,
  discussionId: string,
  body: string,
): Effect.Effect<void, ProviderError> =>
  runGitLabWrite(
    {
      method: "POST",
      path: `${discussionsPath(mergeRequestIid)}/${discussionId}/notes`,
      body: { body },
    },
    HasIdSchema,
  ).pipe(Effect.asVoid);

/**
 * Resolve a discussion thread, then verify it came back resolved.
 * A 2xx response that no-ops must not pass for a resolved thread.
 */
export const resolveDiscussion = (
  mergeRequestIid: number,
  discussionId: string,
): Effect.Effect<void, ProviderError> => {
  const path = `${discussionsPath(mergeRequestIid)}/${discussionId}`;
  return runGitLabWrite(
    {
      method: "PUT",
      path,
      body: { resolved: true },
    },
    DiscussionSchema,
  ).pipe(
    Effect.flatMap((raw) => {
      const summary = toDiscussionSummary(raw);
      return summary.resolved
        ? Effect.void
        : Effect.fail(
            new ProviderResponseError({
              method: "PUT",
              path,
              detail: `discussion ${discussionId} still unresolved after PUT`,
            }),
          );
    }),
  );
};
