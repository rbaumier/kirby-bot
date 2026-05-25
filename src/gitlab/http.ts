/**
 * Gitlab/http.ts — the typed, retrying boundary to the GitLab REST API.
 *
 * Two runners, deliberately kept separate.
 * `runGitLabRead` retries transient failures — safe only for reads since a
 * retry after a lost response is harmless.
 * `runGitLabWrite` never retries; it is used for mutations (`mr create`,
 * `issue note`, discussion post/reply). If the request succeeded but its
 * response was lost, a retry would duplicate the mutation.
 *
 * Configuration comes from three sources, in this priority order:
 *   1. `$GITLAB_TOKEN`, `$GITLAB_HOST`, `$GITLAB_PROJECT_PATH` env vars.
 *   2. The `~/.config/glab-cli/config.yml` `token:` field for the host
 *      (a documented fallback layer for the legacy `glab`-based wiring).
 *   3. The git remote URL of `origin` (host + project path).
 */
import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Effect, ParseResult, Schedule, Schema } from "effect";
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseError,
} from "../provider/types";
import type { ProviderError } from "../provider/types";

/** The resolved GitLab connection: base URL, auth token, and URL-encoded project ref. */
type GitLabConfig = {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectRef: string;
};

/** Parsed git remote — the host and the owner/repo path. */
type Remote = { readonly host: string; readonly path: string };

/** Strip a trailing `.git` from a remote URL. */
const DOT_GIT_SUFFIX = /\.git$/;

/** SSH form: `git@<host>:<owner>/<repo>` — captures host and path. */
const SSH_REMOTE = /^git@([^:]+):(.+)$/;

/**
 * HTTPS form: `https?://[user[:pass]@]<host>/<path>` — captures host and
 * path. The optional credentials group is non-capturing.
 */
const HTTPS_REMOTE = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/;

/** YAML host header: `  hostname:` — captures the indent and the host name. */
const YAML_HOST_HEADER = /^(\s*)([\w.-]+):\s*$/;

/** YAML token line under a host block: `    token: <value>` — captures value. */
const YAML_TOKEN_LINE = /^\s+token:\s+(.+)$/;

/** Leading `"` or `'` to strip from a YAML scalar value. */
const LEADING_QUOTE = /^["']/;

/** Trailing `"` or `'` to strip from a YAML scalar value. */
const TRAILING_QUOTE = /["']$/;

/** Trailing `/` to strip from a host URL. */
const TRAILING_SLASH = /\/$/;

/** Strip `http://` or `https://` from a URL to recover the bare hostname. */
const URL_SCHEME = /^https?:\/\//;

/** Parse the `git remote get-url origin` output. Accepts ssh and https forms. */
const parseRemoteUrl = (url: string): Remote | null => {
  const trimmed = url.trim().replace(DOT_GIT_SUFFIX, "");
  const ssh = SSH_REMOTE.exec(trimmed);
  if (ssh !== null) {
    return { host: ssh[1] ?? "", path: ssh[2] ?? "" };
  }
  const https = HTTPS_REMOTE.exec(trimmed);
  if (https !== null) {
    return { host: https[1] ?? "", path: https[2] ?? "" };
  }
  return null;
};

/** YAML host header parse result. */
type HostHeader = { readonly indent: number; readonly host: string };

const matchHostHeader = (line: string): HostHeader | null => {
  const parts = YAML_HOST_HEADER.exec(line);
  if (parts === null) {
    return null;
  }
  return { indent: parts[1]?.length ?? 0, host: parts[2] ?? "" };
};

const matchTokenLine = (line: string): string | null => {
  const parts = YAML_TOKEN_LINE.exec(line);
  if (parts === null) {
    return null;
  }
  return (parts[1] ?? "").trim().replace(LEADING_QUOTE, "").replace(TRAILING_QUOTE, "");
};

/**
 * Scan a glab-cli YAML config for the token of a given host.
 *
 * The file's shape is small and stable enough to read line-by-line — we avoid
 * a yaml dependency for a 5-line lookup. Two indentation levels are supported:
 * `hosts.<host>.token` (current glab) and `<host>.token` (older layouts).
 */
/** Scanner output — next block indent (or `null` outside any block), and any token found. */
type ScanResult = { readonly blockIndent: number | null; readonly token: string | null };

/** Reduce a header line: enter the matching block, or leave when outdented. */
const advanceOnHeader = (
  blockIndent: number | null,
  header: HostHeader,
  host: string,
): number | null => {
  if (header.host === host) {
    return header.indent;
  }
  if (blockIndent !== null && header.indent <= blockIndent) {
    return null;
  }
  return blockIndent;
};

/** Reduce a single YAML line, returning the next scanner state. */
const scanLine = (blockIndent: number | null, line: string, host: string): ScanResult => {
  const header = matchHostHeader(line);
  if (header !== null) {
    return { blockIndent: advanceOnHeader(blockIndent, header, host), token: null };
  }
  if (blockIndent === null) {
    return { blockIndent, token: null };
  }
  return { blockIndent, token: matchTokenLine(line) };
};

const parseTokenFromYaml = (yaml: string, host: string): string | null => {
  let blockIndent: number | null = null;
  for (const line of yaml.split("\n")) {
    const result = scanLine(blockIndent, line, host);
    if (result.token !== null) {
      return result.token;
    }
    blockIndent = result.blockIndent;
  }
  return null;
};

/** Look up the auth token in `~/.config/glab-cli/config.yml` for `host`. */
const readTokenFromGlabConfig = (host: string): string | null => {
  const path = `${homedir()}/.config/glab-cli/config.yml`;
  if (!existsSync(path)) {
    return null;
  }
  return parseTokenFromYaml(readFileSync(path, "utf8"), host);
};

/** Detect `origin`'s remote URL and parse it. */
const detectRemote = async (): Promise<Remote> => {
  const output = await $`git remote get-url origin`.quiet().text();
  const parsed = parseRemoteUrl(output);
  if (parsed === null) {
    throw new ProviderConfigError({
      detail: `unparseable origin URL: ${output.trim().slice(0, 120)}`,
    });
  }
  return parsed;
};

/** Compute the full GitLab config from env + glab config + git remote. */
const computeConfig = async (): Promise<GitLabConfig> => {
  const envHost = process.env.GITLAB_HOST?.replace(TRAILING_SLASH, "");
  const envProject = process.env.GITLAB_PROJECT_PATH;
  const envToken = process.env.GITLAB_TOKEN;

  // Only call out to git when env vars don't already supply both pieces.
  const remote = envHost !== undefined && envProject !== undefined ? null : await detectRemote();
  const hostUrl = envHost ?? `https://${remote?.host ?? ""}`;
  const projectPath = envProject ?? remote?.path ?? "";
  if (projectPath === "") {
    throw new ProviderConfigError({ detail: "no project path resolved from env or git remote" });
  }
  const hostName = hostUrl.replace(URL_SCHEME, "");
  const token = envToken ?? readTokenFromGlabConfig(hostName);
  if (token === null || token === "") {
    throw new ProviderConfigError({
      detail: `no token in $GITLAB_TOKEN or ~/.config/glab-cli/config.yml for host ${hostName}`,
    });
  }
  return {
    baseUrl: `${hostUrl}/api/v4`,
    token,
    projectRef: encodeURIComponent(projectPath),
  };
};

/**
 * Process-wide cache of the resolved config. Resolved once on first call.
 * `null` means uncached; a transient failure clears the cache so the next
 * call retries the resolution.
 */
let configPromise: Promise<GitLabConfig> | null = null;

/** Lazily resolve, then cache, the GitLab config. Re-tries on failure. */
const gitLabConfig: Effect.Effect<GitLabConfig, ProviderConfigError> = Effect.tryPromise({
  try: async () => {
    if (configPromise !== null) {
      return configPromise;
    }
    const pending = computeConfig();
    configPromise = pending;
    try {
      return await pending;
    } catch (error: unknown) {
      // A transient failure must not poison the cache — drop it so the
      // next caller re-tries resolution.
      if (configPromise === pending) {
        configPromise = null;
      }
      throw error;
    }
  },
  catch: (error): ProviderConfigError =>
    error instanceof ProviderConfigError
      ? error
      : new ProviderConfigError({
          detail: error instanceof Error ? error.message : String(error),
        }),
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
  const entries = Object.entries(request.query ?? {}).filter(([, value]) => value !== undefined);
  const query =
    entries.length === 0
      ? ""
      : "?" +
        entries
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
          .join("&");
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
const decodeBodyOrFail = <A, I>(
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

    return yield* decodeBodyOrFail(request, schema, parsed);
  });

/**
 * Retry policy for reads: jittered exponential backoff, 3 attempts total.
 * Transient HTTP / network failures retry. A deterministic boot-time
 * misconfiguration ({@link ProviderConfigError}) does not — retrying
 * only delays a clear error message by ~1 second.
 */
const readRetryPolicy = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(2)),
);

/**
 * Run a READ request, retrying transient failures.
 * Never pass a mutation here — use {@link runGitLabWrite}.
 */
export const runGitLabRead = <A, I>(
  request: GitLabRequest & { readonly method: "GET" },
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> =>
  callOnce(request, schema).pipe(
    Effect.retry({
      schedule: readRetryPolicy,
      while: (error: ProviderError) => error._tag !== "ProviderConfigError",
    }),
  );

/**
 * Run a WRITE request exactly once — no retry.
 * A retry after a lost response would duplicate the mutation; the caller
 * handles a genuine failure instead.
 */
export const runGitLabWrite = <A, I>(
  request: GitLabRequest,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, ProviderError> => callOnce(request, schema);

/** Exposed for tests — never used in production code. */
export const __test = { parseRemoteUrl, parseTokenFromYaml, decodeBodyOrFail };
