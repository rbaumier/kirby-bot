/**
 * Provider/select.ts — single source of truth for which backend Layer to run.
 *
 * Reads `$KIRBY_PROVIDER` and returns the matching {@link GitProvider} Layer.
 * Both `main.ts` and the `mr-discussion` CLI call this so the switch is never
 * duplicated. A plain synchronous read (no Effect) matches the `computeConfig`
 * style in the `http.ts` boundaries; an unknown value throws a {@link ProviderConfigError}
 * to fail fast at startup, exactly like a missing env var.
 */
import type { Layer } from "effect";
import { GitHubProviderLive } from "./github";
import { GitLabProviderLive } from "./gitlab";
import type { GitProvider } from "./provider";
import { ProviderConfigError } from "./types";

/**
 * Resolve the backend Layer from `$KIRBY_PROVIDER`:
 *   - `"github"`          → {@link GitHubProviderLive}
 *   - `"gitlab"` or unset → {@link GitLabProviderLive} (default keeps current behavior)
 *   - anything else       → throws {@link ProviderConfigError} (fail fast)
 */
export const selectProvider = (): Layer.Layer<GitProvider> => {
  const provider = process.env.KIRBY_PROVIDER;
  switch (provider) {
    case "github": {
      return GitHubProviderLive;
    }
    case undefined:
    case "":
    case "gitlab": {
      return GitLabProviderLive;
    }
    default: {
      throw new ProviderConfigError({
        detail: `KIRBY_PROVIDER must be "github" or "gitlab" (or unset), got ${JSON.stringify(provider)}`,
      });
    }
  }
};
