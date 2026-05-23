/**
 * Gitlab/api.ts — typed REST operations the pipeline calls.
 *
 * Each function wraps `runGitLabRead`/`runGitLabWrite` from `./http.ts` with
 * the request shape and zod schema for one endpoint. Handlers call these
 * named operations rather than threading raw HTTP details — the boundary's
 * vocabulary lives here.
 *
 * Discussion endpoints stay in `./discussion-api.ts` to keep that domain
 * (the review medium) cohesive with its pure model.
 */
import { Effect } from "effect";
import { z } from "zod";
import { runGitLabRead, runGitLabWrite } from "./http";
import { type GitLabMergeRequest, IssueSchema, MergeRequestSchema } from "./schema";
import type { GitLabError } from "./errors";

/** A trimmed issue, as the pipeline consumes it. */
export type GitLabIssue = z.infer<typeof IssueSchema>;

// ─── Issue operations ──────────────────────────────────────────────────────

const issueArraySchema = z.array(IssueSchema);

/** List issues filtered by label, with optional exclusions. */
export const listIssuesByLabels = (params: {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly perPage?: number;
}): Effect.Effect<readonly GitLabIssue[], GitLabError> =>
  runGitLabRead(
    {
      method: "GET",
      path: "projects/:id/issues",
      query: {
        state: "opened",
        labels: params.include.join(","),
        not_labels: params.exclude?.join(",") || undefined,
        per_page: params.perPage ?? 100,
      },
    },
    issueArraySchema,
  );

/** Fetch a single issue by iid. */
export const viewIssue = (iid: number): Effect.Effect<GitLabIssue, GitLabError> =>
  runGitLabRead({ method: "GET", path: `projects/:id/issues/${iid}` }, IssueSchema);

/**
 * Update an issue's labels (add and/or remove). At least one side must be set.
 * Maps to the `PUT /issues/:iid` endpoint's `add_labels` / `remove_labels` fields.
 */
export const updateIssueLabels = (
  iid: number,
  changes: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
): Effect.Effect<void, GitLabError> => {
  const body: Record<string, unknown> = {};
  if (changes.add !== undefined && changes.add.length > 0) {
    body.add_labels = changes.add.join(",");
  }
  if (changes.remove !== undefined && changes.remove.length > 0) {
    body.remove_labels = changes.remove.join(",");
  }
  return runGitLabWrite(
    { method: "PUT", path: `projects/:id/issues/${iid}`, body },
    IssueSchema,
  ).pipe(Effect.asVoid);
};

/** Post a new note (comment) on an issue. */
export const addIssueNote = (iid: number, body: string): Effect.Effect<void, GitLabError> =>
  runGitLabWrite(
    {
      method: "POST",
      path: `projects/:id/issues/${iid}/notes`,
      body: { body },
    },
    z.object({ id: z.union([z.string(), z.number()]) }),
  ).pipe(Effect.asVoid);

// ─── Merge request operations ──────────────────────────────────────────────

const mrArraySchema = z.array(MergeRequestSchema);

/** Find the one open MR for a branch, if any. */
export const findOpenMergeRequestBySource = (
  sourceBranch: string,
): Effect.Effect<GitLabMergeRequest | undefined, GitLabError> =>
  runGitLabRead(
    {
      method: "GET",
      path: "projects/:id/merge_requests",
      query: { source_branch: sourceBranch, state: "opened", per_page: 1 },
    },
    mrArraySchema,
  ).pipe(Effect.map((list) => list[0]));

/** Create a draft MR. Returns the created MR (its iid is the orchestrator's handle). */
export const createDraftMergeRequest = (params: {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly description: string;
}): Effect.Effect<GitLabMergeRequest, GitLabError> =>
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
export const viewMergeRequest = (iid: number): Effect.Effect<GitLabMergeRequest, GitLabError> =>
  runGitLabRead(
    { method: "GET", path: `projects/:id/merge_requests/${iid}` },
    MergeRequestSchema,
  );

/** Schema for the title-bearing read used to compute the un-drafted title. */
const TitledMrSchema = z.object({ title: z.string() });

/**
 * Mark a draft MR as ready by stripping the "Draft:" / "WIP:" prefix from its
 * title. The GitLab API derives the draft flag from the title prefix, so the
 * canonical way to "un-draft" is to PUT a clean title.
 */
export const markMergeRequestReady = (iid: number): Effect.Effect<void, GitLabError> =>
  Effect.gen(function* () {
    const current = yield* runGitLabRead(
      { method: "GET", path: `projects/:id/merge_requests/${iid}` },
      TitledMrSchema,
    );
    const stripped = current.title.replace(/^(?:Draft|WIP)\s*[:\-]\s*/i, "");
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

/**
 * Merge a merge request. `autoMerge` requests merge-when-pipeline-succeeds,
 * which falls through to an immediate merge when no pipeline is configured.
 */
export const mergeMergeRequest = (params: {
  readonly iid: number;
  readonly squash: boolean;
  readonly autoMerge: boolean;
}): Effect.Effect<GitLabMergeRequest, GitLabError> =>
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
