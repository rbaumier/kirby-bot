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
 * Two more per-session markers ride the same env-var/command/event contract,
 * each written by a hook that reads its own path from a dedicated env var: the
 * `SessionStart` ready-marker ({@link AGENT_READY_VAR}) and the
 * `UserPromptSubmit` submitted-marker ({@link AGENT_SUBMITTED_VAR}). They carry
 * no Verdict, but they live here for the same reason — one place owns the
 * literals so no consumer can drift a name out of sync.
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

/**
 * Env-var name the SessionStart hook's ready-marker path is passed through.
 * Mirrors {@link AGENT_SENTINEL_VAR}: the hook command references it as
 * `"$AGENT_READY"` and each session exports its own value before launching
 * `claude`, so one shared `settings.local.json` is correct for N parallel
 * sessions in the same worktree (per-agent fan-out).
 */
export const AGENT_READY_VAR = "AGENT_READY";

/**
 * Env-var name the UserPromptSubmit hook's submitted-marker path is passed
 * through. Mirrors {@link AGENT_READY_VAR}: the hook command references it as
 * `"$AGENT_SUBMITTED"` and each session exports its own value before launching
 * `claude`, so one shared `settings.local.json` is correct for N parallel
 * sessions in the same worktree (per-agent fan-out). The marker's *absence*
 * after boot is the deterministic signal that the prompt's submitting Enter was
 * dropped under tmux-server backlog (issue #30): the TUI never fired
 * `UserPromptSubmit`, so `deliverPrompt` re-drives the paste and, if it still
 * never lands, fails fast instead of idling the whole phase budget.
 */
export const AGENT_SUBMITTED_VAR = "AGENT_SUBMITTED";

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

/**
 * The shell command Claude Code runs on `SessionStart` — once the interactive
 * TUI is up and ready for keystrokes. Reads the per-session ready-marker path
 * from `$AGENT_READY` and writes `ready` into it. No payload parsing is needed
 * (unlike the Stop hook), so an inline shell command run through Claude Code's
 * shell is enough — no separate `.ts` script. The path is double-quoted — the
 * command runs through a shell and the marker path may contain spaces.
 */
export const sessionStartHookCommand = (): string => `printf ready > "$${AGENT_READY_VAR}"`;

/**
 * The `hooks` fragment to merge into a worktree's `settings.local.json`: our
 * readiness hook registered for `SessionStart`, writing the marker
 * {@link sessionStartHookCommand} polls for. Kept separate from
 * {@link stopHookSettings} so each contract test stays stable.
 */
export const sessionStartHookSettings = (): Record<string, readonly HookEntry[]> => ({
  SessionStart: [{ matcher: "", hooks: [{ type: "command", command: sessionStartHookCommand() }] }],
});

/**
 * The shell command Claude Code runs on `UserPromptSubmit` — every time a
 * prompt is actually submitted inside the TUI. Writes `submitted` into the
 * per-session marker path from `$AGENT_SUBMITTED`. Its presence is the
 * deterministic proof the submitting Enter landed; its absence after boot means
 * the Enter was dropped under tmux-server backlog (issue #30) and
 * {@link deliverPrompt} must re-drive the paste. Inline shell (like
 * {@link sessionStartHookCommand}) — no payload parsing needed. The path is
 * double-quoted — the command runs through a shell and the marker path may
 * contain spaces.
 */
export const userPromptSubmitHookCommand = (): string =>
  `printf submitted > "$${AGENT_SUBMITTED_VAR}"`;

/**
 * The `hooks` fragment to merge into a worktree's `settings.local.json`: our
 * submitted-marker hook registered for `UserPromptSubmit`, writing the marker
 * {@link deliverPrompt} polls for. Kept separate from {@link stopHookSettings} and
 * {@link sessionStartHookSettings} so each contract test stays stable.
 */
export const userPromptSubmitHookSettings = (): Record<string, readonly HookEntry[]> => ({
  UserPromptSubmit: [
    { matcher: "", hooks: [{ type: "command", command: userPromptSubmitHookCommand() }] },
  ],
});
