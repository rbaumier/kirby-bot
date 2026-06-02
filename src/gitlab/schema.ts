/**
 * Gitlab/schema.ts — Effect schemas for the GitLab JSON the pipeline consumes.
 *
 * The REST API is an external, untrusted boundary: every shape that crosses
 * it is validated here rather than `as`-cast. The optional-with-default fields
 * absorb keys an endpoint may omit, so one schema serves several call sites.
 */
import { Schema } from "effect";

/** The four MR states the orchestrator routes on. Source of truth for `MrState`. */
export const MR_STATES = ["opened", "closed", "locked", "merged"] as const;

/** A merge-request `state` value as the pipeline routes on. */
export type MrState = (typeof MR_STATES)[number];

const KNOWN_STATES: ReadonlySet<string> = new Set(MR_STATES);

const isKnownState = (value: string): value is MrState => KNOWN_STATES.has(value);

/**
 * Strict state decoder: a value outside `MR_STATES` is rejected, not coerced.
 * Surviving an unknown state is more dangerous than failing — a future
 * server-side value (e.g. `"merging"`) silently read as `"opened"` could let
 * the orchestrator merge an MR that isn't ready. The `message` keeps the
 * offending value at the front of the decode error so it survives into the
 * one-line `ProviderResponseError` the boundary raises, and the run fails
 * loudly instead of acting on a misread state.
 */
const MrStateSchema = Schema.String.pipe(
  Schema.filter(isKnownState, {
    message: (issue) => `unknown MR state: ${JSON.stringify(issue.actual)}`,
  }),
);

/**
 * An issue from `GET /projects/:id/issues` and `GET /projects/:id/issues/:iid`.
 * One schema covers the queue read, the claim-time label check, and the
 * staleness sweep.
 */
export const IssueSchema = Schema.Struct({
  iid: Schema.Number,
  title: Schema.NonEmptyString,
  description: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
  labels: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), {
    default: () => [],
  }),
  updated_at: Schema.optionalWith(Schema.String, { default: () => "" }),
  // `opened` | `closed`. Deliberately lenient, unlike the strict MR `state`
  // decoder: an MR state drives merge routing, so a wrong/missing value is
  // dangerous and must fail loudly; an issue state only feeds the blocker gate,
  // where the mapper reduces it fail-safe (anything but `closed` → open). So a
  // missing/unknown value defaults to opened and the gate just over-waits.
  state: Schema.optionalWith(Schema.String, { default: () => "opened" }),
});

/**
 * A merge request from `GET/POST/PUT /projects/:id/merge_requests`.
 *
 * `state` is required and must be one of `MR_STATES`: an unknown value — or a
 * missing field — is rejected rather than coerced. The list/get/create/merge
 * endpoints always carry `state`, so its absence signals a malformed response
 * that should fail loudly, not a lifecycle state to guess at.
 */
export const MergeRequestSchema = Schema.Struct({
  iid: Schema.Number,
  web_url: Schema.optionalWith(Schema.String, { default: () => "" }),
  state: MrStateSchema,
});

/** A merge request as the orchestrator consumes it. */
export type GitLabMergeRequest = Schema.Schema.Type<typeof MergeRequestSchema>;

/**
 * The three SHAs a GitLab positioned discussion needs (`mr.diff_refs`), read
 * separately from {@link MergeRequestSchema} so the strict `state` decoder is
 * not coupled to this anchoring-only read. A line-anchored Finding is posted
 * against these refs; they are constant for a given MR head (see ADR 0003).
 */
export const DiffRefsSchema = Schema.Struct({
  diff_refs: Schema.Struct({
    base_sha: Schema.NonEmptyString,
    head_sha: Schema.NonEmptyString,
    start_sha: Schema.NonEmptyString,
  }),
});

/** The resolved diff refs for one MR. */
export type GitLabDiffRefs = Schema.Schema.Type<typeof DiffRefsSchema>["diff_refs"];
