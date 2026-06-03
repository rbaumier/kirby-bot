/**
 * Notify/web-links.ts — provider-aware web URLs for an issue / pull request.
 *
 * The end-of-attempt Discord ping links the issue and its PR/MR so a phone tap
 * lands on the forge page. The web URL is rebuilt from the same env config the
 * HTTP boundaries read (host + repo path), keyed by `$KIRBY_PROVIDER` — the one
 * switch that already decides the backend (mirrors {@link selectProvider}).
 *
 * Pure (env-only, no I/O) so the URL shape is unit-testable. Missing or blank
 * config yields `null`, never a broken href: the embed then falls back to plain
 * `#iid` text. This is best-effort cosmetics on a best-effort notification, so a
 * misconfig degrades silently rather than throwing.
 */

/** Trailing `/` to strip from a host before composing a path onto it. */
const TRAILING_SLASH = /\/$/;

/** GitHub Enterprise REST base ends with `/api/v3`; its UI origin drops that. */
const ENTERPRISE_REST_SUFFIX = "/api/v3";

/** Web (UI) origin for GitHub, derived from the API host the client talks to. */
const githubWebBase = (apiHost: string): string => {
  const host = apiHost.replace(TRAILING_SLASH, "");
  if (host === "https://api.github.com" || host === "http://api.github.com") {
    return "https://github.com";
  }
  // GitHub Enterprise: API lives at https://<host>/api/v3, the UI at https://<host>.
  return host.endsWith(ENTERPRISE_REST_SUFFIX)
    ? host.slice(0, -ENTERPRISE_REST_SUFFIX.length)
    : host;
};

/** The two web-link builders for the active provider. */
type Links = {
  readonly issue: (iid: number) => string;
  readonly pullRequest: (iid: number) => string;
};

/** Resolve the provider's web-link builders from env, or null when unconfigured. */
const resolveLinks = (): Links | null => {
  if (process.env.KIRBY_PROVIDER === "github") {
    const repo = process.env.GITHUB_REPO;
    if (repo === undefined || repo === "") {
      return null;
    }
    const base = `${githubWebBase(process.env.GITHUB_HOST || "https://api.github.com")}/${repo}`;
    return {
      issue: (iid) => `${base}/issues/${iid}`,
      pullRequest: (iid) => `${base}/pull/${iid}`,
    };
  }
  // gitlab (the default when unset/empty); any other value is rejected at startup.
  const host = process.env.GITLAB_HOST;
  const path = process.env.GITLAB_PROJECT_PATH;
  if (host === undefined || host === "" || path === undefined || path === "") {
    return null;
  }
  const base = `${host.replace(TRAILING_SLASH, "")}/${path}`;
  return {
    issue: (iid) => `${base}/-/issues/${iid}`,
    pullRequest: (iid) => `${base}/-/merge_requests/${iid}`,
  };
};

/** Web URL of an issue, or null when the provider config is incomplete. */
export const issueWebUrl = (iid: number): string | null => resolveLinks()?.issue(iid) ?? null;

/** Web URL of a pull/merge request, or null when the provider config is incomplete. */
export const pullRequestWebUrl = (iid: number): string | null =>
  resolveLinks()?.pullRequest(iid) ?? null;
