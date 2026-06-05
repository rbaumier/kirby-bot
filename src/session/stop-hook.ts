#!/usr/bin/env bun
/**
 * Stop-hook.ts — Claude Code Stop-hook handler for kirby-bot phase sessions.
 *
 * Reads the Stop payload on stdin, walks the transcript JSONL pointed to by
 * `.transcript_path`, and routes on the LAST assistant entry's `stop_reason`:
 *
 *  - `"end_turn"` → the model genuinely finished. Capture the most recent
 *    assistant entry that carries a `VERDICT:` line (joined across `text`
 *    blocks) and write it atomically to the sentinel; fall back to the last
 *    assistant entry when none carries a verdict.
 *
 *  - anything else (`"tool_use"`, `"max_tokens"`, missing, …) AND this is a
 *    `Stop` (not `StopFailure`) → the runtime is between turns but the model
 *    hasn't completed. Emit `{"decision":"block","reason":"…"}` on stdout to
 *    ask Claude Code to resume the agent loop, and leave the sentinel
 *    untouched so the orchestrator keeps polling.
 *
 *  - `StopFailure` → write the captured text anyway. Blocking a failure makes
 *    no sense.
 *
 * Capturing the verdict-bearing entry — not blindly the last one — is what
 * keeps a verdict from being lost when the model declares it and then keeps
 * talking (opens the MR, appends a summary, emits content-less closing
 * turns). The trailing verdict-less message would otherwise overwrite the
 * capture and the orchestrator would stall the issue as if no verdict was
 * ever emitted. See the `containsVerdictLine` selection below.
 *
 * The previous one-liner `jq -r '.last_assistant_message // empty'` read a
 * field that doesn't exist on Claude Code 2.1.150's Stop payload, so the
 * sentinel was always empty and every phase failed with NoVerdict. See #29.
 *
 * Why `stop_reason` and not a pending-subagent count? Inspection of the #29
 * repro transcript showed all 7 `Agent` subagents had returned by the time
 * Stop fired — a pending-count gate would not have caught the bug. The
 * model's `stop_reason: "tool_use"` did. That is the only reliable signal
 * for "model not done yet".
 *
 * Usage: `bun stop-hook.ts <sentinel-path>`
 * stdin: Claude Code Stop payload JSON. Required keys: `transcript_path`,
 *        `hook_event_name`.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { containsVerdictLine } from "./verdict";

const sentinel = process.argv[2];
if (sentinel === undefined) {
  process.stderr.write("stop-hook.ts: missing sentinel path argument\n");
  process.exit(0);
}

type StopPayload = {
  readonly transcript_path: string | undefined;
  readonly hook_event_name: string | undefined;
};

type TranscriptEntry = {
  readonly type: string | undefined;
  readonly message: { readonly content: unknown; readonly stop_reason: string | undefined } | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseStopPayload = (raw: string): StopPayload | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) { return null; }
    return {
      transcript_path: typeof parsed.transcript_path === "string" ? parsed.transcript_path : undefined,
      hook_event_name: typeof parsed.hook_event_name === "string" ? parsed.hook_event_name : undefined,
    };
  } catch {
    return null;
  }
};

const parseTranscriptEntry = (raw: string): TranscriptEntry | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) { return null; }
    const message = isRecord(parsed.message)
      ? {
          content: parsed.message.content,
          stop_reason:
            typeof parsed.message.stop_reason === "string" ? parsed.message.stop_reason : undefined,
        }
      : undefined;
    return {
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      message,
    };
  } catch {
    return null;
  }
};

const isTextBlock = (block: unknown): block is { type: "text"; text: string } =>
  isRecord(block) && block.type === "text" && typeof block.text === "string";

const tryRead = (label: string, fn: () => string): string | null => {
  try {
    return fn();
  } catch (cause) {
    process.stderr.write(`stop-hook.ts: ${label} failed: ${String(cause)}\n`);
    return null;
  }
};

const rawPayload = tryRead("read stdin", () => readFileSync(0, "utf8"));
if (rawPayload === null) { process.exit(0); }

const payload = parseStopPayload(rawPayload);
if (payload === null || payload.transcript_path === undefined) {
  process.stderr.write("stop-hook.ts: payload missing transcript_path\n");
  process.exit(0);
}

const transcriptPath = payload.transcript_path;
const rawTranscript = tryRead(`read transcript ${transcriptPath}`, () =>
  readFileSync(transcriptPath, "utf8"),
);
if (rawTranscript === null) { process.exit(0); }

const ENTRIES: TranscriptEntry[] = [];
for (const line of rawTranscript.split("\n")) {
  if (line.trim() === "") { continue; }
  const entry = parseTranscriptEntry(line);
  if (entry !== null) { ENTRIES.push(entry); }
}

const ASSISTANTS = ENTRIES.filter((entry) => entry.type === "assistant");
const lastAssistant = ASSISTANTS.at(-1) ?? null;

const isStopFailure = payload.hook_event_name === "StopFailure";
const stopReason = lastAssistant?.message?.stop_reason;

if (!isStopFailure && stopReason !== "end_turn") {
  // The model hasn't completed its work — runtime is between turns, or
  // truncated, or otherwise interrupted. Ask Claude Code to resume; do
  // not write the sentinel.
  const decision = {
    decision: "block",
    reason: `last assistant stop_reason is ${stopReason ?? "(missing)"}, not end_turn — main agent is not done`,
  };
  process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

// Join the `text` blocks of one assistant entry; non-array content (a plain
// string, or none) yields "".
const assistantText = (entry: TranscriptEntry): string => {
  const content = entry.message?.content;
  const blocks: readonly unknown[] = Array.isArray(content) ? content : [];
  return blocks.filter(isTextBlock).map((block) => block.text).join("\n");
};

// Capture the MOST RECENT assistant entry that carries a verdict line, not
// blindly the last one — models routinely declare their verdict and then keep
// going, and the trailing verdict-less message would otherwise clobber it.
// Fall back to the last assistant entry when none carries a verdict, so a
// genuine no-verdict stop still flows into the orchestrator's single reprompt.
//
// Newest verdict wins. A later turn that *reverses* an earlier verdict with
// prose alone (no new VERDICT line) does NOT un-capture it — but that requires
// violating the "verdict is the terminal line" contract (implementation.md),
// and the right reversal is to emit the opposing VERDICT line, which this scan
// then honours as the newest. We accept the prose-only-reversal corner rather
// than reason about which trailing prose negates a prior verdict.
const verdictBearing = ASSISTANTS.findLast((entry) => containsVerdictLine(assistantText(entry)));
const captured = verdictBearing ?? lastAssistant;

// PID-suffixed tmp path — two overlapping Stop hook invocations (possible if
// Claude Code ever issues a Stop and a StopFailure back-to-back) won't race
// on the same tmp file. Final rename remains atomic on POSIX.
const tmp = `${sentinel}.${process.pid}.tmp`;
writeFileSync(tmp, captured === null ? "" : assistantText(captured));
renameSync(tmp, sentinel);
