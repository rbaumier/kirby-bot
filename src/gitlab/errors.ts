/**
 * Gitlab/errors.ts — the failure modes of the GitLab boundary.
 *
 * Error policy (consistent across every slice):
 *  - One tagged error per *distinct* failure mode — never a single catch-all.
 *    Distinct modes are caught and described differently, so they are typed
 *    differently.
 *  - Errors are grouped by the boundary they arise from; each slice owns its
 *    own `errors.ts`.
 *  - Anticipated, routable failures live in the Effect error channel. A
 *    genuine bug in our own code stays a defect — it is not modelled here.
 *  - A slice exports a union alias of its errors so callers can name the
 *    whole error surface in one place.
 */
import { Data } from "effect";

/** The REST call reached GitLab but the response status was non-2xx. */
export class GitLabHttpError extends Data.TaggedError("GitLabHttpError")<{
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: string;
}> {}

/** The REST call did not reach GitLab — DNS, TLS, refused connection, abort. */
export class GitLabNetworkError extends Data.TaggedError("GitLabNetworkError")<{
  readonly method: string;
  readonly path: string;
  readonly cause: string;
}> {}

/** A 2xx response came back, but its body was not the JSON shape we expected. */
export class GitLabResponseError extends Data.TaggedError("GitLabResponseError")<{
  readonly method: string;
  readonly path: string;
  readonly detail: string;
}> {}

/** Boot-time wiring failure: no token, no remote, or an unparseable remote. */
export class GitLabConfigError extends Data.TaggedError("GitLabConfigError")<{
  readonly detail: string;
}> {}

/** Every failure the GitLab boundary can produce. */
export type GitLabError =
  | GitLabHttpError
  | GitLabNetworkError
  | GitLabResponseError
  | GitLabConfigError;

/** A one-line, human-readable description of a GitLab error. */
export function describeGitLabError(error: GitLabError): string {
  switch (error._tag) {
    case "GitLabHttpError":
      return `${error.method} ${error.path} → HTTP ${error.status}: ${error.body.slice(0, 200)}`;
    case "GitLabNetworkError":
      return `${error.method} ${error.path} — network error: ${error.cause.slice(0, 200)}`;
    case "GitLabResponseError":
      return `${error.method} ${error.path} — unexpected response: ${error.detail.slice(0, 200)}`;
    case "GitLabConfigError":
      return `GitLab config error: ${error.detail.slice(0, 200)}`;
  }
}
