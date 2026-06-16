/**
 * Session/driver.ts — which backend drives each `claude` phase session.
 *
 * Reads `$KIRBY_DRIVER` and returns the backend the orchestrator runs phases
 * through. Mirrors `provider/select.ts`: a plain synchronous read (no Effect),
 * and an unknown value throws a {@link ProviderConfigError} to fail fast at
 * startup, exactly like a missing env var.
 *
 *   - `"headless"` or unset → `claude -p` headless subprocess (the default). One
 *     subprocess per phase; the verdict is parsed from its `stream-json` stdout.
 *     No tmux, so the paste / submit / ready-marker machinery — and its #30/#43
 *     race bugs — does not apply.
 *   - `"tmux"`              → the interactive tmux-session driver (legacy). Kept
 *     as a fallback while `claude -p` subscription billing settles: Anthropic has
 *     only postponed, not committed to, subscription-billed headless runs.
 *   - anything else         → throws {@link ProviderConfigError} (fail fast).
 */
import { ProviderConfigError } from "../provider/types";

/** The session backend a phase runs through. */
export type Driver = "headless" | "tmux";

/** Resolve the session driver from `$KIRBY_DRIVER` (default `headless`). */
export const selectDriver = (): Driver => {
  const driver = process.env.KIRBY_DRIVER;
  switch (driver) {
    case "tmux": {
      return "tmux";
    }
    case undefined:
    case "":
    case "headless": {
      return "headless";
    }
    default: {
      throw new ProviderConfigError({
        detail: `KIRBY_DRIVER must be "headless" or "tmux" (or unset), got ${JSON.stringify(driver)}`,
      });
    }
  }
};
