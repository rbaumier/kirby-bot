/**
 * Shell.ts — the one Effect-wrapped way to run an external command.
 *
 * Every orchestrator shell-out (tmux, git, glab, jq, rm) goes through
 * here. The codebase has a single consistent boundary to the OS instead
 * of `$`-templates scattered across call sites.
 *
 * Two surfaces:
 *
 *  - {@link runShell} — strict default. Fails with a tagged
 *    {@link ShellError} on non-zero exit, spawn failure, or timeout.
 *    Use this everywhere a non-zero exit is an actual problem.
 *  - {@link runShellAllowingFailure} — opt-out for cleanup paths where
 *    every outcome is acceptable. Returns a {@link CommandResult}.
 */
import type { $ } from "bun";
import { Data, Effect } from "effect";
import { COMMAND_TIMEOUT_MS } from "./config";

/** The outcome of a finished command — exit code plus captured streams. */
export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** The streams of a successful command (exit 0). */
export type ShellOutput = {
  readonly stdout: string;
  readonly stderr: string;
};

/** Exit codes for the two failure modes that are not a real process exit. */
const SPAWN_FAILURE_EXIT_CODE = 127;
const EXIT_CODE_TIMED_OUT = 124;

/** The command ran and exited with a non-zero status. */
export class ShellNonZeroExit extends Data.TaggedError("ShellNonZeroExit")<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {}

/** The command could not be spawned (missing binary, OS error). */
export class ShellSpawnFailed extends Data.TaggedError("ShellSpawnFailed")<{
  readonly cause: string;
}> {}

/** The command exceeded {@link COMMAND_TIMEOUT_MS} and was abandoned. */
export class ShellTimeout extends Data.TaggedError("ShellTimeout")<{
  readonly timeoutMs: number;
}> {}

/** The complete error channel of {@link runShell}. */
export type ShellError = ShellNonZeroExit | ShellSpawnFailed | ShellTimeout;

/** Pick the first non-empty trimmed stream, falling back to a marker. */
const firstNonEmpty = (...candidates: readonly string[]): string => {
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return "<no output>";
};

/** A one-line, human-readable description of any shell failure. */
export const describeShellError = (error: ShellError): string => {
  switch (error._tag) {
    case "ShellNonZeroExit": {
      return `exit ${error.exitCode}: ${firstNonEmpty(error.stderr, error.stdout)}`;
    }
    case "ShellSpawnFailed": {
      return `spawn failed — ${error.cause}`;
    }
    case "ShellTimeout": {
      return `command timed out after ${error.timeoutMs}ms`;
    }
    default: {
      const _exhaustive: never = error;
      return `unhandled shell error: ${String(_exhaustive)}`;
    }
  }
};

/**
 * Run a command and capture its result. Never fails. A non-zero exit,
 * a spawn failure, or a timeout are all reported as a {@link CommandResult}
 * — the caller decides what counts as an error.
 *
 * Use only for cleanup paths where every outcome is acceptable. The
 * default for the codebase is {@link runShell}.
 *
 * Two guards beyond `.nothrow()` (which already suppresses non-zero exits):
 *  - the inner try/catch turns a spawn-level throw (missing binary, OS
 *    error) into exit code {@link SPAWN_FAILURE_EXIT_CODE}.
 *  - a {@link COMMAND_TIMEOUT_MS} timeout turns a hung command into
 *    exit code {@link EXIT_CODE_TIMED_OUT}, preventing a freeze.
 */
export const runShellAllowingFailure = (
  build: () => ReturnType<typeof $>,
): Effect.Effect<CommandResult> =>
  Effect.promise(async (): Promise<CommandResult> => {
    try {
      const output = await build().nothrow().quiet();
      return {
        exitCode: output.exitCode,
        stdout: output.stdout.toString(),
        stderr: output.stderr.toString(),
      };
    } catch (error: unknown) {
      return {
        exitCode: SPAWN_FAILURE_EXIT_CODE,
        stdout: "",
        stderr: String(error),
      };
    }
  }).pipe(
    Effect.timeoutTo({
      duration: `${COMMAND_TIMEOUT_MS} millis`,
      onSuccess: (result: CommandResult) => result,
      onTimeout: (): CommandResult => ({
        exitCode: EXIT_CODE_TIMED_OUT,
        stdout: "",
        stderr: "command timed out",
      }),
    }),
  );

/**
 * Run a command, failing with a tagged {@link ShellError} on a non-zero
 * exit, spawn failure, or timeout. The default shell-out for the
 * codebase — handlers/preflight/tmux all use this so non-zero exits
 * surface in their typed error channel.
 *
 * Built on top of {@link runShellAllowingFailure}; the two sentinel exit
 * codes ({@link SPAWN_FAILURE_EXIT_CODE}, {@link EXIT_CODE_TIMED_OUT}) are
 * routed back to their respective tagged variants. Note: a real process
 * that itself exits 124 or 127 is indistinguishable here — the convention
 * is preserved from the previous API.
 */
export const runShell = (
  build: () => ReturnType<typeof $>,
): Effect.Effect<ShellOutput, ShellError> =>
  runShellAllowingFailure(build).pipe(
    Effect.flatMap((result): Effect.Effect<ShellOutput, ShellError> => {
      switch (result.exitCode) {
        case 0: {
          return Effect.succeed({ stdout: result.stdout, stderr: result.stderr });
        }
        case SPAWN_FAILURE_EXIT_CODE: {
          return Effect.fail(new ShellSpawnFailed({ cause: result.stderr }));
        }
        case EXIT_CODE_TIMED_OUT: {
          return Effect.fail(new ShellTimeout({ timeoutMs: COMMAND_TIMEOUT_MS }));
        }
        default: {
          return Effect.fail(
            new ShellNonZeroExit({
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            }),
          );
        }
      }
    }),
  );
