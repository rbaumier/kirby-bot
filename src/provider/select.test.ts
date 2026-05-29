import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GitHubProviderLive } from "./github";
import { GitLabProviderLive } from "./gitlab";
import { selectProvider } from "./select";

describe("selectProvider", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.KIRBY_PROVIDER;
    delete process.env.KIRBY_PROVIDER;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.KIRBY_PROVIDER;
    else process.env.KIRBY_PROVIDER = saved;
  });

  it("returns the GitHub Layer for KIRBY_PROVIDER=github", () => {
    process.env.KIRBY_PROVIDER = "github";
    expect(selectProvider()).toBe(GitHubProviderLive);
  });

  it("returns the GitLab Layer for KIRBY_PROVIDER=gitlab", () => {
    process.env.KIRBY_PROVIDER = "gitlab";
    expect(selectProvider()).toBe(GitLabProviderLive);
  });

  it("defaults to the GitLab Layer when KIRBY_PROVIDER is unset", () => {
    expect(selectProvider()).toBe(GitLabProviderLive);
  });

  // ProviderConfigError carries its text in `detail` (not `.message`), so catch
  // the throw and read the tagged field rather than matching an Error message.
  const detailOfThrow = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      const tagged = error as { _tag?: string; detail?: string };
      return tagged._tag === "ProviderConfigError" ? (tagged.detail ?? "") : String(error);
    }
    throw new Error("expected selectProvider to throw");
  };

  it("fails with a ProviderConfigError for an unknown value", () => {
    process.env.KIRBY_PROVIDER = "bitbucket";
    expect(detailOfThrow(selectProvider)).toMatch(/KIRBY_PROVIDER must be/);
  });
});
