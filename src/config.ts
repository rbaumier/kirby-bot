/**
 * Config.ts — every tunable constant for the AFK orchestrator, in one place.
 *
 * No logic beyond the standard library — only the dials.
 * Anything a future operator might want to change lives here.
 */
import { homedir } from "node:os";
import { join } from "node:path";

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
export const PHASES = ["run_impl", "review", "evaluate", "fix", "run_dogfood"] as const;

/** One of the five session-driven pipeline phases. */
export type Phase = (typeof PHASES)[number];

/**
 * Per-phase wall-clock cap, in minutes.
 *
 * The 4-hour per-issue budget (below) is the overall bound. These caps are the
 * *secondary* guard: they stop a single hung phase from silently eating the
 * whole budget. `run_impl` carries by far the largest cap — implementation is
 * the heavy phase and a hard issue can legitimately run for hours — while the
 * review/evaluate/fix/dogfood loop stays tight. Their sum (300) deliberately
 * exceeds the budget, so a healthy run never reaches every cap.
 */
export const PHASE_CAP_MINUTES: Record<Phase, number> = {
  run_impl: 180,
  review: 35,
  evaluate: 30,
  fix: 30,
  run_dogfood: 25,
};

/** Total wall-clock an issue may take, from `run_impl` through `run_dogfood`. */
export const ISSUE_BUDGET_MS = 240 * 60 * 1000;

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
export const MAX_FIX_CYCLES = 10;

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
