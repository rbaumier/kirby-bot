/**
 * Stats/pricing.ts — Anthropic Claude API pricing constants (USD per 1M tokens).
 *
 * Used by analytics rollups to translate token counts → dollars. Cache-write
 * tokens carry a multiplier (1.25× for 5-min TTL, 2× for 1-hour TTL); cache
 * reads are billed at 10% of the base input rate.
 *
 * Update when Anthropic updates pricing. Values are the per-model list price
 * for the `claude-<family>-X-X` aliases the CLI accepts. Opus 4.7 / Sonnet 4.6
 * / Haiku 4.5 are what kirby-bot currently spawns.
 */
export type ModelTier = "opus" | "sonnet" | "haiku";

/** USD per 1M tokens, list price. */
export type ModelPrice = {
  readonly input: number;
  readonly output: number;
};

/** Source: anthropic.com/pricing, 2026-05. */
export const MODEL_PRICES: Record<ModelTier, ModelPrice> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

/** Cache-write surcharges: input × this multiplier. */
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;

/** Cache reads: input × this multiplier. */
export const CACHE_READ_MULT = 0.1;

/**
 * Best-effort: map a Claude model id (as found in session transcripts) to a
 * pricing tier. Anthropic's ids look like `claude-opus-4-7`, `claude-sonnet-4-6`,
 * `claude-haiku-4-5-20251001` — we match by substring. Returns `null` when the
 * id is unrecognised (the caller should skip that record rather than guess).
 */
export const modelTier = (modelId: string): ModelTier | null => {
  if (modelId.includes("opus")) { return "opus"; }
  if (modelId.includes("sonnet")) { return "sonnet"; }
  if (modelId.includes("haiku")) { return "haiku"; }
  return null;
};

export type UsageRecord = {
  readonly tier: ModelTier;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreation5mTokens: number;
  readonly cacheCreation1hTokens: number;
  readonly cacheReadTokens: number;
};

/** Compute USD cost for one usage record. */
export const usageCostUsd = (input: UsageRecord): number => {
  const price = MODEL_PRICES[input.tier];
  const per = (tokens: number, ratePerMtok: number): number => (tokens * ratePerMtok) / 1_000_000;
  return (
    per(input.inputTokens, price.input) +
    per(input.outputTokens, price.output) +
    per(input.cacheCreation5mTokens, price.input * CACHE_WRITE_5M_MULT) +
    per(input.cacheCreation1hTokens, price.input * CACHE_WRITE_1H_MULT) +
    per(input.cacheReadTokens, price.input * CACHE_READ_MULT)
  );
};
