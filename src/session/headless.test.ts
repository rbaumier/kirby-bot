import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { RunArtifacts, type RunArtifactsShape } from "../run-artifacts";
import {
  buildHeadlessArgs,
  parseHeadlessResult,
  type RunHeadless,
  runOneHeadlessSession,
  type SpawnHeadlessInput,
} from "./headless";
import type { RunOneClaudeSessionInput } from "./phase-primitives";

describe("buildHeadlessArgs", () => {
  it("emits the print + stream-json base flags with no model", () => {
    expect(buildHeadlessArgs()).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ]);
  });

  it("appends --model when given", () => {
    expect(buildHeadlessArgs("opus")).toContain("--model");
    expect(buildHeadlessArgs("opus").at(-1)).toBe("opus");
  });

  it("appends strict mcp flags when given a config path", () => {
    const args = buildHeadlessArgs(undefined, "/assets/mcp/phase.json");
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(-2)).toEqual(["--mcp-config", "/assets/mcp/phase.json"]);
  });

  it("rejects a shell-injecting model alias", () => {
    expect(() => buildHeadlessArgs("opus; rm -rf /")).toThrow("invalid model alias");
  });
});

describe("parseHeadlessResult", () => {
  const result = (sessionId: string, text: string): string =>
    JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, result: text });

  it("extracts session id and final text from the result line", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", session_id: "s1", message: {} }),
      result("s1", "ok\nVERDICT: REVIEW_DONE"),
    ].join("\n");
    expect(parseHeadlessResult(stdout)).toEqual({
      sessionId: "s1",
      finalText: "ok\nVERDICT: REVIEW_DONE",
    });
  });

  it("tolerates interleaved non-JSON lines and trailing blank lines", () => {
    const stdout = `not json\n${result("s2", "done")}\n\n`;
    expect(parseHeadlessResult(stdout)).toEqual({
      sessionId: "s2",
      finalText: "done",
    });
  });

  it("returns nulls when no result line was printed (killed mid-run)", () => {
    const stdout = JSON.stringify({ type: "assistant", session_id: "s3", message: {} });
    expect(parseHeadlessResult(stdout)).toEqual({
      sessionId: "s3",
      finalText: null,
    });
  });
});

describe("runOneHeadlessSession", () => {
  let dir: string;
  let promptFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kirby-headless-"));
    promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "review this diff");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Minimal RunArtifacts whose logEvent is a no-op — the runner only logs. */
  const stubArtifacts: RunArtifactsShape = {
    dir: "/tmp/kirby-test",
    runId: "test",
    logPath: "/tmp/kirby-test/run.jsonl",
    sentinelPath: () => "/tmp/kirby-test/sentinel",
    tmuxLogPath: () => "/tmp/kirby-test/tmux.log",
    promptFilePath: () => "/tmp/kirby-test/prompt.md",
    findingsPath: () => "/tmp/kirby-test/findings.json",
    triagePath: () => "/tmp/kirby-test/triage.json",
    sessionName: () => "afk-test",
    logEvent: () => Effect.void,
  };
  const TestArtifacts = Layer.succeed(RunArtifacts, stubArtifacts);

  const resultLine = (sessionId: string, text: string): string =>
    JSON.stringify({ type: "result", session_id: sessionId, result: text, is_error: false });

  /** A scripted runner: returns stdouts[i] for the i-th call, recording inputs. */
  const fakeRun = (stdouts: readonly string[]): { fn: RunHeadless; calls: SpawnHeadlessInput[] } => {
    const calls: SpawnHeadlessInput[] = [];
    const fn: RunHeadless = (input) => {
      const stdout = stdouts[Math.min(calls.length, stdouts.length - 1)] ?? "";
      calls.push(input);
      return Effect.succeed({ stdout, stderr: "", exitCode: 0 });
    };
    return { fn, calls };
  };

  const input = (overrides?: Partial<RunOneClaudeSessionInput>): RunOneClaudeSessionInput => ({
    phase: "review",
    worktree: dir,
    session: "afk-test",
    tmuxLogPath: join(dir, "tmux.log"),
    promptFile,
    sentinel: join(dir, "sentinel"),
    timeoutMs: 60_000,
    logContext: { issueIid: 1, iteration: 0 },
    expectedVerdicts: ["REVIEW_DONE"],
    ...overrides,
  });

  it("returns the verdict parsed from the first run's result text", async () => {
    const { fn, calls } = fakeRun([resultLine("s1", "all good\nVERDICT: REVIEW_DONE")]);
    const verdict = await Effect.runPromise(
      runOneHeadlessSession(input(), fn).pipe(Effect.provide(TestArtifacts)),
    );
    expect(verdict).toBe("REVIEW_DONE");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.promptText).toBe("review this diff");
    expect(calls[0]?.cwd).toBe(dir);
  });

  it("re-prompts once via --resume when the first run has no verdict", async () => {
    const { fn, calls } = fakeRun([
      resultLine("sess-9", "I looked but forgot to emit a verdict"),
      resultLine("sess-9", "VERDICT: REVIEW_DONE"),
    ]);
    const verdict = await Effect.runPromise(
      runOneHeadlessSession(input(), fn).pipe(Effect.provide(TestArtifacts)),
    );
    expect(verdict).toBe("REVIEW_DONE");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toContain("--resume");
    expect(calls[1]?.args).toContain("sess-9");
    expect(calls[1]?.promptText).toContain("VERDICT");
  });

  it("fails NoVerdict after a re-prompt that still has no verdict", async () => {
    const { fn, calls } = fakeRun([
      resultLine("sess-1", "no verdict"),
      resultLine("sess-1", "still no verdict"),
    ]);
    const error = await Effect.runPromise(
      runOneHeadlessSession(input(), fn).pipe(Effect.flip, Effect.provide(TestArtifacts)),
    );
    expect(error._tag).toBe("NoVerdict");
    expect(calls).toHaveLength(2);
  });

  it("does not re-prompt when there is no session id to resume", async () => {
    const { fn, calls } = fakeRun(["garbage with no parseable result line"]);
    const error = await Effect.runPromise(
      runOneHeadlessSession(input(), fn).pipe(Effect.flip, Effect.provide(TestArtifacts)),
    );
    expect(error._tag).toBe("NoVerdict");
    expect(calls).toHaveLength(1);
  });

  it("fails WorkspaceError (not NoVerdict) on a non-zero claude -p exit", async () => {
    const fn: RunHeadless = () => Effect.succeed({ stdout: "", stderr: "error: bad flag", exitCode: 2 });
    const error = await Effect.runPromise(
      runOneHeadlessSession(input(), fn).pipe(Effect.flip, Effect.provide(TestArtifacts)),
    );
    expect(error._tag).toBe("WorkspaceError");
    expect(String((error as { reason?: string }).reason)).toContain("bad flag");
  });
});
