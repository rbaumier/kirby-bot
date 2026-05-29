/**
 * Github/schema.ts — Effect schemas for the GitHub JSON the pipeline consumes.
 *
 * The REST/GraphQL API is an external, untrusted boundary: every shape that
 * crosses it is validated here rather than `as`-cast. GitHub's own vocabulary
 * (`number`, `body`) is mapped to the pipeline's neutral vocabulary (`iid`,
 * `description`) at decode time so call sites stay provider-neutral.
 */
import { Schema } from "effect";

/** The two PR states the orchestrator routes on. */
export const PR_STATES = ["open", "closed"] as const;

/** A pull-request `state` value as the pipeline routes on. */
export type PrState = (typeof PR_STATES)[number];

const KNOWN_PR_STATES: ReadonlySet<string> = new Set(PR_STATES);

const isKnownPrState = (value: string): value is PrState => KNOWN_PR_STATES.has(value);

/**
 * Strict state decoder: a value outside `PR_STATES` is rejected, not coerced.
 * Surviving an unknown state is more dangerous than failing — a future
 * server-side value silently read as `"open"` could let the orchestrator act
 * on a PR that isn't in the state it thinks. The `message` keeps the offending
 * value at the front of the decode error so it survives into the one-line
 * `ProviderResponseError` the boundary raises.
 */
const PrStateSchema = Schema.String.pipe(
  Schema.filter(isKnownPrState, {
    message: (issue) => `unknown PR state: ${JSON.stringify(issue.actual)}`,
  }),
);

/**
 * GitHub labels arrive as `[{ name }]`; the pipeline consumes a flat `string[]`.
 * Transform at the boundary so call sites never see GitHub's label object shape.
 */
const LabelNames = Schema.transform(
  Schema.Array(Schema.Struct({ name: Schema.NonEmptyString })),
  Schema.Array(Schema.String),
  {
    strict: true,
    decode: (labels) => labels.map((label) => label.name),
    encode: (names) => names.map((name) => ({ name })),
  },
);

/**
 * An issue from `GET /repos/:owner/:repo/issues` and `.../issues/:number`.
 *
 * GitHub's `number` is exposed as `iid`, and `body` as `description`, so the
 * neutral pipeline reads the same field names regardless of backend. The issues
 * listing endpoint also returns pull requests, each carrying a `pull_request`
 * object — kept (optional) so the listing can filter PRs out.
 */
export const IssueSchema = Schema.Struct({
  iid: Schema.propertySignature(Schema.Number).pipe(Schema.fromKey("number")),
  title: Schema.NonEmptyString,
  description: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }).pipe(Schema.fromKey("body")),
  labels: Schema.optionalWith(LabelNames, { default: () => [] }),
  updated_at: Schema.optionalWith(Schema.String, { default: () => "" }),
  pull_request: Schema.optional(Schema.Object),
});

/** An issue as the orchestrator consumes it. */
export type GitHubIssue = Schema.Schema.Type<typeof IssueSchema>;

/**
 * A pull request from `GET/POST/PATCH /repos/:owner/:repo/pulls`.
 *
 * `state` is required and must be one of `PR_STATES`: an unknown value — or a
 * missing field — is rejected rather than coerced. `node_id` is the opaque ID
 * GraphQL mutations address; `head.sha` anchors review comments.
 */
export const PullRequestSchema = Schema.Struct({
  iid: Schema.propertySignature(Schema.Number).pipe(Schema.fromKey("number")),
  draft: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  merged: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  state: PrStateSchema,
  node_id: Schema.String,
  head: Schema.Struct({ sha: Schema.String }),
  html_url: Schema.optionalWith(Schema.String, { default: () => "" }),
});

/** A pull request as the orchestrator consumes it. */
export type GitHubPullRequest = Schema.Schema.Type<typeof PullRequestSchema>;
