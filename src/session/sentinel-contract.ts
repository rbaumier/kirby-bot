/**
 * Session/sentinel-contract.ts — the single source of truth for the physical
 * contract that carries a phase's **Verdict** out of a `claude` session.
 *
 * The Verdict travels through three wires that MUST agree, or the capture
 * fails silently (the Session expires in `NoVerdict`, counted as a **Stall**,
 * as if the Issue were at fault — no compile error, no signal):
 *
 *  1. the env-var **name** the sentinel path is passed through
 *     ({@link AGENT_SENTINEL_VAR});
 *  2. the **path** to the Stop-hook handler script ({@link STOP_HOOK_SCRIPT});
 *  3. the **hook events** we register the handler for ({@link STOP_HOOK_EVENTS}).
 *
 * Both ends consume this module instead of redeclaring the literals:
 * `phase-primitives.ts` *writes* the hook command (via {@link stopHookSettings})
 * and *exports* the env var; the round-trip test executes that very command and
 * asserts the handler writes the sentinel the env var pointed at. Changing a
 * name or path here propagates to every consumer — a typo can no longer drift
 * one wire out of sync with the others.
 */
import { join } from "node:path";

/**
 * Env-var name the Stop hook's sentinel path is passed through. The hook
 * command references it as `"$AGENT_SENTINEL"` and each session exports its own
 * value before launching `claude`, so one shared `settings.local.json` is
 * correct for N parallel sessions in the same worktree (per-agent fan-out).
 */
export const AGENT_SENTINEL_VAR = "AGENT_SENTINEL";

/** Absolute path to the Stop-hook handler script — sibling of this module. */
export const STOP_HOOK_SCRIPT = join(import.meta.dirname, "stop-hook.ts");

/**
 * The Claude Code hook events we own and register the handler for. We replace
 * these outright on merge (we must be the hook that runs) — see
 * {@link stopHookSettings} consumers.
 */
export const STOP_HOOK_EVENTS = ["Stop", "StopFailure"] as const;

/** One Claude Code hook registration entry. */
type HookEntry = {
  readonly matcher: string;
  readonly hooks: readonly { readonly type: "command"; readonly command: string }[];
};

/**
 * The shell command Claude Code runs on each Stop/StopFailure. Reads the
 * sentinel path from `$AGENT_SENTINEL` rather than a hard-coded argument so the
 * shared settings file scales to fan-out. Both paths are double-quoted — the
 * command runs through a shell and worktree/sentinel paths may contain spaces.
 */
export const stopHookCommand = (): string =>
  `bun "${STOP_HOOK_SCRIPT}" "$${AGENT_SENTINEL_VAR}"`;

/**
 * The `hooks` fragment to merge into a worktree's `settings.local.json`: our
 * handler registered for every event in {@link STOP_HOOK_EVENTS}, all pointing
 * at the same {@link stopHookCommand}.
 */
export const stopHookSettings = (): Record<string, readonly HookEntry[]> => {
  const entry: readonly HookEntry[] = [
    { matcher: "", hooks: [{ type: "command", command: stopHookCommand() }] },
  ];
  return Object.fromEntries(STOP_HOOK_EVENTS.map((event) => [event, entry]));
};
