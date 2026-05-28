/**
 * Stats/transcripts.ts — parse a Claude Code session JSONL transcript into
 * the small set of stats kirby-bot's analytics report needs.
 *
 * Each session = one JSONL file under `~/.claude/projects/<sanitized-cwd>/`.
 * Lines are JSON objects with `type` ∈ {mode, user, assistant, system, …};
 * the two we care about are `assistant` (carries `message.usage` + tool_use
 * blocks) and `user` (carries `tool_result` blocks). Tool-use → tool-result
 * pairing on `tool_use_id` gives per-call wall-clock.
 *
 * Designed to be tolerant: a torn or malformed line is skipped, never throws.
 */
import { readFile } from "node:fs/promises";
import { modelTier, usageCostUsd, type ModelTier } from "./pricing";

/** Aggregate per-model usage over a single transcript. */
export type TranscriptUsage = {
  readonly tier: ModelTier;
  readonly model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
};

/** One tool-use call observed in the transcript, with its wall-clock. */
export type ToolCallSpan = {
  readonly id: string;
  readonly name: string;
  readonly subagentType: string | null;
  readonly startMs: number;
  readonly endMs: number | null;
};

/** A whole transcript summarized. */
export type TranscriptSummary = {
  readonly path: string;
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  /** Per-model accumulators. */
  readonly perModel: readonly TranscriptUsage[];
  /** Pairs of (tool_use, tool_result) joined on `tool_use_id`. */
  readonly toolCalls: readonly ToolCallSpan[];
  /** Total USD across every model. */
  readonly costUsd: number;
};

const tsMs = (v: unknown): number | null => {
  if (typeof v !== "string") { return null; }
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

const numOr0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Public for testing. */
export const summarizeTranscriptText = (path: string, text: string): TranscriptSummary => {
  const perModel = new Map<string, TranscriptUsage>();
  const toolStart = new Map<string, { name: string; subagentType: string | null; startMs: number }>();
  const toolEnd = new Map<string, number>();
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  const recordTs = (ts: number | null): void => {
    if (ts === null) { return; }
    if (firstTs === null || ts < firstTs) { firstTs = ts; }
    if (lastTs === null || ts > lastTs) { lastTs = ts; }
  };

  for (const line of text.split("\n")) {
    if (line === "") { continue; }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.sessionId === "string" && sessionId === null) { sessionId = obj.sessionId; }
    if (typeof obj.cwd === "string" && cwd === null) { cwd = obj.cwd; }
    if (typeof obj.gitBranch === "string" && gitBranch === null) { gitBranch = obj.gitBranch; }
    const ts = tsMs(obj.timestamp);
    recordTs(ts);

    if (obj.type === "assistant") {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg === undefined) { continue; }
      const model = typeof msg.model === "string" ? msg.model : "";
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (model !== "" && usage !== undefined) {
        const tier = modelTier(model);
        if (tier !== null) {
          const key = model;
          let acc = perModel.get(key);
          if (acc === undefined) {
            acc = {
              tier,
              model,
              inputTokens: 0,
              outputTokens: 0,
              cacheCreation5mTokens: 0,
              cacheCreation1hTokens: 0,
              cacheReadTokens: 0,
            };
            perModel.set(key, acc);
          }
          acc.inputTokens += numOr0(usage.input_tokens);
          acc.outputTokens += numOr0(usage.output_tokens);
          acc.cacheReadTokens += numOr0(usage.cache_read_input_tokens);
          const cc = usage.cache_creation as Record<string, unknown> | undefined;
          if (cc !== undefined) {
            acc.cacheCreation5mTokens += numOr0(cc.ephemeral_5m_input_tokens);
            acc.cacheCreation1hTokens += numOr0(cc.ephemeral_1h_input_tokens);
          } else {
            // Older transcripts only emit the flat `cache_creation_input_tokens`;
            // attribute it to the 5m bucket so it still gets priced.
            acc.cacheCreation5mTokens += numOr0(usage.cache_creation_input_tokens);
          }
        }
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const raw of content) {
        const c = raw as Record<string, unknown>;
        if (c.type !== "tool_use") { continue; }
        const id = typeof c.id === "string" ? c.id : "";
        const name = typeof c.name === "string" ? c.name : "";
        if (id === "" || name === "" || ts === null) { continue; }
        const input = c.input as Record<string, unknown> | undefined;
        const subagentType =
          input !== undefined && typeof input.subagent_type === "string"
            ? input.subagent_type
            : null;
        toolStart.set(id, { name, subagentType, startMs: ts });
      }
      continue;
    }

    if (obj.type === "user") {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg === undefined) { continue; }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const raw of content) {
        const c = raw as Record<string, unknown>;
        if (c.type !== "tool_result") { continue; }
        const id = typeof c.tool_use_id === "string" ? c.tool_use_id : "";
        if (id === "" || ts === null) { continue; }
        if (!toolEnd.has(id)) { toolEnd.set(id, ts); }
      }
    }
  }

  const toolCalls: ToolCallSpan[] = [];
  for (const [id, s] of toolStart) {
    toolCalls.push({
      id,
      name: s.name,
      subagentType: s.subagentType,
      startMs: s.startMs,
      endMs: toolEnd.get(id) ?? null,
    });
  }

  const perModelArr = [...perModel.values()];
  const costUsd = perModelArr.reduce((sum, u) => sum + usageCostUsd(u), 0);

  return {
    path,
    sessionId,
    cwd,
    gitBranch,
    firstTs,
    lastTs,
    perModel: perModelArr,
    toolCalls,
    costUsd,
  };
};

/** Read + summarize a transcript by path. Returns null if the file is unreadable. */
export const summarizeTranscriptFile = async (
  path: string,
): Promise<TranscriptSummary | null> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return summarizeTranscriptText(path, text);
};
