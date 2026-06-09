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
 *    assistant entry when none carries a verdict. If the captured text is still
 *    empty, re-read a few times first — Claude Code streams the final entry as
 *    an empty skeleton before re-appending it with content, and reading inside
 *    that window would drop a verdict the model actually emitted.
 *
 *  - anything else (`"tool_use"`, `"max_tokens"`, missing, …) AND this is a
 *    `Stop` (not `StopFailure`) → the runtime is between turns but the model
 *    hasn't completed. Emit `{"decision":"block","reason":"…"}` on stdout to
 *    ask Claude Code to resume the agent loop, and leave the sentinel
 *    untouched so the orchestrator keeps polling — EXCEPT for a degenerate
 *    loop. `tool_use` is genuine multi-step work and resumes every time (the
 *    runtime's own block cap is the backstop). But a *non*-`tool_use` reason
 *    that persists after we already blocked once — Claude Code re-fires Stop
 *    with `stop_hook_active: true` — will not progress by resuming again: it
 *    just spins to the block cap and the cap override ends the turn having
 *    written NO sentinel (the router "No response" loop, #1079 → silent
 *    `SessionTimedOut`). On that second non-`tool_use` fire we stop blocking
 *    and fall through to capture instead — recovering whatever verdict an
 *    earlier turn carried (e.g. `ROUTING_DONE`), or writing the last text so
 *    the orchestrator's single reprompt fires. Either is strictly better than
 *    looping to the cap and timing out. See the `shouldResume` guard.
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
 *        `hook_event_name`. Optional: `stop_hook_active` (true once Claude Code
 *        is already resuming because of a prior block — breaks the loop above).
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
  // True when Claude Code is already resuming because a previous Stop hook
  // blocked — the signal that lets us break a degenerate non-tool_use loop.
  readonly stop_hook_active: boolean;
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
      stop_hook_active: parsed.stop_hook_active === true,
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

// Join the `text` blocks of one assistant entry; non-array content (a plain
// string, or none) yields "".
const assistantText = (entry: TranscriptEntry): string => {
  const content = entry.message?.content;
  const blocks: readonly unknown[] = Array.isArray(content) ? content : [];
  return blocks.filter(isTextBlock).map((block) => block.text).join("\n");
};

// Read the transcript and keep its assistant entries in document order. Returns
// null only when the file itself can't be read — the caller exits cleanly then.
const readAssistants = (): TranscriptEntry[] | null => {
  const raw = tryRead(`read transcript ${transcriptPath}`, () =>
    readFileSync(transcriptPath, "utf8"),
  );
  if (raw === null) { return null; }
  const assistants: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") { continue; }
    const entry = parseTranscriptEntry(line);
    if (entry !== null && entry.type === "assistant") { assistants.push(entry); }
  }
  return assistants;
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
const capturedText = (assistants: readonly TranscriptEntry[]): string => {
  const captured =
    assistants.findLast((entry) => containsVerdictLine(assistantText(entry))) ??
    assistants.at(-1);
  return captured === undefined ? "" : assistantText(captured);
};

// Bounded re-read budget for the streaming-skeleton race below. Overridable via
// env so the test can widen the window deterministically. A non-finite or
// non-positive override falls back to the default rather than disabling the
// re-read — a mistyped knob must NOT silently re-open the #980 race.
const positiveEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const CAPTURE_RETRY_ATTEMPTS = positiveEnv("KIRBY_STOP_HOOK_RETRY_ATTEMPTS", 4);
const CAPTURE_RETRY_MS = positiveEnv("KIRBY_STOP_HOOK_RETRY_MS", 50);

const assistants = readAssistants();
if (assistants === null) { process.exit(0); }

const isStopFailure = payload.hook_event_name === "StopFailure";
const stopReason = (assistants.at(-1) ?? null)?.message?.stop_reason;

// Resume the agent loop (emit a block decision) only when doing so can actually
// progress the model toward end_turn:
//
//  - tool_use → genuine in-progress work (the canonical #29 signal). Resume
//    every time, however many continuations it takes; the runtime's block cap
//    is the backstop against a pathological tool_use spin.
//
//  - missing / max_tokens / other → resume ONCE to absorb a transient
//    (between-turns, truncated stream). But if we already blocked once for this
//    and Claude Code re-fired with stop_hook_active set, the model is stuck off
//    end_turn without being mid-tool — resuming again only spins to the cap and
//    writes no sentinel (#1079). Fall through to capture instead.
// tool_use can always reach end_turn by continuing; a non-tool_use reason can
// too, but only on its FIRST fire — once we've already blocked for it (Claude
// Code re-fires with stop_hook_active set) resuming again only spins to the
// cap. Named so the grouping isn't silently load-bearing precedence.
const canProgressByResuming = stopReason === "tool_use" || !payload.stop_hook_active;
const shouldResume = !isStopFailure && stopReason !== "end_turn" && canProgressByResuming;

if (shouldResume) {
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

// The turn ended, so we WILL write the sentinel. But Claude Code streams the
// final assistant message into the transcript in two steps: an empty skeleton
// line first, then the SAME message.id re-appended with the streamed text
// (verdict included). A Stop hook that reads inside that window captures the
// empty skeleton, writes an empty sentinel, and the orchestrator reads it as
// NoVerdict — reprompting and discarding a verdict the model actually emitted.
// Re-read until the captured entry has content, the way loadAndPastePrompt
// waits for an async paste to land (#30). A genuinely empty final turn just
// exhausts the bounded budget and still writes "" — that case is rare and the
// 200ms default is negligible against the 5s sentinel-poll cadence.
let text = capturedText(assistants);
for (let attempt = 0; text === "" && attempt < CAPTURE_RETRY_ATTEMPTS; attempt++) {
  Bun.sleepSync(CAPTURE_RETRY_MS);
  const next = readAssistants();
  if (next !== null) { text = capturedText(next); }
}

// PID-suffixed tmp path — two overlapping Stop hook invocations (possible if
// Claude Code ever issues a Stop and a StopFailure back-to-back) won't race
// on the same tmp file. Final rename remains atomic on POSIX.
const tmp = `${sentinel}.${process.pid}.tmp`;
writeFileSync(tmp, text);
renameSync(tmp, sentinel);
