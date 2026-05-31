/**
 * Gitlab/discussion.ts — merge-request discussions: the pure model plus the
 * typed REST operations on them.
 *
 * `toDiscussionSummary` maps raw GitLab discussion JSON to the trimmed shape
 * the evaluate/fix phases reason about — pure and unit-testable on its own. The
 * REST operations below wrap `./http.ts` for the review medium: `review` posts
 * findings, `evaluate` replies and resolves, `fix` resolves what it fixed. The
 * CLI in `scripts/mr-discussion.ts` exposes these to the phase prompts.
 */
import { Effect, Schema } from "effect";
import { ProviderResponseError } from "../provider/types";
import type { ProviderError } from "../provider/types";
import { runGitLabIdempotentWrite, runGitLabRead, runGitLabWrite } from "./http";
import type { GitLabDiffRefs } from "./schema";

/** A discussion reduced to what the pipeline reasons about. */
export type DiscussionSummary = {
  readonly id: string;
  readonly resolved: boolean;
  readonly notes: readonly { readonly author: string; readonly body: string }[];
};

/** The fields of a raw GitLab note we look at — every value is untrusted. */
type RawNote = {
  readonly body: unknown;
  readonly resolvable: unknown;
  readonly resolved: unknown;
  readonly author: { readonly username: unknown } | null;
};

/** Type guard: returns true if `val` is a non-null object usable as a record. */
const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

/**
 * Map one raw GitLab discussion object to a {@link DiscussionSummary}.
 *
 * A discussion is "resolved" iff every *resolvable* note is resolved.
 * No resolvable notes (a bare system note) maps to `resolved: true`.
 * It is not a blocking review thread, so it must not block convergence.
 * Pure and garbage-safe — non-object entries are dropped.
 */
export function toDiscussionSummary(raw: unknown): DiscussionSummary {
  // Normalize `raw` to a record so we can safely read `.id` and `.notes`.
  const object: Record<string, unknown> = isRecord(raw) ? raw : {};
  const rawNotes: readonly RawNote[] = (Array.isArray(object.notes) ? object.notes : []).filter(
    (note): note is RawNote => typeof note === "object" && note !== null,
  );

  const resolvableNotes = rawNotes.filter((note) => note.resolvable);
  const resolved = resolvableNotes.every((note) => note.resolved);

  // `object.id` may be any type — coerce primitives safely.
  const idValue = object.id;
  const id = typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : "";

  return {
    id,
    resolved,
    notes: rawNotes.map((note) => ({
      author: typeof note.author?.username === "string" ? note.author.username : "unknown",
      body: typeof note.body === "string" ? note.body : "",
    })),
  };
}

// ─── REST operations ────────────────────────────────────────────────────────

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

/** Anchor for a line-positioned discussion: the Finding's line plus the MR's refs. */
export type DiscussionAnchor = {
  readonly file: string;
  readonly line: number;
  readonly refs: GitLabDiffRefs;
};

/**
 * Create a general, resolvable discussion carrying `body`. Returns the created
 * thread's id (stringified — GitLab discussion ids are string hashes), which
 * callers join review findings to evaluator triage on.
 */
const postGeneralDiscussion = (
  mergeRequestIid: number,
  body: string,
): Effect.Effect<string, ProviderError> =>
  runGitLabWrite(
    {
      method: "POST",
      path: discussionsPath(mergeRequestIid),
      body: { body },
    },
    HasIdSchema,
  ).pipe(Effect.map((res) => String(res.id)));

/**
 * GitLab rejects a position it cannot anchor (a context line that also needs
 * `old_line`, or a line outside the diff) with HTTP 400 whose body names the
 * line/position. Matched narrowly — not a blanket 400 — so a genuinely
 * malformed payload (bad SHAs) still surfaces instead of silently degrading
 * every Finding to a general discussion (see ADR 0003).
 */
const isLineNotAnchorable = (error: ProviderError): boolean =>
  error._tag === "ProviderHttpError" &&
  error.status === 400 &&
  /line|position/i.test(error.body);

/**
 * Post `body` as a discussion. With an `anchor`, POST it as a discussion
 * positioned on the new side of the diff; if GitLab won't anchor that line
 * (HTTP 400), fall back to a general discussion with `file:line` kept in the
 * body. Without an anchor (prose summary, CLI `post`), post general directly.
 */
export const postDiscussion = (
  mergeRequestIid: number,
  body: string,
  anchor?: DiscussionAnchor,
): Effect.Effect<string, ProviderError> => {
  if (anchor === undefined) {
    return postGeneralDiscussion(mergeRequestIid, body);
  }
  return runGitLabWrite(
    {
      method: "POST",
      path: discussionsPath(mergeRequestIid),
      body: {
        body,
        position: {
          position_type: "text",
          base_sha: anchor.refs.base_sha,
          head_sha: anchor.refs.head_sha,
          start_sha: anchor.refs.start_sha,
          new_path: anchor.file,
          old_path: anchor.file,
          new_line: anchor.line,
        },
      },
    },
    HasIdSchema,
  ).pipe(
    Effect.map((res) => String(res.id)),
    Effect.catchIf(isLineNotAnchorable, () => postGeneralDiscussion(mergeRequestIid, body)),
  );
};

/** Exposed for tests — never used in production code. */
export const __test = { isLineNotAnchorable };

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
  return runGitLabIdempotentWrite(
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
