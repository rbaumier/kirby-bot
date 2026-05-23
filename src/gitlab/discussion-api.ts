/**
 * Gitlab/discussion-api.ts — REST operations over MR discussions.
 *
 * The pipeline uses a merge request's discussions as its review medium:
 * `review` posts findings, `evaluate` replies and resolves, `fix` resolves
 * what it fixed. The CLI in `scripts/mr-discussion.ts` exposes these to the
 * phase prompts.
 */
import { Effect } from "effect";
import { z } from "zod";
import type { DiscussionSummary } from "./discussion";
import { toDiscussionSummary } from "./discussion";
import { type GitLabError, GitLabResponseError } from "./errors";
import { runGitLabRead, runGitLabWrite } from "./http";

const discussionsPath = (mergeRequestIid: number): string =>
  `projects/:id/merge_requests/${mergeRequestIid}/discussions`;

/** Confirms a mutation took: the API response carries an `id`. */
const HasIdSchema = z.object({ id: z.union([z.string().min(1), z.number()]) });

/** The discussions list endpoint returns an array of opaque objects. */
const DiscussionListSchema = z.array(z.looseObject({}));

/** A single discussion comes back as an opaque object (validated by the model). */
const DiscussionSchema = z.looseObject({});

/** List every discussion on a merge request. */
export const listDiscussions = (
  mergeRequestIid: number,
): Effect.Effect<readonly DiscussionSummary[], GitLabError> =>
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
): Effect.Effect<void, GitLabError> =>
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
): Effect.Effect<void, GitLabError> =>
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
): Effect.Effect<void, GitLabError> => {
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
            new GitLabResponseError({
              method: "PUT",
              path,
              detail: `discussion ${discussionId} still unresolved after PUT`,
            }),
          );
    }),
  );
};
