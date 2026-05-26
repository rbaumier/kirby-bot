#!/usr/bin/env bun
/**
 * Stop-hook.ts — Claude Code Stop-hook handler for kirby-bot phase sessions.
 *
 * Reads the Stop payload on stdin, walks the transcript JSONL pointed to by
 * `.transcript_path`, finds the LAST assistant entry, and routes on its
 * `stop_reason`:
 *
 *  - `"end_turn"` → the model genuinely finished. Extract the message text
 *    (joined across `text` blocks) and write it atomically to the sentinel.
 *
 *  - anything else (`"tool_use"`, `"max_tokens"`, missing, …) AND this is a
 *    `Stop` (not `StopFailure`) → the runtime is between turns but the model
 *    hasn't completed. Emit `{"decision":"block","reason":"…"}` on stdout to
 *    ask Claude Code to resume the agent loop, and leave the sentinel
 *    untouched so the orchestrator keeps polling.
 *
 *  - `StopFailure` → write whatever last assistant text exists. Blocking a
 *    failure makes no sense.
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

const sentinel = process.argv[2];
if (sentinel === undefined) {
  process.stderr.write("stop-hook.ts: missing sentinel path argument\n");
  process.exit(0);
}

type StopPayload = {
  readonly transcript_path?: string;
  readonly hook_event_name?: string;
};

type ContentBlock = {
  readonly type?: string;
  readonly text?: string;
};

type TranscriptEntry = {
  readonly type?: string;
  readonly message?: {
    readonly content?: unknown;
    readonly stop_reason?: string;
  };
};

const tryRead = (label: string, fn: () => string): string | null => {
  try {
    return fn();
  } catch (cause) {
    process.stderr.write(`stop-hook.ts: ${label} failed: ${String(cause)}\n`);
    return null;
  }
};

const tryParse = <T>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const rawPayload = tryRead("read stdin", () => readFileSync(0, "utf8"));
if (rawPayload === null) process.exit(0);

const payload = tryParse<StopPayload>(rawPayload);
if (payload === null || payload.transcript_path === undefined) {
  process.stderr.write("stop-hook.ts: payload missing transcript_path\n");
  process.exit(0);
}

const transcriptPath = payload.transcript_path;
const rawTranscript = tryRead(`read transcript ${transcriptPath}`, () =>
  readFileSync(transcriptPath, "utf8"),
);
if (rawTranscript === null) process.exit(0);

const entries: TranscriptEntry[] = [];
for (const line of rawTranscript.split("\n")) {
  if (line.trim() === "") continue;
  const entry = tryParse<TranscriptEntry>(line);
  if (entry !== null) entries.push(entry);
}

let lastAssistant: TranscriptEntry | null = null;
for (let i = entries.length - 1; i >= 0; i--) {
  if (entries[i]?.type === "assistant") {
    lastAssistant = entries[i] ?? null;
    break;
  }
}

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

const rawContent = lastAssistant?.message?.content;
const blocks: ReadonlyArray<ContentBlock> = Array.isArray(rawContent) ? (rawContent as ContentBlock[]) : [];

const textPieces: string[] = [];
for (const block of blocks) {
  if (block.type === "text" && typeof block.text === "string") {
    textPieces.push(block.text);
  }
}

// PID-suffixed tmp path — two overlapping Stop hook invocations (possible if
// Claude Code ever issues a Stop and a StopFailure back-to-back) won't race
// on the same tmp file. Final rename remains atomic on POSIX.
const tmp = `${sentinel}.${process.pid}.tmp`;
writeFileSync(tmp, textPieces.join("\n"));
renameSync(tmp, sentinel);
