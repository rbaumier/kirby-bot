/**
 * Tests for `stop-hook.ts` — the Stop-hook handler.
 *
 * Each case writes a fixture JSONL transcript + a payload, invokes the
 * script as a subprocess (so we exercise the real stdin/argv/exit path),
 * then asserts what the sentinel contains and what (if anything) was
 * written to stdout.
 */
import { spawn, spawnSync } from "node:child_process";
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

  test("stop_hook_active + missing stop_reason stops looping and captures the earlier verdict", () => {
    // Real #1079 case: the router emitted ROUTING_DONE, then produced an empty
    // "No response" turn with a missing stop_reason. The first Stop blocked
    // (resume once); on the SECOND fire Claude Code sets stop_hook_active.
    // Without this guard the hook keeps blocking to the runtime's cap, the cap
    // override ends the turn having written no sentinel, and the session times
    // out. It must instead stop blocking and recover the earlier verdict.
    const transcript = [
      assistantText("Routing complete.\nVERDICT: ROUTING_DONE"),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "" }] },
      }),
    ];
    const { sentinelContent, stdout } = runHook(
      { hook_event_name: "Stop", stop_hook_active: true },
      transcript,
    );
    expect(sentinelContent).toBe("Routing complete.\nVERDICT: ROUTING_DONE");
    expect(stdout).toBe("");
  });

  test("stop_hook_active + missing stop_reason with no verdict writes the last text (reprompt, not timeout)", () => {
    // No verdict anywhere and the loop has already fired once. Falling through
    // writes the last text so the orchestrator's single reprompt fires —
    // strictly better than spinning to the cap and timing out.
    const transcript = [
      assistantText("Working.", "tool_use"),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "No response." }] },
      }),
    ];
    const { sentinelContent, stdout } = runHook(
      { hook_event_name: "Stop", stop_hook_active: true },
      transcript,
    );
    expect(sentinelContent).toBe("No response.");
    expect(stdout).toBe("");
  });

  test("tool_use keeps blocking even when stop_hook_active is set (legit multi-step work)", () => {
    // stop_hook_active breaks a degenerate non-tool_use loop, NOT a genuine
    // tool_use continuation — the agent may need many tool turns and must not
    // be cut short. Only the runtime's block cap bounds a pathological spin.
    const transcript = [
      assistantTool("t1"),
      userToolResult("t1"),
      assistantTool("t2"),
    ];
    const { sentinelContent, stdout } = runHook(
      { hook_event_name: "Stop", stop_hook_active: true },
      transcript,
    );
    expect(sentinelContent).toBeNull();
    const decision = JSON.parse(stdout) as { decision: string };
    expect(decision.decision).toBe("block");
  });

  test("empty transcript + Stop blocks; empty transcript + StopFailure writes empty sentinel", () => {
    const blocked = runHook({ hook_event_name: "Stop" }, []);
    expect(blocked.sentinelContent).toBeNull();
    const decision = JSON.parse(blocked.stdout) as { decision: string };
    expect(decision.decision).toBe("block");

    const failed = runHook({ hook_event_name: "StopFailure" }, []);
    expect(failed.sentinelContent).toBe("");
  });

  test("captures the verdict-bearing entry when a verdict-less message follows it", () => {
    // Real #893 case: the implementer declared its verdict, then ended its
    // turn again with a closing summary that carried no verdict line. Capturing
    // only the last assistant entry wrote the summary and stalled the issue.
    const transcript = [
      assistantText("MR opened.\nVERDICT: READY_FOR_REVIEW"),
      assistantText("Session terminée. Récapitulatif du travail livré."),
    ];
    const { sentinelContent, stdout } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBe("MR opened.\nVERDICT: READY_FOR_REVIEW");
    expect(stdout).toBe("");
  });

  test("skips trailing content-less closing turns to capture the verdict", () => {
    // Real #882 case: the verdict was followed by two empty end_turn messages
    // that overwrote the capture with an empty sentinel.
    const transcript = [
      assistantText("Implemented and pushed.\nVERDICT: READY_FOR_REVIEW"),
      assistantText(""),
      assistantText(""),
    ];
    const { sentinelContent } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBe("Implemented and pushed.\nVERDICT: READY_FOR_REVIEW");
  });

  test("captures the most recent verdict when several appear across turns", () => {
    // After a reprompt the agent may re-declare; the latest intent wins.
    const transcript = [
      assistantText("First pass.\nVERDICT: NEEDS_FIX"),
      assistantText("On reflection it is fine.\nVERDICT: CONVERGED"),
    ];
    const { sentinelContent } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBe("On reflection it is fine.\nVERDICT: CONVERGED");
  });

  test("captures a verdict emitted in a tool_use turn when the last turn is a verdict-less end_turn", () => {
    // Decoupling check: the block-vs-write decision keys off the LAST entry's
    // stop_reason (end_turn here → write), but the verdict lived in an earlier
    // entry that also called a tool (stop_reason tool_use). The capture must
    // still find it. This is the shape the implementer's self-diagnosis named.
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Opening the MR.\nVERDICT: READY_FOR_REVIEW" },
            { type: "tool_use", id: "t1", name: "Bash", input: {} },
          ],
          stop_reason: "tool_use",
        },
      }),
      userToolResult("t1"),
      assistantText("MR !900 opened."),
    ];
    const { sentinelContent, stdout } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBe("Opening the MR.\nVERDICT: READY_FOR_REVIEW");
    expect(stdout).toBe("");
  });

  test("falls back to the last assistant entry when none carries a verdict", () => {
    // No verdict anywhere → the orchestrator must still see the last text so
    // its single reprompt fires (it does not block, the turn ended cleanly).
    const transcript = [
      assistantText("Working on it."),
      assistantText("Still going, no verdict yet."),
    ];
    const { sentinelContent, stdout } = runHook({ hook_event_name: "Stop" }, transcript);
    expect(sentinelContent).toBe("Still going, no verdict yet.");
    expect(stdout).toBe("");
  });

  test("re-reads the transcript when the final entry is still streaming, capturing the late verdict", async () => {
    // Real #980 case: Claude Code wrote the final assistant entry as an empty
    // skeleton (end_turn, no content), then re-appended the SAME message.id with
    // the verdict ~6ms later. The hook read inside that window, captured "", and
    // the orchestrator reprompted — discarding the ROUTING_DONE it had emitted.
    // The hook must re-read until content lands instead of writing an empty
    // sentinel. We widen the retry window via env so the timing is deterministic.
    const tmp = mkdtempSync(join(tmpdir(), "kirby-stop-hook-"));
    const transcriptPath = join(tmp, "transcript.jsonl");
    const sentinelPath = join(tmp, "sentinel.flag");
    const skeleton = JSON.stringify({
      type: "assistant",
      message: { id: "m1", content: [{ type: "text", text: "" }], stop_reason: "end_turn" },
    });
    const full = JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        content: [{ type: "text", text: "Routing complete.\nVERDICT: ROUTING_DONE" }],
        stop_reason: "end_turn",
      },
    });
    writeFileSync(transcriptPath, skeleton);
    const stdin = JSON.stringify({ hook_event_name: "Stop", transcript_path: transcriptPath });
    const child = spawn("bun", [SCRIPT, sentinelPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KIRBY_STOP_HOOK_RETRY_ATTEMPTS: "40", KIRBY_STOP_HOOK_RETRY_MS: "25" },
    });
    child.stdin.end(stdin);
    // After the hook has started retrying, the stream re-appends the full entry.
    await Bun.sleep(80);
    writeFileSync(transcriptPath, `${skeleton}\n${full}`);
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(readFileSync(sentinelPath, "utf8")).toBe("Routing complete.\nVERDICT: ROUTING_DONE");
  });

});
