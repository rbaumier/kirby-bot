/**
 * Github/http.ts — the typed, retrying boundary to the GitHub REST + GraphQL API.
 *
 * Mirrors `src/gitlab/http.ts`: three REST runners, deliberately kept separate.
 * `runGitHubRead` retries transient failures — safe only for reads since a
 * retry after a lost response is harmless.
 * `runGitHubIdempotentWrite` retries idempotent mutations (PUT/DELETE).
 * `runGitHubWrite` runs a POST (or any non-idempotent write) exactly once: a
 * POST creates a new resource each time, so a retry after a lost response would
 * duplicate it.
 *
 * Several GitHub operations have no REST equivalent (un-drafting a PR, resolving
 * a review thread), so this boundary also exposes a minimal GraphQL runner
 * ({@link runGitHubGraphQL}).
 *
 * Configuration is read from environment variables only:
 *   - `$KIRBY_GITHUB_TOKEN` — a personal access token (PAT) with `repo` scope.
 *   - `$GITHUB_REPO`        — the `owner/repo` slug.
 *   - `$GITHUB_HOST`        — optional, default `https://api.github.com`; for
 *     GitHub Enterprise use `https://<host>/api/v3`.
 * A missing required one fails fast with a {@link ProviderConfigError} at startup.
 *
 * The retry policy and `decodeBody` are duplicated from `src/gitlab/http.ts` by
 * design — the two boundaries stay independent.
 */
import { Effect, ParseResult, Schedule, Schema } from "effect";
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseError,
} from "../provider/types";
import type { ProviderError } from "../provider/types";

/** The resolved GitHub connection: REST + GraphQL base URLs, token, and repo ref. */
type GitHubConfig = {
  readonly baseUrl: string;
  readonly graphqlUrl: string;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
};

/** Trailing `/` to strip from `$GITHUB_HOST` before composing the API base URL. */
const TRAILING_SLASH = /\/$/;

/** GitHub Enterprise REST base ends with `/api/v3`; its GraphQL sibling is `/api/graphql`. */
const ENTERPRISE_REST_SUFFIX = "/api/v3";

/** Read a required env var, failing with a clear {@link ProviderConfigError} if unset. */
const requireEnv = (name: string, hint: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new ProviderConfigError({ detail: `${name} is not set — ${hint}` });
  }
  return value;
};

/** Derive the GraphQL endpoint from the REST base URL. */
const graphqlUrlFor = (baseUrl: string): string =>
  baseUrl.endsWith(ENTERPRISE_REST_SUFFIX)
    ? `${baseUrl.slice(0, -ENTERPRISE_REST_SUFFIX.length)}/api/graphql`
    : `${baseUrl}/graphql`;

/** Resolve the GitHub config from environment variables. PAT-only by design. */
const computeConfig = (): GitHubConfig => {
  const host = (process.env.GITHUB_HOST || "https://api.github.com").replace(TRAILING_SLASH, "");
  const slug = requireEnv("GITHUB_REPO", "the owner/repo slug");
  const token = requireEnv("KIRBY_GITHUB_TOKEN", "a personal access token with the `repo` scope");
  const [owner, repo] = slug.split("/");
  if (owner === undefined || owner === "" || repo === undefined || repo === "" || slug.includes("/", slug.indexOf("/") + 1)) {
    throw new ProviderConfigError({ detail: `GITHUB_REPO must be \`owner/repo\`, got ${JSON.stringify(slug)}` });
  }
  return {
    baseUrl: host,
    graphqlUrl: graphqlUrlFor(host),
    token,
    owner,
    repo,
  };
};

/** Resolve the GitHub config (pure env read; cheap enough to re-run per call). */
const gitHubConfig: Effect.Effect<GitHubConfig, ProviderConfigError> = Effect.try({
  try: computeConfig,
  catch: (error): ProviderConfigError =>
    error instanceof ProviderConfigError
      ? error
      : new ProviderConfigError({ detail: error instanceof Error ? error.message : String(error) }),
});

/** A single GitHub REST call: method, repo-relative path, and optional query/body. */
export type GitHubRequest = {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Repo-relative path. `:owner`/`:repo` are substituted with the resolved slug. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: Readonly<Record<string, unknown>>;
};

/** Build the full URL for a request, with `:owner`/`:repo` and the query string filled in. */
const buildUrl = (config: GitHubConfig, request: GitHubRequest): string => {
  const path = request.path.replace(":owner", config.owner).replace(":repo", config.repo);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  return `${config.baseUrl}/${path}${query}`;
};

/**
 * Decode a parsed body against `schema` and lift any `ParseError` into a
 * typed {@link ProviderResponseError}.
 *
 * `errors: "all"` so multi-field failures surface every issue at once.
 * The 800-char slice gives `TreeFormatter` room to keep the offending value
 * the previous 300-char limit was cutting away.
 */
const decodeBody = <A, I>(
  request: Pick<GitHubRequest, "method" | "path">,
  schema: Schema.Schema<A, I>,
  parsed: unknown,
): Effect.Effect<A, ProviderError> =>
  Schema.decodeUnknown(schema, { errors: "all" })(parsed).pipe(
    Effect.mapError(
      (error): ProviderError =>
        new ProviderResponseError({
          method: request.method,
          path: request.path,
          detail: ParseResult.TreeFormatter.formatErrorSync(error).slice(0, 800),
        }),
    ),
  );

/** Common headers for every GitHub API call. */
const headersFor = (config: GitHubConfig, hasBody: boolean): Record<string, string> => ({
  Authorization: `Bearer ${config.token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(hasBody ? { "Content-Type": "application/json" } : {}),
});

/** Make one HTTP call and validate the response body against `schema`. */
const callOnce = <A, I>(
  request: GitHubRequest,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> =>
  Effect.gen(function* () {
    const config = yield* gitHubConfig;
    const url = buildUrl(config, request);
    const hasBody = request.body !== undefined;
    const init: RequestInit = {
      method: request.method,
      headers: headersFor(config, hasBody),
      body: hasBody ? JSON.stringify(request.body) : undefined,
      // A hung GitHub server must not block the fiber indefinitely. 30s is
      // long enough for slow listings, short enough that a retry still fits
      // inside a phase budget.
      signal: AbortSignal.timeout(30_000),
    };

    const response = yield* Effect.tryPromise({
      try: () => fetch(url, init),
      catch: (error): ProviderError =>
        new ProviderNetworkError({
          method: request.method,
          path: request.path,
          cause: error instanceof Error ? error.message : String(error),
        }),
    });

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error): ProviderError =>
        new ProviderNetworkError({
          method: request.method,
          path: request.path,
          cause: `reading body failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    if (!response.ok) {
      return yield* Effect.fail(
        new ProviderHttpError({
          method: request.method,
          path: request.path,
          status: response.status,
          body: text.slice(0, 400),
        }),
      );
    }

    // A 204-style empty body — schemas that tolerate `undefined` (e.g. `void`) pass.
    const parsed = yield* Effect.try({
      try: (): unknown => (text.trim() === "" ? undefined : JSON.parse(text)),
      catch: (): ProviderError =>
        new ProviderResponseError({
          method: request.method,
          path: request.path,
          detail: `body was not JSON: ${text.slice(0, 200)}`,
        }),
    });

    return yield* decodeBody(request, schema, parsed);
  });

/**
 * Retry policy for transient failures: jittered exponential backoff, 3 attempts
 * total.
 */
const transientRetryPolicy = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(2)),
);

/**
 * Retry only *transient* failures — a network blip, a 5xx, or a 429. A 4xx,
 * a decode failure, or a boot-time misconfiguration is deterministic: retrying
 * only delays the same error, so let it surface at once.
 */
const retryTransient = (error: ProviderError): boolean =>
  error._tag === "ProviderNetworkError" ||
  (error._tag === "ProviderHttpError" && (error.status >= 500 || error.status === 429));

/** Wrap one call with the transient-retry policy. */
const withRetry = <A>(call: Effect.Effect<A, ProviderError>): Effect.Effect<A, ProviderError> =>
  call.pipe(Effect.retry({ schedule: transientRetryPolicy, while: retryTransient }));

/**
 * Run a READ request, retrying transient failures.
 * Never pass a mutation here — use {@link runGitHubWrite}.
 */
export const runGitHubRead = <A, I>(
  request: GitHubRequest & { readonly method: "GET" },
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> => withRetry(callOnce(request, schema));

/**
 * Run an idempotent WRITE (a PUT/DELETE that sets state to a fixed value),
 * retrying transient failures — repeating it is harmless.
 */
export const runGitHubIdempotentWrite = <A, I>(
  request: GitHubRequest & { readonly method: "PUT" | "DELETE" },
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> => withRetry(callOnce(request, schema));

/**
 * Run a WRITE exactly once — no retry. For POSTs (each call creates a new
 * resource) and non-idempotent state transitions, a retry after a lost response
 * would duplicate or wrongly replay the mutation.
 */
export const runGitHubWrite = <A, I>(
  request: GitHubRequest,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> => callOnce(request, schema);

/** Shape of a GraphQL response envelope: a `data` payload and/or an `errors` array. */
const GraphQLEnvelope = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});

/** Pseudo-request used to tag GraphQL errors with a stable method/path. */
const GRAPHQL_REF = { method: "POST", path: "graphql" } as const;

/**
 * Run a GraphQL operation exactly once — no retry (treat every operation as a
 * mutation). GraphQL returns HTTP 200 even on errors, so after parsing we check
 * for a top-level `errors` array and lift it into a {@link ProviderResponseError}
 * before decoding the `data` payload against `schema`.
 */
export const runGitHubGraphQL = <A, I>(
  query: string,
  variables: Readonly<Record<string, unknown>>,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> =>
  Effect.gen(function* () {
    const config = yield* gitHubConfig;
    const init: RequestInit = {
      method: "POST",
      headers: headersFor(config, true),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    };

    const response = yield* Effect.tryPromise({
      try: () => fetch(config.graphqlUrl, init),
      catch: (error): ProviderError =>
        new ProviderNetworkError({
          method: GRAPHQL_REF.method,
          path: GRAPHQL_REF.path,
          cause: error instanceof Error ? error.message : String(error),
        }),
    });

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error): ProviderError =>
        new ProviderNetworkError({
          method: GRAPHQL_REF.method,
          path: GRAPHQL_REF.path,
          cause: `reading body failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    if (!response.ok) {
      return yield* Effect.fail(
        new ProviderHttpError({
          method: GRAPHQL_REF.method,
          path: GRAPHQL_REF.path,
          status: response.status,
          body: text.slice(0, 400),
        }),
      );
    }

    const parsed = yield* Effect.try({
      try: (): unknown => (text.trim() === "" ? undefined : JSON.parse(text)),
      catch: (): ProviderError =>
        new ProviderResponseError({
          method: GRAPHQL_REF.method,
          path: GRAPHQL_REF.path,
          detail: `body was not JSON: ${text.slice(0, 200)}`,
        }),
    });

    const envelope = yield* decodeBody(GRAPHQL_REF, GraphQLEnvelope, parsed);
    if (envelope.errors !== undefined && envelope.errors.length > 0) {
      return yield* Effect.fail(
        new ProviderResponseError({
          method: GRAPHQL_REF.method,
          path: GRAPHQL_REF.path,
          detail: `GraphQL errors: ${JSON.stringify(envelope.errors).slice(0, 700)}`,
        }),
      );
    }

    return yield* decodeBody(GRAPHQL_REF, schema, envelope.data);
  });

/** Exposed for tests — never used in production code. */
export const __test = { decodeBody };
