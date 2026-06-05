/**
 * Gitlab/http.ts — the typed, retrying boundary to the GitLab REST API.
 *
 * Two runners, deliberately kept separate.
 * `runGitLabRead` retries transient failures — safe only for reads since a
 * retry after a lost response is harmless.
 * `runGitLabWrite` retries idempotent mutations (PUT/DELETE) but never a POST:
 * a POST creates a new resource each time, so a retry after a lost response
 * would duplicate it. The rare non-idempotent PUT (`merge`, which errors if
 * replayed on an already-merged MR) opts out via `nonIdempotent`.
 *
 * Configuration is read from environment variables only — no `glab` config
 * file, no git-remote sniffing:
 *   - `$KIRBY_GITLAB_TOKEN`   — a personal access token (PAT) with `api` scope.
 *   - `$GITLAB_HOST`          — the instance base URL, e.g. `https://gitlab.com`.
 *   - `$GITLAB_PROJECT_PATH`  — the `owner/repo` project path.
 * A missing one fails fast with a {@link ProviderConfigError} at startup.
 */
import { Effect, ParseResult, Schema } from "effect";
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseError,
} from "../provider/types";
import type { ProviderError } from "../provider/types";
import { transientSchedule } from "../retry";

/** The resolved GitLab connection: base URL, auth token, and URL-encoded project ref. */
type GitLabConfig = {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectRef: string;
};

/** Trailing `/` to strip from `$GITLAB_HOST` before composing the API base URL. */
const TRAILING_SLASH = /\/$/;

/** Read a required env var, failing with a clear {@link ProviderConfigError} if unset. */
const requireEnv = (name: string, hint: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new ProviderConfigError({ detail: `${name} is not set — ${hint}` });
  }
  return value;
};

/** Resolve the GitLab config from environment variables. PAT-only by design. */
const computeConfig = (): GitLabConfig => {
  const host = requireEnv("GITLAB_HOST", "the instance base URL, e.g. https://gitlab.com").replace(
    TRAILING_SLASH,
    "",
  );
  const projectPath = requireEnv("GITLAB_PROJECT_PATH", "the owner/repo project path");
  const token = requireEnv(
    "KIRBY_GITLAB_TOKEN",
    "a personal access token with the `api` scope (OAuth2 tokens are not supported)",
  );
  return {
    baseUrl: `${host}/api/v4`,
    token,
    projectRef: encodeURIComponent(projectPath),
  };
};

/** Resolve the GitLab config (pure env read; cheap enough to re-run per call). */
const gitLabConfig: Effect.Effect<GitLabConfig, ProviderConfigError> = Effect.try({
  try: computeConfig,
  catch: (error): ProviderConfigError =>
    error instanceof ProviderConfigError
      ? error
      : new ProviderConfigError({ detail: error instanceof Error ? error.message : String(error) }),
});

/** A single GitLab REST call: method, project-relative path, and optional query/body. */
export type GitLabRequest = {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** Project-relative path. `:id` is substituted with the URL-encoded project ref. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: Readonly<Record<string, unknown>>;
};

/** Build the full URL for a request, with `:id` and the query string filled in. */
const buildUrl = (config: GitLabConfig, request: GitLabRequest): string => {
  const path = request.path.replace(":id", config.projectRef);
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
  request: GitLabRequest,
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

/** Make one HTTP call and validate the response body against `schema`. */
const callOnce = <A, I>(
  request: GitLabRequest,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> =>
  Effect.gen(function* () {
    const config = yield* gitLabConfig;
    const url = buildUrl(config, request);
    const hasBody = request.body !== undefined;
    const init: RequestInit = {
      method: request.method,
      headers: {
        "PRIVATE-TOKEN": config.token,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(request.body) : undefined,
      // A hung GitLab server must not block the fiber indefinitely. 30s is
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

/** Retry policy for transient failures: jittered exponential backoff, 3 attempts total. */
const transientRetryPolicy = transientSchedule("200 millis");

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
 * Never pass a mutation here — use {@link runGitLabWrite}.
 */
export const runGitLabRead = <A, I>(
  request: GitLabRequest & { readonly method: "GET" },
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> => withRetry(callOnce(request, schema));

/**
 * Run an idempotent WRITE (a PUT/DELETE that sets state to a fixed value),
 * retrying transient failures — repeating it is harmless.
 */
export const runGitLabIdempotentWrite = <A, I>(
  request: GitLabRequest,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> => withRetry(callOnce(request, schema));

/**
 * Run a WRITE exactly once — no retry. For POSTs (each call creates a new
 * resource) and state transitions like `merge` (which errors if replayed),
 * a retry after a lost response would duplicate or wrongly replay the mutation.
 */
export const runGitLabWrite = <A, I>(
  request: GitLabRequest,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> => callOnce(request, schema);

/** Exposed for tests — never used in production code. */
export const __test = { decodeBody };
