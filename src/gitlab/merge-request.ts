/**
 * Gitlab/merge-request.ts — typed REST operations on GitLab merge requests.
 *
 * Each function wraps `runGitLabRead`/`runGitLabWrite` from `./http.ts` with
 * the request shape and Effect schema for one MR endpoint: find/create the
 * draft MR, view it, un-draft it, and merge it.
 */
import { Effect, Schema } from "effect";
import type { ProviderError } from "../provider/types";
import { runGitLabRead, runGitLabWrite } from "./http";
import { MergeRequestSchema } from "./schema";
import type { GitLabMergeRequest } from "./schema";

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
 *
 * Flagged `nonIdempotent`: a merge transitions MR state and the API errors if
 * replayed on an already-merged MR, so a retry after a lost response must not
 * turn a successful merge into a reported failure.
 */
export const mergeMergeRequest = (
  params: MergeMergeRequestParams,
): Effect.Effect<GitLabMergeRequest, ProviderError> =>
  runGitLabWrite(
    {
      method: "PUT",
      path: `projects/:id/merge_requests/${params.iid}/merge`,
      nonIdempotent: true,
      body: {
        squash: params.squash,
        merge_when_pipeline_succeeds: params.autoMerge,
      },
    },
    MergeRequestSchema,
  );
