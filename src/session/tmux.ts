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
import { Effect } from "effect";
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
};

/** Shell-quote a value for safe inclusion in a single-quoted `export`. */
export const sqEscape = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Valid POSIX environment-variable identifier: letter/underscore start, alphanumeric/underscore rest. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    yield* tmuxStep(
      "start-claude",
      () => $`tmux send-keys -t ${input.session} ${"claude --dangerously-skip-permissions"} Enter`,
    );
    yield* waitForTuiReady(input.session);
    yield* tmuxStep("load-buffer", () => $`tmux load-buffer ${input.promptFile}`);
    yield* tmuxStep("paste-buffer", () => $`tmux paste-buffer -t ${input.session}`);
    yield* Effect.sleep("500 millis");
    yield* tmuxStep("send-enter", () => $`tmux send-keys -t ${input.session} Enter`);
  });
