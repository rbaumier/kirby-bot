/**
 * Review/agent-models.ts — declarative per-agent model assignment.
 *
 * **This is the CRUD surface.** Adding, removing, or re-tiering an agent =
 * edit this map. Every other module (`fanout.ts`, `bootClaudeSession`)
 * reads from here, so no model knowledge is duplicated.
 *
 * Sourced verbatim from `~/.claude/skills/code-review/reference/agent-table.md`
 * (the upstream "Heavy vs light Skill agents" split and the explicit model
 * column). When the upstream skill changes its assignments, edit this file —
 * nothing else.
 *
 * **Why this matters.** The Claude Code CLI inherits the orchestrator's model
 * when `--model` is omitted; so a "haiku" agent silently becomes Opus when
 * the orchestrator is on Opus. Always pass `--model <id>` per session —
 * {@link bootClaudeSession} does this when {@link AGENT_MODELS} provides a
 * value for the agent.
 *
 * **Tiers** (kept aligned with the upstream skill):
 *  - `haiku` — structural / textual lifts (Funnel L1/L2, Materiality, light
 *    skill agents — most UI/lib/i18n agents).
 *  - `sonnet` — heavy reasoning (Correctness, Tests, Subsystem, heavy skill
 *    agents — security-defensive, language-*, react, frontend, …).
 *  - `opus` — the General Opus generalist pass.
 */
import type { AgentName } from "./detect-tables";

/** The three Claude model tiers the CLI accepts as `--model <alias>`. */
export type AgentModel = "haiku" | "sonnet" | "opus";

/**
 * Per-agent → model. Exhaustive over {@link AgentName} via the
 * `satisfies Record<AgentName, AgentModel>` clause below — adding an agent to
 * `AgentName` without adding a row here is a compile error.
 *
 * Order is grouped by category for readability; the runtime doesn't care.
 */
export const AGENT_MODELS = {
  // ── Funnel & generalists (always-spawn, Full tier) ──────────────────
  "funnel-l1": "haiku",
  "funnel-l2": "haiku",
  "occam-razor": "sonnet",
  correctness: "sonnet",
  tests: "sonnet",
  "matt-review": "sonnet",
  "thermo-nuclear": "sonnet",
  "matt-improve-codebase-architecture": "sonnet",
  "security-defensive": "sonnet",
  simplify: "sonnet",
  "coding-standards": "sonnet",
  "coding-standards:design": "sonnet",
  "coding-standards:errors": "sonnet",
  "coding-standards:hygiene": "sonnet",
  "coding-standards:style": "sonnet",
  "general-opus": "opus",

  // ── CLAUDE.md ────────────────────────────────────────────────────────
  "claude-md-compliance": "sonnet",
  "claude-md-materiality": "haiku",

  // ── Language by extension ────────────────────────────────────────────
  "language-typescript": "sonnet", // heavy
  "language-rust": "sonnet", // heavy
  "language-swift": "sonnet", // heavy
  vue: "haiku", // light per upstream

  // ── Skill by import — heavy ──────────────────────────────────────────
  react: "sonnet",
  database: "sonnet",
  "drizzle-orm": "sonnet",

  // ── Skill by import — light ──────────────────────────────────────────
  i18n: "haiku",
  tailwind: "haiku",
  "ui-animations": "haiku",
  shadcn: "haiku",
  "tanstack-query": "haiku",
  "tanstack-start-best-practices": "haiku",
  "better-result-adopt": "haiku",
  docker: "haiku",
  kubernetes: "haiku",
  zod: "haiku",

  // ── Surface ──────────────────────────────────────────────────────────
  "ui-ux": "haiku", // light
  "make-interfaces-feel-better": "haiku", // light
  frontend: "sonnet", // heavy
  "web-performance": "sonnet", // heavy
  "api-design": "sonnet", // heavy

  // ── Subsystem (all heavy) ────────────────────────────────────────────
  "billing-subsystem": "sonnet",
  "auth-subsystem": "sonnet",
  "schema-migration-subsystem": "sonnet",
  "webhook-subsystem": "sonnet",
  "rbac-subsystem": "sonnet",
  "multi-tenant-subsystem": "sonnet",
  "cron-subsystem": "sonnet",
} as const satisfies Record<AgentName, AgentModel>;

/** Lookup helper — `AGENT_MODELS[agent]` works directly too. */
export const getAgentModel = (agent: AgentName): AgentModel => AGENT_MODELS[agent];
