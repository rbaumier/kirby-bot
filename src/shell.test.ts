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
import {
  describeShellError,
  runShell,
  ShellNonZeroExit,
  ShellSpawnFailed,
  ShellTimeout,
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
