/**
 * Config.ts — every tunable constant for the AFK orchestrator, in one place.
 *
 * No logic beyond the standard library — only the dials.
 * Anything a future operator might want to change lives here.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentModel } from "./review/agents";

/** The GitLab issue labels the orchestrator reads and writes. */
export const LABELS = {
  /** An issue queued for the orchestrator to pick up. */
  readyForAgent: "ready-for-agent",
  /** An issue the orchestrator has claimed and is actively working. */
  pickedByAgent: "picked-by-agent",
  /** An issue the orchestrator gave up on — it needs a human. */
  failedByAgent: "failed-by-agent",
} as const;

/** The five pipeline phases — each runs as a fresh `claude` tmux session. */
export const PHASES = ["implementation", "review", "evaluate", "fix", "qa"] as const;

/** One of the five session-driven pipeline phases. */
export type Phase = (typeof PHASES)[number];

/**
 * Claude tier each phase runs on.
 *
 * Implementation, evaluate and fix are creative or judgment-heavy and stay on
 * Sonnet. The review-phase orchestrator session just spawns the per-agent
 * fan-out and aggregates JSON envelopes — that does not need Sonnet (the
 * fan-out agents pick their own model from {@link AGENTS_DATA}). The qa phase
 * orchestrates dogfood-persona subagents that do the real work in their own
 * sessions, so the qa orchestrator runs on Haiku.
 *
 * Changing a value here propagates to every phase session without touching
 * `runPhaseSession` — the model is no longer hard-coded.
 */
export const PHASE_MODELS: Record<Phase, AgentModel> = {
  implementation: "sonnet",
  review: "haiku",
  evaluate: "sonnet",
  fix: "sonnet",
  qa: "haiku",
};

/**
 * Per-phase wall-clock cap, in minutes.
 *
 * The 4-hour per-issue budget (below) is the overall bound. These caps are the
 * *secondary* guard: they stop a single hung phase from silently eating the
 * whole budget. `implementation` carries by far the largest cap — implementation is
 * the heavy phase and a hard issue can legitimately run for hours — while the
 * review/evaluate/fix/qa loop stays tight. Their sum (300) deliberately
 * exceeds the budget, so a healthy run never reaches every cap.
 */
export const PHASE_CAP_MINUTES: Record<Phase, number> = {
  implementation: 180,
  review: 35,
  evaluate: 30,
  fix: 30,
  qa: 25,
};

/** Total wall-clock an issue may take, from `implementation` through `qa`. */
export const ISSUE_BUDGET_MS = 240 * 60 * 1000;

/**
 * How long a `picked-by-agent` claim may sit untouched before the startup
 * sweep treats it as stale and returns the issue to the queue (#35).
 *
 * The signal is the issue's `updated_at`, which a run only bumps at claim time
 * (the phases work the MR, not the issue) — so it is the claim's age, not a
 * heartbeat. A healthy run can therefore carry a claim as old as the whole
 * per-issue budget. The threshold is `budget + margin` so a second instance
 * starting just as a sibling run finishes near its budget can never reap a
 * still-live claim (and `git worktree remove --force` its live worktree). The
 * margin also absorbs clock skew between the local host and GitLab.
 */
export const STALE_CLAIM_MS = ISSUE_BUDGET_MS + 30 * 60 * 1000;

/** How often the orchestrator polls a phase's sentinel file. */
export const SENTINEL_POLL_MS = 5000;

/**
 * Maximum number of `claude` tmux sessions to run concurrently during the
 * review fan-out. Each agent runs in its own session; the cap exists to
 * bound API pressure and local CPU contention if a fan-out grows large.
 */
export const MAX_CONCURRENT_AGENTS = 20;

/**
 * Hard ceiling on any single shell-out (git, glab, jq, tmux).
 * A hung command must not freeze the orchestrator.
 * Past this duration, the command is abandoned.
 */
export const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/** The most review→fix cycles allowed before the issue is failed for a human. */
export const MAX_FIX_CYCLES = 2;

/**
 * Max attempts (initial + retries) the review router gets to emit a parseable
 * agents-routing JSON before the review phase fails.
 *
 * The router runs Haiku, which occasionally emits a non-string `name`, a nested
 * object, or other shape glitch the Effect Schema decoder rejects. A single
 * retry resolves the bulk of these without burning meaningful budget — one
 * attempt is ~60-90s, the review phase cap is {@link PHASE_CAP_MINUTES.review}
 * minutes. A third attempt is rejected by design: if the LLM emits a malformed
 * envelope twice in a row, the issue is no longer a transient glitch and
 * deserves human triage.
 */
export const MAX_ROUTER_ATTEMPTS = 2;

/**
 * Hard byte-cap on each per-agent diff slice handed to a fan-out reviewer.
 *
 * A run-away diff (mass refactor, large generated file, lockfile dropped into
 * a slice by mistake) explodes prompt size → cache-creation cost → token bill.
 * Truncating at this cap is a pure cost guard: the reviewer sees the first
 * {@link MAX_DIFF_SLICE_BYTES} bytes of its scoped diff plus a
 * `[truncated, N bytes omitted]` marker, and still gets to flag what it sees.
 *
 * 40 KB ≈ 10 K input tokens — large enough to host most real diffs after the
 * router's per-file scoping, small enough to bound the worst case.
 */
export const MAX_DIFF_SLICE_BYTES = 40_000;

/** Where per-issue git worktrees live — one subdirectory per repository. */
export const WORKTREES_DIR = join(homedir(), ".afk-worktrees");

/** Where per-run logs live — one timestamped subdirectory per run. */
export const RUNS_DIR = join(homedir(), ".afk-runs");

/**
 * The directory holding the five phase prompt templates.
 * Resolved relative to this file (`afk/src/config.ts` →
 * `afk/assets/prompts`) via `import.meta.dirname`.
 * Works under both Bun and Node.
 */
export const PROMPTS_DIR = join(import.meta.dirname, "..", "assets", "prompts");

/**
 * The directory holding helper scripts (`mr-discussion.ts`, etc.) that
 * the phase prompts invoke via `bun {scripts_dir}/<script>.ts`.
 * Resolved relative to this file the same way as {@link PROMPTS_DIR}.
 */
export const SCRIPTS_DIR = join(import.meta.dirname, "..", "scripts");
