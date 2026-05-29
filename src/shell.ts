/**
 * Shell.ts — the one Effect-wrapped way to run an external command.
 *
 * {@link runShell} is the strict default. Each failure mode (non-zero exit,
 * timeout, spawn failure) is its own tagged error — callers route on the tag,
 * not on the exit code. Cleanup paths that don't care about the outcome use
 * `runShell(...).pipe(Effect.ignore)`.
 */
import { $ } from "bun";
import { Data, Effect } from "effect";
import { COMMAND_TIMEOUT_MS } from "./config";

/** The streams of a successful command (exit 0). */
export type ShellOutput = {
  readonly stdout: string;
  readonly stderr: string;
};

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
    try: async () => {
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

/** Run `git -C <worktree> <args>` through {@link runShell}. */
export const runShellGit = (
  worktree: string,
  args: readonly string[],
): Effect.Effect<ShellOutput, ShellError> => runShell(() => $`git -C ${worktree} ${args}`);

