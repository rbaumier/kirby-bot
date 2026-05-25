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
 * State decoder. A value in `MR_STATES` passes through unchanged.
 * Any other string coerces to `"opened"` so the orchestrator survives
 * server-side state values it doesn't recognize.
 */
const MrStateSchema = Schema.transform(Schema.String, Schema.Literal(...MR_STATES), {
  strict: true,
  decode: (value): MrState => (isKnownState(value) ? value : "opened"),
  encode: (value) => value,
});

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
 * `state` resolves to one of `MR_STATES`. A missing field defaults to
 * `"opened"`; an unknown string also coerces to `"opened"` so a future
 * server-side state value doesn't hard-fail a list read.
 */
export const MergeRequestSchema = Schema.Struct({
  iid: Schema.Number,
  web_url: Schema.optionalWith(Schema.String, { default: () => "" }),
  state: Schema.optionalWith(MrStateSchema, { default: () => "opened" as const }),
});

/** A merge request as the orchestrator consumes it. */
export type GitLabMergeRequest = Schema.Schema.Type<typeof MergeRequestSchema>;
