/**
 * Gitlab/merge-request.ts — typed REST operations on GitLab merge requests.
 *
 * Each function wraps `runGitLabRead`/`runGitLabWrite` from `./http.ts` with
 * the request shape and Effect schema for one MR endpoint: find/create the
 * draft MR, view it, un-draft it, and merge it.
 */
import { Console, Effect, Schedule, Schema } from "effect";
import type { ProviderError } from "../provider/types";
import { runGitLabIdempotentWrite, runGitLabRead, runGitLabWrite } from "./http";
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
 * GitLab recomputes an MR's mergeability asynchronously after any write that
 * could change it (un-drafting, a push, a rebase). While that re-check is in
 * flight the merge endpoint rejects the call with HTTP 405, so we wait for it
 * to settle before merging (issue #41). These are the *in-flight* values of
 * `detailed_merge_status` (GitLab ≥ 15.6) and the legacy `merge_status` —
 * everything else is a settled verdict the merge call can act on.
 */
const MERGEABILITY_PENDING: ReadonlySet<string> = new Set([
  "unchecked",
  "checking",
  "preparing",
]);

/** True while GitLab is still (re)computing the MR's mergeability. */
const isMergeabilityPending = (status: string | undefined): boolean =>
  status !== undefined && MERGEABILITY_PENDING.has(status);

/** Narrow read for the mergeability poll — prefers the detailed status. */
const MergeabilitySchema = Schema.Struct({
  detailed_merge_status: Schema.optional(Schema.String),
  merge_status: Schema.optional(Schema.String),
});

const readMergeStatus = (iid: number): Effect.Effect<string | undefined, ProviderError> =>
  runGitLabRead(
    { method: "GET", path: `projects/:id/merge_requests/${iid}` },
    MergeabilitySchema,
  ).pipe(Effect.map((mr) => mr.detailed_merge_status ?? mr.merge_status));

/**
 * Poll until GitLab finishes (re)computing mergeability so the merge that
 * follows isn't racily rejected with 405. Bounded to ~10s (500ms-spaced
 * reads, 20 recurrences); on timeout we proceed best-effort and let the merge
 * call surface any genuine block. An older instance that omits both status
 * fields reports `undefined` — treated as settled, never looped on.
 */
const waitForMergeabilitySettled = (iid: number): Effect.Effect<void, ProviderError> =>
  readMergeStatus(iid).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis").pipe(Schedule.intersect(Schedule.recurs(20))),
      until: (status) => !isMergeabilityPending(status),
    }),
    Effect.asVoid,
  );

/**
 * Mark a draft MR as ready by stripping the "Draft:" / "WIP:" prefix from its
 * title. The GitLab API derives the draft flag from the title prefix, so the
 * canonical way to "un-draft" is to PUT a clean title.
 *
 * Un-drafting kicks off an async mergeability re-check, so we then wait for it
 * to settle before returning — otherwise the immediately following merge races
 * the check and is rejected with HTTP 405 (issue #41). The wait is best-effort:
 * a poll-read failure must not turn a successful un-draft into a phase failure,
 * but it is logged rather than swallowed silently so an auth/network failure
 * during the wait stays diagnosable.
 */
export const markMergeRequestReady = (iid: number): Effect.Effect<void, ProviderError> =>
  Effect.gen(function* () {
    const current = yield* runGitLabRead(
      { method: "GET", path: `projects/:id/merge_requests/${iid}` },
      TitledMrSchema,
    );
    const stripped = current.title.replace(DRAFT_PREFIX, "");
    if (stripped !== current.title) {
      yield* runGitLabIdempotentWrite(
        {
          method: "PUT",
          path: `projects/:id/merge_requests/${iid}`,
          body: { title: stripped },
        },
        MergeRequestSchema,
      );
    }
    yield* waitForMergeabilitySettled(iid).pipe(
      Effect.tapError((error) =>
        Console.log(
          `  ⚠ MR !${iid}: mergeability re-check unreadable after un-draft (${error._tag}) — merging anyway`,
        ),
      ),
      Effect.ignore,
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
 * Runs exactly once (`runGitLabWrite`, not the idempotent variant): a merge
 * transitions MR state and the API errors if replayed on an already-merged MR,
 * so a retry after a lost response must not turn a success into a failure.
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

/** Exposed for tests — never used in production code. */
export const __test = { isMergeabilityPending };
