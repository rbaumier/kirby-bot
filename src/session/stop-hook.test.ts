/**
 * Tests for `stop-hook.ts` — the Stop-hook handler.
 *
 * Each case writes a fixture JSONL transcript + a payload, invokes the
 * script as a subprocess (so we exercise the real stdin/argv/exit path),
 * then asserts what the sentinel contains and what (if anything) was
 * written to stdout.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SCRIPT = join(import.meta.dirname, "stop-hook.ts");

type RunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly sentinelContent: string | null;
};

const runHook = (
  payloadExtra: Record<string, unknown>,
  transcriptLines: readonly string[],
): RunResult => {
  const tmp = mkdtempSync(join(tmpdir(), "kirby-stop-hook-"));
  const transcriptPath = join(tmp, "transcript.jsonl");
  const sentinelPath = join(tmp, "sentinel.flag");
  writeFileSync(transcriptPath, transcriptLines.join("\n"));
  const stdin = JSON.stringify({ ...payloadExtra, transcript_path: transcriptPath });
  const result = spawnSync("bun", [SCRIPT, sentinelPath], {
    input: stdin,
    encoding: "utf8",
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    sentinelContent: existsSync(sentinelPath) ? readFileSync(sentinelPath, "utf8") : null,
  };
};

const assistantText = (
  text: string,
  stopReason: string = "end_turn",
): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }], stop_reason: stopReason },
  });

const assistantTool = (id: string, name: string = "Agent"): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input: {} }], stop_reason: "tool_use" },
  });

const userToolResult = (toolUseId: string): string =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "" }] },
  });

describe("stop-hook", () => {
  test("end_turn stop_reason writes last assistant text to sentinel", () => {
    const transcript = [
      assistantTool("t1"),
      userToolResult("t1"),
      assistantText("Implemented.\n\nVERDICT: READY_FOR_REVIEW"),
    ];
    const { sentinelContent, stdout } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBe("Implemented.\n\nVERDICT: READY_FOR_REVIEW");
    expect(stdout).toBe("");
  });

  test("tool_use stop_reason blocks without writing the sentinel", () => {
    // Reproduction of the #29 case: last assistant entry is a tool_use spawn,
    // all prior tool_results landed, but the model hasn't been re-prompted
    // so the verdict was never emitted.
    const transcript = [
      assistantTool("t1"),
      userToolResult("t1"),
      assistantTool("t2"),
      userToolResult("t2"),
      assistantTool("t3"),
      userToolResult("t3"),
    ];
    const { sentinelContent, stdout } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBeNull();
    const decision = JSON.parse(stdout);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("tool_use");
  });

  test("joins multiple text blocks in the last assistant message", () => {
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Part one." },
            { type: "text", text: "Part two." },
            { type: "text", text: "VERDICT: REVIEW_DONE" },
          ],
          stop_reason: "end_turn",
        },
      }),
    ];
    const { sentinelContent } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBe("Part one.\nPart two.\nVERDICT: REVIEW_DONE");
  });

  test("StopFailure writes the sentinel even when stop_reason is not end_turn", () => {
    // A failed Stop can't be blocked — preserve whatever last text exists so
    // the operator (or a recovery layer) has something to triage.
    const transcript = [
      assistantText("Crashed mid-way after subagent error.", "tool_use"),
    ];
    const { sentinelContent, stdout } = runHook(
      { hook_event_name: "StopFailure" },
      transcript,
    );
    expect(sentinelContent).toBe("Crashed mid-way after subagent error.");
    expect(stdout).toBe("");
  });

  test("missing transcript_path exits cleanly without writing the sentinel", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kirby-stop-hook-"));
    const sentinelPath = join(tmp, "sentinel.flag");
    const stdin = JSON.stringify({ hook_event_name: "Stop" });
    spawnSync("bun", [SCRIPT, sentinelPath], { input: stdin, encoding: "utf8" });
    expect(existsSync(sentinelPath)).toBe(false);
  });

  test("non-array assistant content on end_turn writes empty sentinel (no crash)", () => {
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: { content: "plain string content", stop_reason: "end_turn" },
      }),
    ];
    const { sentinelContent } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBe("");
  });

  test("missing stop_reason blocks with '(missing)' reason", () => {
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "no stop reason here" }] },
      }),
    ];
    const { sentinelContent, stdout } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBeNull();
    const decision = JSON.parse(stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("(missing)");
  });

  test("empty transcript + Stop blocks; empty transcript + StopFailure writes empty sentinel", () => {
    const blocked = runHook({ hook_event_name: "Stop" }, []);
    expect(blocked.sentinelContent).toBeNull();
    const decision = JSON.parse(blocked.stdout) as { decision: string };
    expect(decision.decision).toBe("block");

    const failed = runHook({ hook_event_name: "StopFailure" }, []);
    expect(failed.sentinelContent).toBe("");
  });

});
