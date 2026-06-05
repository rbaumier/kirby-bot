/**
 * Shell.test.ts — the strict/permissive surface plus the error formatter.
 *
 * Live shell-outs against `printf`/`true`/`false` keep the test surface
 * realistic (Bun's `$` wraps a real subprocess). The point: pin the
 * mapping from process exit to tagged error so future API drift fails
 * loud.
 */
import { describe, expect, it } from "bun:test";
import { $ } from "bun";
import { Effect } from "effect";
import type { ShellError, ShellOutput } from "./shell";
import {
  describeShellError,
  runShell,
  ShellNonZeroExit,
  ShellSpawnFailed,
  ShellTimeout,
  withShellRetry,
} from "./shell";

describe("runShell (strict)", () => {
  it("exit 0 → success with captured stdout", async () => {
    const out = await Effect.runPromise(runShell(() => $`printf hello`));
    expect(out.stdout).toBe("hello");
  });

  it("exit non-zero → ShellNonZeroExit with the exit code", async () => {
    const error = await Effect.runPromise(Effect.flip(runShell(() => $`false`)));
    expect(error).toMatchObject({ _tag: "ShellNonZeroExit", exitCode: 1 });
  });
});

describe("withShellRetry", () => {
  /** An Effect that fails `failTimes` with `error`, then succeeds, counting calls. */
  const flaky = (failTimes: number, error: ShellError) => {
    let attempts = 0;
    const call = Effect.suspend((): Effect.Effect<ShellOutput, ShellError> => {
      attempts += 1;
      return attempts <= failTimes
        ? Effect.fail(error)
        : Effect.succeed({ stdout: "ok", stderr: "" });
    });
    return { call, attempts: () => attempts };
  };

  it("retries a transient ShellTimeout, then succeeds", async () => {
    const { call, attempts } = flaky(1, new ShellTimeout({ timeoutMs: 1 }));
    const out = await Effect.runPromise(withShellRetry(call));
    expect(out.stdout).toBe("ok");
    expect(attempts()).toBe(2);
  });

  it("does NOT retry a deterministic ShellNonZeroExit", async () => {
    const { call, attempts } = flaky(
      Number.POSITIVE_INFINITY,
      new ShellNonZeroExit({ exitCode: 1, stdout: "", stderr: "" }),
    );
    const error = await Effect.runPromise(Effect.flip(withShellRetry(call)));
    expect(error).toMatchObject({ _tag: "ShellNonZeroExit" });
    expect(attempts()).toBe(1);
  });

  it("retries a transient ShellSpawnFailed up to the cap, then surfaces it", async () => {
    const { call, attempts } = flaky(
      Number.POSITIVE_INFINITY,
      new ShellSpawnFailed({ cause: "EAGAIN" }),
    );
    const error = await Effect.runPromise(Effect.flip(withShellRetry(call)));
    expect(error).toMatchObject({ _tag: "ShellSpawnFailed" });
    expect(attempts()).toBe(3); // 1 initial + 2 retries (Schedule.recurs(2))
  });
});

describe("describeShellError", () => {
  it("ShellNonZeroExit → uses stderr when present", () => {
    const error = new ShellNonZeroExit({ exitCode: 2, stdout: "", stderr: "  boom\n" });
    expect(describeShellError(error)).toBe("exit 2: boom");
  });

  it("ShellNonZeroExit → falls back to stdout when stderr is empty", () => {
    const error = new ShellNonZeroExit({ exitCode: 3, stdout: "fallback\n", stderr: "" });
    expect(describeShellError(error)).toBe("exit 3: fallback");
  });

  it("ShellNonZeroExit → marker when both streams are empty", () => {
    const error = new ShellNonZeroExit({ exitCode: 4, stdout: "", stderr: "" });
    expect(describeShellError(error)).toBe("exit 4: <no output>");
  });

  it("ShellSpawnFailed → carries the cause", () => {
    const error = new ShellSpawnFailed({ cause: "ENOENT: nope" });
    expect(describeShellError(error)).toBe("spawn failed — ENOENT: nope");
  });

  it("ShellTimeout → carries the configured timeout", () => {
    const error = new ShellTimeout({ timeoutMs: 1234 });
    expect(describeShellError(error)).toBe("command timed out after 1234ms");
  });
});
