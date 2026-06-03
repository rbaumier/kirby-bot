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

/** The six pipeline phases — each runs as a fresh `claude` tmux session. */
export const PHASES = ["plan", "implementation", "review", "evaluate", "fix", "qa"] as const;

/** One of the six session-driven pipeline phases. */
export type Phase = (typeof PHASES)[number];

/**
 * Claude tier each single-session phase runs on.
 *
 * Plan, implementation, evaluate and fix are creative or judgment-heavy and
 * stay on Sonnet. The qa phase orchestrates dogfood-persona subagents that do
 * the real work in their own sessions, so the qa orchestrator runs on Haiku.
 *
 * `review` is deliberately absent: it has no single orchestrator session. The
 * review phase fans out one `claude` session per agent (see
 * {@link runFanOutPhase}), each picking its own tier from {@link AGENTS_DATA}
 * and escalated via {@link selectReviewModel} — there is nothing here to set.
 * The key type is `PromptablePhase` ({@link Phase} minus `review`) so the
 * absence is compiler-enforced, not a stray dead entry.
 *
 * Changing a value here propagates to every phase session without touching
 * `runPhaseSession` — the model is no longer hard-coded.
 */
export const PHASE_MODELS: Record<Exclude<Phase, "review">, AgentModel> = {
  plan: "sonnet",
  implementation: "sonnet",
  evaluate: "sonnet",
  fix: "sonnet",
  qa: "haiku",
};

/**
 * Model tiers, cheapest first. The review escalation policy composes its floor
 * with each agent's own tier through {@link maxModel} — escalation may raise a
 * cheaper agent up to the floor, never lower one already above it.
 */
const MODEL_TIER: Record<AgentModel, number> = { haiku: 0, sonnet: 1, opus: 2 };

/** The more capable of two model tiers (ties return `a`). */
export const maxModel = (a: AgentModel, b: AgentModel): AgentModel =>
  MODEL_TIER[a] >= MODEL_TIER[b] ? a : b;

/**
 * Full-diff byte threshold at which a *first-pass* review escalates to sonnet.
 *
 * The measure is the byte length of the same full diff the router consumes —
 * not a re-walked file roster. Below this, a first pass on haiku is fine and
 * cheap; above it, a haiku reviewer handed the whole diff starts to degrade
 * (the failure mode behind #52 / #39). Set at half the router's 100 KB diff
 * budget ({@link ROUTER_DIFF_MAX_BYTES}): a diff that already fills half the
 * router's window is large enough to warrant the stronger tier.
 */
export const REVIEW_ESCALATION_DIFF_BYTES = 50 * 1024;

/**
 * Pick the review model floor from the iteration and the full-diff size.
 *
 * Pure policy (unit-tested in `config.test.ts`). The first pass on a small diff
 * stays on haiku to keep cost down; we escalate to sonnet exactly where haiku
 * degrades:
 *  - any re-review (`iteration >= 1`) — the diff has churned through ≥1 fix
 *    cycle, the costliest place for a sterile haiku pass;
 *  - a first pass whose full diff exceeds {@link REVIEW_ESCALATION_DIFF_BYTES}.
 *
 * The return value is a *floor*: callers compose it with each agent's own tier
 * via {@link maxModel}, so a sonnet/opus agent is never downgraded.
 */
export const selectReviewModel = (iteration: number, diffBytes: number): AgentModel =>
  iteration >= 1 || diffBytes > REVIEW_ESCALATION_DIFF_BYTES ? "sonnet" : "haiku";

/**
 * Per-phase wall-clock cap, in minutes.
 *
 * The 4-hour per-issue budget (below) is the overall bound. These caps are the
 * *secondary* guard: they stop a single hung phase from silently eating the
 * whole budget. `implementation` carries by far the largest cap — implementation is
 * the heavy phase and a hard issue can legitimately run for hours — while the
 * plan/review/evaluate/fix/qa loop stays tight. Their sum (330) deliberately
 * exceeds the budget, so a healthy run never reaches every cap.
 *
 * `plan` carries 15: the plan gate is a cheap approach-vetting pass (a
 * lightweight plan plus one in-session reviewer subagent), not a coding phase.
 *
 * `fix` carries 45 (not 30): a multi-file fix on a large diff routinely runs
 * past 30 min, and a hard kill there discards the whole review+fix pass (#42).
 */
export const PHASE_CAP_MINUTES: Record<Phase, number> = {
  plan: 15,
  implementation: 180,
  review: 35,
  evaluate: 30,
  fix: 45,
  qa: 25,
};

/** Total wall-clock an issue may take, from `implementation` through `qa`. */
export const ISSUE_BUDGET_MS = 240 * 60 * 1000;

/**
 * How long a `picked-by-agent` claim may sit untouched before the startup
 * sweep treats it as stale and returns the issue to the queue (#35).
 *
 * Demoted to a last-ditch backstop by ADR 0004: the PID lockfile (`lockfile.ts`)
 * is now the primary liveness signal, so a crashed run's orphan is reaped in
 * seconds. This age threshold only covers a claim with no lockfile at all (e.g.
 * a crash before the first lock write, or a pre-lockfile run).
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

/**
 * Fixed back-off when a Claude usage-limit hit's reset time cannot be parsed
 * (#78). On a `null` from `parseUsageLimitReset`, the orchestrator pauses this
 * long before the next `fetch_queue` instead of spinning straight back into the
 * exhausted limit or assuming "now". One hour is conservative: short enough that
 * a recovered limit is picked up within the hour, long enough that the loop does
 * not re-hit the wall in a tight cycle. The unparseable case is also logged
 * loudly so a new dialog phrasing gets a parser case.
 */
export const USAGE_LIMIT_BACKOFF_FALLBACK_MS = 60 * 60 * 1000;

/**
 * Margin added past the parsed reset instant before the orchestrator resumes
 * (#78), absorbing clock skew between the local host and Anthropic so the next
 * session does not race the reset and re-hit the limit by a few seconds.
 */
export const USAGE_LIMIT_BACKOFF_MARGIN_MS = 2 * 60 * 1000;

/**
 * Floor on the usage-limit back-off (#78). A reset already in the past (clock
 * skew, or a capture processed after the reset) yields a non-positive sleep;
 * clamping to this small minimum makes the loop proceed effectively at once
 * rather than compute a negative or zero sleep.
 */
export const USAGE_LIMIT_BACKOFF_MIN_MS = 1000;

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
 * How many *consecutive* Stalls (a run that consumed its session/budget without
 * a verdict) an issue may accrue before it converts to a Failure (`failed-by-
 * agent`). Reset to zero on any non-Stall outcome (success, Interruption, human
 * re-queue). See ADR 0004.
 */
export const STALL_CAP = 3;

/**
 * Absolute backstop: how many times an issue may be re-picked by *any* fate
 * (Stall or Interruption) before it converts to a Failure. Bounds the
 * uncapped-Interruption tail (e.g. an issue Ctrl-C'd in `implementation` every
 * time) so no issue loops forever re-minting budget. See ADR 0004.
 */
export const REPICK_CAP = 10;

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
 * Where the cross-run interruption sidecar lives — one JSON per repository
 * (`<repo>/interruptions.json`) keyed by issue iid. Holds the consecutive-Stall
 * and total-re-pick counts that drive the {@link STALL_CAP} / {@link REPICK_CAP}
 * conversions. Mono-host; survives across runs. See ADR 0004.
 */
export const STATE_DIR = join(homedir(), ".afk-state");

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
