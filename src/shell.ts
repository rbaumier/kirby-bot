/**
 * Shell.ts — the one Effect-wrapped way to run an external command.
 *
 * Two surfaces:
 *
 *  - {@link runShell} — strict default. Fails with a tagged {@link ShellError}.
 *    Each failure mode (non-zero exit, timeout, spawn failure) is its own
 *    tagged error — callers route on the tag, not on the exit code.
 *  - {@link runShellAllowingFailure} — opt-out for cleanup paths. Folds
 *    every outcome into a {@link CommandResult} with `exitCode === 0` for
 *    success and `exitCode === 1` for any failure mode. Callers that care
 *    about *which* failure read `stderr`; nothing reads the exit code beyond
 *    a binary success/fail check.
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
export type ShellOutput = Omit<CommandResult, "exitCode">;

/** The command ran and exited with a non-zero status. */
export class ShellNonZeroExit extends Data.TaggedError("ShellNonZeroExit")<CommandResult> {}

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

/** A one-line, human-readable description of any shell failure. */
export const describeShellError = (error: ShellError): string => {
  switch (error._tag) {
    case "ShellNonZeroExit": {
      const detail =
        [error.stderr.trim(), error.stdout.trim()].find((stream) => stream !== "") ??
        "<no output>";
      return `exit ${error.exitCode}: ${detail}`;
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
 * Run a command, failing with a tagged {@link ShellError}. The three failure
 * modes are detected at their structural source — `Effect.tryPromise.catch`
 * for spawn errors, `Effect.timeoutFail` for timeouts, the success-channel
 * exit code for process failures — so the three tags are unambiguous.
 *
 * `build` is a thunk so the `$` template is constructed inside the Effect.
 */
export const runShell = (
  build: () => ReturnType<typeof $>,
): Effect.Effect<ShellOutput, ShellError> =>
  Effect.tryPromise({
    try: async (): Promise<CommandResult> => {
      const output = await build().nothrow().quiet();
      return {
        exitCode: output.exitCode,
        stdout: output.stdout.toString(),
        stderr: output.stderr.toString(),
      };
    },
    catch: (cause: unknown): ShellSpawnFailed =>
      new ShellSpawnFailed({ cause: String(cause) }),
  }).pipe(
    Effect.timeoutFail({
      duration: `${COMMAND_TIMEOUT_MS} millis`,
      onTimeout: (): ShellTimeout => new ShellTimeout({ timeoutMs: COMMAND_TIMEOUT_MS }),
    }),
    Effect.flatMap(
      (result): Effect.Effect<ShellOutput, ShellError> =>
        result.exitCode === 0
          ? Effect.succeed({ stdout: result.stdout, stderr: result.stderr })
          : Effect.fail(
              new ShellNonZeroExit({
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
              }),
            ),
    ),
  );

/**
 * Run a command and capture its result without failing. Every failure mode
 * folds into the success channel with `exitCode === 1`; the original detail
 * stays on `stderr`. Use only for cleanup paths where the binary success/fail
 * check is enough. For typed errors prefer {@link runShell}.
 */
export const runShellAllowingFailure = (
  build: () => ReturnType<typeof $>,
): Effect.Effect<CommandResult> =>
  runShell(build).pipe(
    Effect.matchEffect({
      onSuccess: ({ stdout, stderr }) =>
        Effect.succeed<CommandResult>({ exitCode: 0, stdout, stderr }),
      onFailure: (error): Effect.Effect<CommandResult> => {
        switch (error._tag) {
          case "ShellNonZeroExit": {
            return Effect.succeed({
              exitCode: error.exitCode,
              stdout: error.stdout,
              stderr: error.stderr,
            });
          }
          case "ShellTimeout": {
            return Effect.succeed({ exitCode: 1, stdout: "", stderr: "command timed out" });
          }
          case "ShellSpawnFailed": {
            return Effect.succeed({ exitCode: 1, stdout: "", stderr: error.cause });
          }
          default: {
            const _exhaustive: never = error;
            return Effect.die(`unhandled shell error: ${String(_exhaustive)}`);
          }
        }
      },
    }),
  );
