/**
 * Session/tmux.ts — the tmux session lifecycle, as Effects.
 *
 * A phase runs inside a detached tmux session. The session is
 * created, a `claude` process is booted in it and the prompt
 * pasted, and the session is later killed. Each step is an Effect,
 * so the lifecycle composes cleanly into the `acquireUseRelease`
 * bracket in phase.ts.
 */
import { $ } from "bun";
import { Console, Effect } from "effect";
import { describeShellError, runShell } from "../shell";
import { TmuxError } from "./errors";

/**
 * Run one tmux command, failing {@link TmuxError} on a non-zero exit.
 *
 * For a real non-zero exit, `stderr` carries the trimmed process stderr
 * — preserves the legacy contract. The two non-process modes (spawn,
 * timeout) fall back to {@link describeShellError} as the reason.
 */
const tmuxStep = (
  step: string,
  build: () => ReturnType<typeof $>,
): Effect.Effect<void, TmuxError> =>
  runShell(build).pipe(
    Effect.mapError(
      (error) =>
        new TmuxError({
          step,
          stderr:
            error._tag === "ShellNonZeroExit" ? error.stderr.trim() : describeShellError(error),
        }),
    ),
    Effect.asVoid,
  );

/** Create a detached tmux session rooted at `worktree`. */
export const createSession = (session: string, worktree: string): Effect.Effect<void, TmuxError> =>
  tmuxStep("new-session", () => $`tmux new-session -d -s ${session} -c ${worktree}`);

/** Kill a tmux session. Best-effort — a missing session is not an error. */
export const killSession = (session: string): Effect.Effect<void> =>
  runShell(() => $`tmux kill-session -t ${session}`).pipe(Effect.ignore);

/**
 * One-line nudge sent to a session that stopped without emitting a verdict.
 * Single line, no newline — delivered as one keystroke string then Enter, so
 * the idle TUI receives it the same way the boot prompt's trailing Enter is
 * sent (no buffer paste needed for a short reminder).
 */
export const VERDICT_REMINDER =
  "You stopped without a verdict. Emit it now as `VERDICT: TOKEN` on its own line, with nothing else on that line.";

/**
 * Re-prompt an idle session to emit its verdict (issue #26). The session must
 * already be sitting at the `claude` prompt after an `end_turn`; this types the
 * reminder and submits it, kicking off one more turn whose Stop hook rewrites
 * the sentinel. Best-effort delivery: if the keys don't land, the caller's
 * re-poll simply times out into the same terminal NoVerdict, never worse.
 */
export const repromptForVerdict = (session: string): Effect.Effect<void, TmuxError> =>
  tmuxStep("reprompt-verdict", () => $`tmux send-keys -t ${session} ${VERDICT_REMINDER} Enter`);

/** Capture the visible content of a session's pane. Empty string on any failure. */
const capturePane = (session: string): Effect.Effect<string> =>
  runShell(() => $`tmux capture-pane -p -t ${session}`).pipe(
    Effect.map((result) => result.stdout),
    Effect.catchAll(() => Effect.succeed("")),
  );

/**
 * Wait for the `claude` TUI to settle before pasting into it.
 *
 * Polls the pane content once a second; once it is unchanged for two
 * consecutive ticks the TUI has finished booting. Capped at 20 ticks — on a
 * pathologically slow start it proceeds anyway rather than hang forever. Far
 * less fragile than a blind fixed sleep into a not-yet-ready pane.
 */
const waitForTuiReady = (session: string): Effect.Effect<void> =>
  Effect.iterate(
    { ticks: 0, stableTicks: 0, previousPane: "" },
    {
      while: (state) => state.ticks < 20 && state.stableTicks < 2,
      body: (state) =>
        Effect.sleep("1 second").pipe(
          Effect.flatMap(() => capturePane(session)),
          Effect.map((pane) => ({
            ticks: state.ticks + 1,
            stableTicks: pane === state.previousPane ? state.stableTicks + 1 : 0,
            previousPane: pane,
          })),
        ),
    },
  ).pipe(Effect.asVoid);

/**
 * Collapsed-paste marker the Claude TUI renders once a multi-line prompt has
 * landed in the input area (`[Pasted text #N +M lines]`). kirby-bot prompts
 * are always large and multi-line, so the TUI always collapses them — the
 * marker's presence is a reliable proxy for "the paste actually arrived",
 * which pane stability alone is NOT under tmux-server backlog (issue #30).
 */
export const TUI_PASTE_MARKER = "[Pasted text";

/** Whether the pane shows a delivered (collapsed) paste in the input area. */
export const paneShowsPaste = (pane: string): boolean => pane.includes(TUI_PASTE_MARKER);

/** Bounded load+paste attempts before falling through to Enter regardless. */
const PASTE_MAX_ATTEMPTS = 3;

/**
 * Load the prompt into the session's named buffer, paste it into the pane, and
 * verify the paste actually landed before returning. Retries up to
 * {@link PASTE_MAX_ATTEMPTS} times.
 *
 * Two races stack here:
 *
 *  1. **Global-buffer cross-paste.** Without `-b ${session}`, N concurrent
 *     `load-buffer` calls overwrite the same anonymous slot, so most sessions
 *     paste another agent's prompt (or an empty buffer). The named buffer
 *     (keyed by session) isolates each session's payload.
 *
 *  2. **Async delivery (issue #30).** `tmux paste-buffer` only *enqueues* the
 *     write with the tmux server, which drains its queue asynchronously. Under
 *     high concurrency (15+ sessions) the server backlogs: `waitForTuiReady`
 *     observes a visually-stable pane (still the empty-input placeholder) and
 *     returns before the bytes reach the application. The caller then sends
 *     Enter on an empty input and the session idles at 0% forever.
 *
 * After each paste we wait for the TUI to settle, then check the pane for the
 * collapsed-paste marker. Absent → re-load + re-paste. We verify with the
 * positive marker (not placeholder-absence) so the check biases toward
 * retrying: a false "not delivered" costs at worst a benign double-paste (the
 * agent reads its prompt twice and still emits one verdict), whereas a false
 * "delivered" would send Enter on an empty input — the exact stuck-session
 * bug. If every attempt fails we fall through; the caller sends Enter and the
 * session degrades to the pre-fix NoVerdict path, never worse.
 */
const loadAndPastePrompt = (
  session: string,
  promptFile: string,
): Effect.Effect<void, TmuxError> =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= PASTE_MAX_ATTEMPTS; attempt++) {
      yield* tmuxStep("load-buffer", () => $`tmux load-buffer -b ${session} ${promptFile}`);
      yield* tmuxStep("paste-buffer", () => $`tmux paste-buffer -b ${session} -t ${session}`);
      yield* waitForTuiReady(session);
      const pane = yield* capturePane(session);
      if (paneShowsPaste(pane)) { return; }
      yield* Console.log(
        `[tmux ${session}] paste not delivered (attempt ${attempt}/${PASTE_MAX_ATTEMPTS})` +
          (attempt < PASTE_MAX_ATTEMPTS ? " — re-pasting" : " — sending Enter anyway"),
      );
    }
  });

/** Input for {@link bootClaudeSession}. */
type BootClaudeSessionInput = {
  readonly session: string;
  readonly tmuxLogPath: string;
  readonly promptFile: string;
  /**
   * Env vars to export into the tmux shell *before* `claude` launches. Read by
   * the Stop-hook subprocess via standard inheritance — used to dispatch to a
   * per-session sentinel path when N parallel sessions share one
   * `settings.local.json`. Single-quoted in the `export` line so spaces and
   * shell metacharacters in values are preserved verbatim.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Model alias for the `claude --model <alias>` flag. The CLI accepts
   * `haiku` / `sonnet` / `opus` — the upstream Code-Review skill warns that
   * omitting this means the session inherits the orchestrator's model, so a
   * "haiku" agent silently runs on Opus. Per-agent fan-out always sets this.
   * Optional for backward compat with the single-prompt phase runner.
   */
  readonly model?: string;
};

/** Shell-quote a value for safe inclusion in a single-quoted `export`. */
export const sqEscape = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Valid POSIX environment-variable identifier: letter/underscore start, alphanumeric/underscore rest. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Valid `claude --model` alias. The CLI's documented aliases are exactly
 * `haiku`, `sonnet`, `opus`; we accept the same lowercase ASCII subset to
 * prevent shell-injection through this knob. A full model identifier (e.g.
 * `claude-haiku-4-5-20251001`) also matches the regex — useful when a future
 * caller pins a specific revision.
 */
export const MODEL_ALIAS_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Boot `claude` inside an already-created session and paste the prompt.
 * The session must already exist (see {@link createSession}); this only
 * drives it.
 */
export const bootClaudeSession = (input: BootClaudeSessionInput): Effect.Effect<void, TmuxError> =>
  Effect.gen(function* () {
    // Mirror the pane into a log file for live tailing. The path is quoted —
    // tmux runs this string through a shell, and the path may contain spaces.
    yield* tmuxStep(
      "pipe-pane",
      () => $`tmux pipe-pane -t ${input.session} -O ${`cat >> "${input.tmuxLogPath}"`}`,
    );
    if (input.env !== undefined) {
      for (const [key] of Object.entries(input.env)) {
        if (!ENV_KEY_RE.test(key)) {
          yield* Effect.fail(
            new TmuxError({ step: "export-env", stderr: `invalid env key: ${key}` }),
          );
        }
      }
      const exports = Object.entries(input.env)
        .map(([key, value]) => `export ${key}=${sqEscape(value)}`)
        .join(" && ");
      yield* tmuxStep(
        "export-env",
        () => $`tmux send-keys -t ${input.session} ${exports} Enter`,
      );
    }
    if (input.model !== undefined && !MODEL_ALIAS_RE.test(input.model)) {
      yield* Effect.fail(
        new TmuxError({ step: "start-claude", stderr: `invalid model alias: ${input.model}` }),
      );
    }
    const claudeCmd =
      input.model === undefined
        ? "claude --dangerously-skip-permissions"
        : `claude --dangerously-skip-permissions --model ${input.model}`;
    yield* tmuxStep(
      "start-claude",
      () => $`tmux send-keys -t ${input.session} ${claudeCmd} Enter`,
    );
    yield* waitForTuiReady(input.session);
    // Load + paste the prompt, verifying the paste actually landed before we
    // send Enter. See {@link loadAndPastePrompt} for the two races this guards
    // against (global-buffer cross-paste, async delivery under backlog — #30).
    yield* loadAndPastePrompt(input.session, input.promptFile);
    yield* tmuxStep("send-enter", () => $`tmux send-keys -t ${input.session} Enter`);
  });
