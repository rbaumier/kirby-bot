/**
 * Gitlab/http.ts — the typed, retrying boundary to the GitLab REST API.
 *
 * Two runners, deliberately kept separate:
 *
 *   - `runGitLabRead`  retries transient failures.
 *     Safe only for reads — a retry after a lost response is harmless.
 *   - `runGitLabWrite` never retries.
 *     Used for mutations (`mr create`, `issue note`, discussion post/reply).
 *     If the request succeeded but its response was lost,
 *     a retry would duplicate the mutation.
 *
 * Configuration comes from three sources, in this priority order:
 *   1. `$GITLAB_TOKEN`, `$GITLAB_HOST`, `$GITLAB_PROJECT_PATH` env vars.
 *   2. The `~/.config/glab-cli/config.yml` `token:` field for the host (back-
 *      compat with the previous `glab`-based wiring).
 *   3. The git remote URL of `origin` (host + project path).
 */
import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Effect, Schedule } from "effect";
import type { z } from "zod";
import {
  GitLabConfigError,
  type GitLabError,
  GitLabHttpError,
  GitLabNetworkError,
  GitLabResponseError,
} from "./errors";

/** The resolved GitLab connection: base URL, auth token, and URL-encoded project ref. */
type GitLabConfig = {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectRef: string;
};

/** Parsed git remote — the host and the owner/repo path. */
type Remote = { readonly host: string; readonly path: string };

/** Parse the `git remote get-url origin` output. Accepts ssh and https forms. */
const parseRemoteUrl = (url: string): Remote | null => {
  const trimmed = url.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
  if (ssh !== null) return { host: ssh[1] ?? "", path: ssh[2] ?? "" };
  const https = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (https !== null) return { host: https[1] ?? "", path: https[2] ?? "" };
  return null;
};

/**
 * Scan a glab-cli YAML config for the token of a given host.
 *
 * The file's shape is small and stable enough to read line-by-line — we avoid
 * a yaml dependency for a 5-line lookup. Two indentation levels are supported:
 * `hosts.<host>.token` (current glab) and `<host>.token` (older layouts).
 */
const parseTokenFromYaml = (yaml: string, host: string): string | null => {
  const lines = yaml.split("\n");
  let inHostBlock = false;
  let blockIndent = -1;
  for (const raw of lines) {
    const hostMatch = raw.match(/^(\s*)([\w.-]+):\s*$/);
    if (hostMatch !== null) {
      const indent = hostMatch[1]?.length ?? 0;
      if (hostMatch[2] === host) {
        inHostBlock = true;
        blockIndent = indent;
        continue;
      }
      if (inHostBlock && indent <= blockIndent) {
        inHostBlock = false;
      }
    }
    if (inHostBlock) {
      const tokenMatch = raw.match(/^\s+token:\s+(.+?)\s*$/);
      if (tokenMatch !== null) {
        return (tokenMatch[1] ?? "").replace(/^["']|["']$/g, "");
      }
    }
  }
  return null;
};

/** Look up the auth token in `~/.config/glab-cli/config.yml` for `host`. */
const readTokenFromGlabConfig = (host: string): string | null => {
  const path = `${homedir()}/.config/glab-cli/config.yml`;
  if (!existsSync(path)) return null;
  return parseTokenFromYaml(readFileSync(path, "utf8"), host);
};

/** Detect `origin`'s remote URL and parse it. */
const detectRemote = (): Promise<Remote> =>
  $`git remote get-url origin`
    .quiet()
    .text()
    .then((output) => {
      const parsed = parseRemoteUrl(output);
      if (parsed === null) {
        throw new GitLabConfigError({
          detail: `unparseable origin URL: ${output.trim().slice(0, 120)}`,
        });
      }
      return parsed;
    });

/** Compute the full GitLab config from env + glab config + git remote. */
const computeConfig = async (): Promise<GitLabConfig> => {
  const envHost = process.env.GITLAB_HOST?.replace(/\/$/, "");
  const envProject = process.env.GITLAB_PROJECT_PATH;
  const envToken = process.env.GITLAB_TOKEN;

  // Only call out to git when env vars don't already supply both pieces.
  const remote = envHost !== undefined && envProject !== undefined ? null : await detectRemote();
  const hostUrl = envHost ?? `https://${remote?.host ?? ""}`;
  const projectPath = envProject ?? remote?.path ?? "";
  if (projectPath === "") {
    throw new GitLabConfigError({ detail: "no project path resolved from env or git remote" });
  }
  const hostName = hostUrl.replace(/^https?:\/\//, "");
  const token = envToken ?? readTokenFromGlabConfig(hostName);
  if (!token) {
    throw new GitLabConfigError({
      detail: `no token in $GITLAB_TOKEN or ~/.config/glab-cli/config.yml for host ${hostName}`,
    });
  }
  return {
    baseUrl: `${hostUrl}/api/v4`,
    token,
    projectRef: encodeURIComponent(projectPath),
  };
};

/** Process-wide cache of the resolved config. Resolved once on first call. */
let configPromise: Promise<GitLabConfig> | undefined;

/** Lazily resolve, then cache, the GitLab config. Re-tries on failure. */
const gitLabConfig: Effect.Effect<GitLabConfig, GitLabConfigError> = Effect.tryPromise({
  try: () => {
    if (configPromise === undefined) {
      configPromise = computeConfig().catch((error: unknown) => {
        configPromise = undefined; // a transient failure must not poison the cache
        throw error;
      });
    }
    return configPromise;
  },
  catch: (error): GitLabConfigError =>
    error instanceof GitLabConfigError
      ? error
      : new GitLabConfigError({
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

/** Make one HTTP call and validate the response body against `schema`. */
const callOnce = <A>(
  request: GitLabRequest,
  schema: z.ZodType<A>,
): Effect.Effect<A, GitLabError> =>
  Effect.gen(function* () {
    const config = yield* gitLabConfig;
    const url = buildUrl(config, request);
    const init: RequestInit = {
      method: request.method,
      headers: {
        "PRIVATE-TOKEN": config.token,
        Accept: "application/json",
        ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
    };

    const response = yield* Effect.tryPromise({
      try: () => fetch(url, init),
      catch: (error): GitLabError =>
        new GitLabNetworkError({
          method: request.method,
          path: request.path,
          cause: error instanceof Error ? error.message : String(error),
        }),
    });

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error): GitLabError =>
        new GitLabNetworkError({
          method: request.method,
          path: request.path,
          cause: `reading body failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    if (!response.ok) {
      return yield* Effect.fail(
        new GitLabHttpError({
          method: request.method,
          path: request.path,
          status: response.status,
          body: text.slice(0, 400),
        }),
      );
    }

    // A 204-style empty body — schemas that tolerate `undefined` (e.g. `void`) pass.
    const parsed =
      text.trim() === ""
        ? undefined
        : (() => {
            try {
              return JSON.parse(text) as unknown;
            } catch {
              return Symbol.for("invalid-json");
            }
          })();

    if (parsed === Symbol.for("invalid-json")) {
      return yield* Effect.fail(
        new GitLabResponseError({
          method: request.method,
          path: request.path,
          detail: `body was not JSON: ${text.slice(0, 200)}`,
        }),
      );
    }

    const validation = schema.safeParse(parsed);
    if (!validation.success) {
      return yield* Effect.fail(
        new GitLabResponseError({
          method: request.method,
          path: request.path,
          detail: validation.error.message.slice(0, 300),
        }),
      );
    }
    return validation.data;
  });

/**
 * Retry policy for reads: jittered exponential backoff, 3 attempts total.
 * Every failure is retried — telling a transient API error from a permanent
 * one is unreliable, and retrying a genuine 4xx merely wastes ~1 second.
 */
const readRetryPolicy = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(2)),
);

/**
 * Run a READ request, retrying transient failures.
 * Never pass a mutation here — use {@link runGitLabWrite}.
 */
export const runGitLabRead = <A>(
  request: GitLabRequest & { readonly method: "GET" },
  schema: z.ZodType<A>,
): Effect.Effect<A, GitLabError> => callOnce(request, schema).pipe(Effect.retry(readRetryPolicy));

/**
 * Run a WRITE request exactly once — no retry.
 * A retry after a lost response would duplicate the mutation; the caller
 * handles a genuine failure instead.
 */
export const runGitLabWrite = <A>(
  request: GitLabRequest,
  schema: z.ZodType<A>,
): Effect.Effect<A, GitLabError> => callOnce(request, schema);

/** Exposed for tests — never used in production code. */
export const __test = { parseRemoteUrl, parseTokenFromYaml };
