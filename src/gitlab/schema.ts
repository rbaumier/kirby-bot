/**
 * Gitlab/schema.ts — Effect schemas for the GitLab JSON the pipeline consumes.
 *
 * The REST API is an external, untrusted boundary: every shape that crosses
 * it is validated here rather than `as`-cast. The optional-with-default fields
 * absorb keys an endpoint may omit, so one schema serves several call sites.
 */
import { Schema } from "effect";

/** The four MR states the orchestrator routes on; any other string falls through to `opened`. */
export const MR_STATES = ["opened", "closed", "locked", "merged"] as const;

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
});

/**
 * A merge request from `GET/POST/PUT /projects/:id/merge_requests`.
 *
 * `state` is constrained to the four known values. Missing state defaults
 * to `"opened"`. An unknown value is rejected — a server-side state change
 * should be surfaced, not silently coerced.
 */
export const MergeRequestSchema = Schema.Struct({
  iid: Schema.Number,
  web_url: Schema.optionalWith(Schema.String, { default: () => "" }),
  state: Schema.optionalWith(
    Schema.Union(...MR_STATES.map((value) => Schema.Literal(value))),
    { default: () => "opened" as const },
  ),
});

/** A merge request as the orchestrator consumes it. */
export type GitLabMergeRequest = Schema.Schema.Type<typeof MergeRequestSchema>;
