import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { issueWebUrl, pullRequestWebUrl } from "./web-links";

const ENV_KEYS = [
  "KIRBY_PROVIDER",
  "GITHUB_REPO",
  "GITHUB_HOST",
  "GITLAB_HOST",
  "GITLAB_PROJECT_PATH",
] as const;

describe("web-links", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("github", () => {
    beforeEach(() => {
      process.env.KIRBY_PROVIDER = "github";
      process.env.GITHUB_REPO = "rbaumier/kirby-bot";
    });

    it("builds issue and pull URLs on github.com by default", () => {
      expect(issueWebUrl(907)).toBe("https://github.com/rbaumier/kirby-bot/issues/907");
      expect(pullRequestWebUrl(917)).toBe("https://github.com/rbaumier/kirby-bot/pull/917");
    });

    it("derives the UI origin from a GitHub Enterprise API host", () => {
      process.env.GITHUB_HOST = "https://gh.corp.example/api/v3";
      expect(issueWebUrl(5)).toBe("https://gh.corp.example/rbaumier/kirby-bot/issues/5");
      expect(pullRequestWebUrl(6)).toBe("https://gh.corp.example/rbaumier/kirby-bot/pull/6");
    });

    it("returns null when the repo slug is unset", () => {
      delete process.env.GITHUB_REPO;
      expect(issueWebUrl(1)).toBeNull();
      expect(pullRequestWebUrl(1)).toBeNull();
    });
  });

  describe("gitlab", () => {
    it("builds issue and merge-request URLs (default provider when unset)", () => {
      process.env.GITLAB_HOST = "https://gitlab.com";
      process.env.GITLAB_PROJECT_PATH = "group/proj";
      expect(issueWebUrl(42)).toBe("https://gitlab.com/group/proj/-/issues/42");
      expect(pullRequestWebUrl(7)).toBe("https://gitlab.com/group/proj/-/merge_requests/7");
    });

    it("strips a trailing slash on the host", () => {
      process.env.KIRBY_PROVIDER = "gitlab";
      process.env.GITLAB_HOST = "https://gitlab.com/";
      process.env.GITLAB_PROJECT_PATH = "group/proj";
      expect(issueWebUrl(42)).toBe("https://gitlab.com/group/proj/-/issues/42");
    });

    it("returns null when host or project path is unset", () => {
      process.env.GITLAB_HOST = "https://gitlab.com";
      expect(issueWebUrl(1)).toBeNull();
    });
  });
});
