/**
 * Review/agents.ts — **the agent registry. Single source of truth.**
 *
 * Each row declares everything kirby-bot needs to know about one review agent:
 *  - `model` — Claude tier the session runs on (`haiku` / `sonnet` / `opus`).
 *  - `description` — one-line summary fed verbatim to the routing haiku so it
 *    can decide whether the agent is worth spawning for a given diff.
 *  - `prompt` — which template to render + the per-agent substitutions.
 *
 * Spawn decisions are made at runtime by `./router.ts` (a one-shot haiku call
 * that reads the diff + this registry's `description` column and returns the
 * subset of agents to spawn, along with each agent's scoped file list). There
 * is intentionally no static `triggers` or `alwaysIn` field — every previous
 * heuristic (path substring, extension, import substring) is replaced by the
 * router's semantic judgment.
 *
 * ## CRUD playbook
 *
 *  - **Add an agent.** Insert one row with a clear `description`. The router
 *    learns from the description; no other file needs to change.
 *  - **Remove an agent.** Delete the row. `AgentName` widens via
 *    `keyof typeof AGENTS_DATA`; the compiler flags every stale reference.
 *  - **Re-tier an agent's model.** Change one field.
 *  - **Reword for the router.** Edit `description` — the router's behavior
 *    follows the description verbatim, so keep it short, action-oriented,
 *    and trigger-revealing ("for files that …", "when you see …").
 */

/** The three Claude model aliases the CLI accepts as `--model <alias>`. */
export type AgentModel = "haiku" | "sonnet" | "opus" | "fable";

/** Prompt spec — drives `renderAgentPrompt`. */
export type PromptSpec =
  | { readonly kind: "self-contained"; readonly templateFile: string }
  | {
    readonly kind: "line-anchored";
    /** Path within `assets/code-review-templates/` for the role body. */
    readonly roleFile: string;
    /** Substituted into `{skill_name}` (skill-agent.md). */
    readonly skillName?: string;
    /** Substituted into `{skill_names}` (skill-agent-pair.md). Joined by `, `. */
    readonly skillNames?: readonly string[];
    /** Substituted into `{subsystem_name}` (subsystem-agent.md). */
    readonly subsystemName?: string;
    /** Substituted into `{failure_modes}` (subsystem-agent.md). */
    readonly failureModes?: string;
  };

/**
 * Deterministic spawn predicate — hard-gates the agent before the router's
 * semantic judgment is applied. The gate is checked against `ChangedFile`
 * metadata already extracted by `detect.ts`; no new file walk is needed.
 *
 * - `{ ext }` — at least one changed file must have `ext === <value>`.
 * - `{ import }` — at least one changed file must have an import entry that
 *   equals `<value>` or starts with `<value>/` (covers scoped packages and
 *   sub-path imports such as `@tanstack/react-query` or `drizzle-orm/pg-core`).
 */
export type AgentGate = { readonly ext: string } | { readonly import: string };

/** One agent's complete declaration — the only place to CRUD an agent. */
export type AgentEntry = {
  readonly model: AgentModel;
  /**
   * One-line summary of the agent's job. Fed to the routing haiku verbatim;
   * also useful for humans scanning the registry. Action-oriented, trigger-
   * revealing, ~20 words max.
   */
  readonly description: string;
  readonly prompt: PromptSpec;
  /**
   * Optional hard gate. When present, the agent is dropped from the fan-out
   * unless the gate is satisfied by the actual diff files — regardless of what
   * the router emits. Agents without a gate are always eligible.
   */
  readonly gate?: AgentGate;
};

// ──────────────────────────────────────────────────────────────────────────
// THE registry. Add / remove / edit rows here.
// ──────────────────────────────────────────────────────────────────────────

const AGENTS_DATA = {
  // ─── Single-agent review (replaces the fleet) ──────────────────────────
  // ONE fable agent carrying every compressed skill + role-body. The fan-out
  // spawns this alone — no router, no per-agent scoping (see runFanOutPhase).
  // Line-anchored so its JSON envelope is parsed by `aggregateFindings`; the
  // role body is the whole multi-pass review prompt, wrapped by the scaffold.
  "single-fable": {
    model: "fable",
    description:
      "Single-agent full review: every fleet skill + role-body compressed inline, run in one shot over the full diff.",
    prompt: { kind: "line-anchored", roleFile: "single-agent-review-fable.md" },
  },
  // ─── Funnel & generalists ──────────────────────────────────────────────
  funnel: {
    model: "haiku",
    description: "Question the need + reduce scope: does this code need to exist, and is the perimeter the smallest possible? Spawn on every diff.",
    prompt: { kind: "self-contained", templateFile: "funnel.md" },
  },
  "occam-razor": {
    model: "haiku",
    description: "Mechanically walks call sites of every exported symbol; flags 0/1-caller wrappers and derivable defaults. Spawn on every diff.",
    prompt: { kind: "line-anchored", roleFile: "occam-razor.md" },
  },
  correctness: {
    model: "sonnet",
    description: "Hunt bugs: logic errors, edge cases, off-by-ones, race conditions. Spawn on every diff.",
    prompt: { kind: "line-anchored", roleFile: "correctness.md" },
  },
  tests: {
    model: "sonnet",
    description: "Review test coverage and quality: missing cases, tautological assertions, brittle mocks. Spawn on every diff that touches code.",
    prompt: { kind: "line-anchored", roleFile: "tests-agent.md" },
  },
  simplify: {
    model: "haiku",
    description: "Spot accidental complexity, dead branches, premature abstractions. Spawn on every diff.",
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "simplify" },
  },
  "matt-improve-codebase-architecture": {
    model: "haiku",
    description: "Architecture pass: module boundaries, layering, dependency direction. Spawn for non-trivial diffs (multi-file or new module).",
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "matt-improve-codebase-architecture",
    },
  },
  "type-design": {
    model: "haiku",
    description:
      "Type & data-model design: make illegal states unrepresentable — discriminated unions over flag/optional bags, branded ids, parse-don't-validate, switch exhaustiveness. Spawn when the diff adds or changes data models, type definitions, function signatures, or domain types.",
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "coding-standards:design" },
  },
  // "matt-review": {
  //   model: "sonnet",
  //   description: "Senior-eng prose review: what's the missing piece, what's the wrong abstraction. Spawn for non-trivial diffs.",
  //   prompt: { kind: "self-contained", templateFile: "matt-review.md" },
  // },
  "thermo-nuclear": {
    model: "haiku",
    description: "Aggressive structural pass: what would a skeptical senior tear apart — missing shared abstractions, copy-pasted structure across files, sprawling files. Spawn on every diff.",
    prompt: { kind: "self-contained", templateFile: "thermo-nuclear-review.md" },
  },
  "security-defensive": {
    model: "haiku",
    description: "OWASP-style security review: injection, auth, secrets, deserialization. Spawn when any trust boundary is crossed.",
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "security-defensive",
    },
  },
  // "general-opus": {
  //   model: "opus",
  //   description: "Opus generalist pass: catches what the cheaper models miss. Spawn for high-stakes or large diffs only.",
  //   prompt: { kind: "line-anchored", roleFile: "correctness.md" },
  // },

  // ─── CLAUDE.md ─────────────────────────────────────────────────────────
  "claude-md-compliance": {
    model: "haiku",
    description: "Walk the diff for violations of the repo's CLAUDE.md rules. Spawn when CLAUDE.md exists in the repo.",
    prompt: { kind: "line-anchored", roleFile: "claude-md-compliance.md" },
  },
  "claude-md-materiality": {
    model: "haiku",
    description: "Flag when the diff teaches something CLAUDE.md / AGENTS.md should mention but doesn't. Spawn when the diff is material but CLAUDE.md is unchanged.",
    prompt: { kind: "self-contained", templateFile: "materiality.md" },
  },

  // ─── Language by extension ─────────────────────────────────────────────
  "language-rust": {
    model: "sonnet",
    description: "Rust-specific review: ownership, lifetimes, unsafe, error types. Spawn for .rs files.",
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "language-rust" },
    gate: { ext: "rs" },
  },
  // "language-swift": {
  //   model: "sonnet",
  //   description: "Swift-specific review: optionals, value types, concurrency. Spawn for .swift files.",
  //   prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "language-swift" },
  // },
  // vue: {
  //   model: "haiku",
  //   description: "Vue-specific review: composition API, reactivity, lifecycle. Spawn for .vue files.",
  //   prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "vue" },
  // },

  // ─── Skill by import ───────────────────────────────────────────────────
  "drizzle-orm": {
    model: "haiku",
    description: "Drizzle ORM review: schema shape, query correctness, migration safety. Spawn when files import drizzle-orm/drizzle-kit.",
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "drizzle-orm" },
    gate: { import: "drizzle-orm" },
  },
  tanstack: {
    model: "haiku",
    description: "TanStack review (Query + Start): query keys, invalidation, suspense; Start routing, loaders, server fns. Spawn when files import @tanstack/react-query/@tanstack/query-core/@tanstack/start/@tanstack/react-start.",
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent-pair.md",
      skillNames: ["tanstack-query", "tanstack-start-best-practices"],
    },
    gate: { import: "@tanstack" },
  },
  "code-hygiene": {
    model: "haiku",
    description: "Coding-standards hygiene + error-handling review: dead code, naming, and error path discipline. Spawn on every non-trivial diff.",
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent-pair.md",
      skillNames: ["coding-standards:errors", "coding-standards:hygiene"],
    },
  },

  // ─── Skill by import — commented experiments ──────────────────────────
  // i18n: {
  //   model: "haiku",
  //   description: "i18n review: missing keys, locale-specific formatting bugs. Spawn when files import i18next/next-intl/@formatjs/react-i18next.",
  //   prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "i18n" },
  // },
  // tailwind: {
  //   model: "haiku",
  //   description: "Tailwind utility review: class consistency, no inline overrides. Spawn when files use tw-merge/clsx or have tailwind class strings.",
  //   prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "tailwind" },
  // },
  // "ui-animations": {
  //   model: "haiku",
  //   description: "Animation review: reduced-motion compliance, perf. Spawn when files import framer-motion/motion/react/@react-spring.",
  //   prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "ui-animations" },
  // },
  // shadcn: {
  //   model: "haiku",
  //   description: "shadcn/ui review: component composition, accessibility. Spawn when files import @radix-ui or use shadcn components.",
  //   prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "shadcn" },
  // },
  docker: {
    model: "haiku",
    description: "Dockerfile / compose review: layer order, secrets, multi-stage. Spawn when Dockerfile/compose files or dockerode imports change.",
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "docker" },
  },
  kubernetes: {
    model: "haiku",
    description: "Kubernetes manifest review: resource limits, secrets, RBAC. Spawn when k8s YAML or @kubernetes/client-node imports change.",
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "kubernetes" },
  },
  zod: {
    model: "haiku",
    description: "Zod schema review: branding, refinements, error shaping. Spawn when files import zod.",
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "zod" },
    gate: { import: "zod" },
  },

  // ─── Surface (UI / API) ────────────────────────────────────────────────
  "ui-quality": {
    model: "haiku",
    description: "UI quality (visual / UX + interaction polish): layout, accessibility, copy, loading + error states, transitions. Spawn for any user-facing UI component (React/Vue/Svelte components, CSS/design tokens).",
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent-pair.md",
      skillNames: ["ui-ux", "make-interfaces-feel-better"],
    },
  },
  // "web-performance": {
  //   model: "sonnet",
  //   description: "Web-perf review: bundle bloat, render perf, hydration, INP. Spawn for changes affecting client-side runtime.",
  //   prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "web-performance" },
  // },
  "api-design": {
    model: "sonnet",
    description: "HTTP API review: route shape, status codes, request validation, idempotency. Spawn for HTTP route handlers (express/fastify/hono/@trpc/server/next route exports).",
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "api-design" },
  },

  // ─── Subsystem (high-stakes — all sonnet) ──────────────────────────────
  // "billing-subsystem": {
  //   model: "sonnet",
  //   description: "Billing-specific review framed for money flows. Spawn when the diff touches charging, refunds, invoices, subscriptions, or imports stripe/paddle/lemonsqueezy.",
  //   prompt: {
  //     kind: "line-anchored",
  //     roleFile: "subsystem-agent.md",
  //     subsystemName: "billing",
  //     failureModes:
  //       "idempotency keys reused/missing; Decimal vs float for money; invoice numbering races; refund double-apply; double-charge on retry; currency mismatch",
  //   },
  // },
  // "auth-subsystem": {
  //   model: "sonnet",
  //   description: "Auth-specific review framed for session/token/MFA paths. Spawn when the diff touches login/logout, session handling, JWT/bcrypt/argon2, or auth libraries (better-auth/next-auth/lucia/clerk).",
  //   prompt: {
  //     kind: "line-anchored",
  //     roleFile: "subsystem-agent.md",
  //     subsystemName: "auth",
  //     failureModes:
  //       "session expiry edges; token refresh races; password reset replay; MFA bypass; OAuth state CSRF; downgrade to weaker auth path",
  //   },
  // },
  // "schema-migration-subsystem": {
  //   model: "sonnet",
  //   description: "Schema-migration review framed for data-loss / locking risks. Spawn when the diff touches /migrations/ or contains alterTable/dropColumn/addColumn.",
  //   prompt: {
  //     kind: "line-anchored",
  //     roleFile: "subsystem-agent.md",
  //     subsystemName: "schema-migration",
  //     failureModes:
  //       "data loss on DROP; default backfill on a huge table races writes; FK/index drift; rollback impossible without data loss; long-lock blocking",
  //   },
  // },
  // "webhook-subsystem": {
  //   model: "sonnet",
  //   description: "Webhook-specific review framed for signature / replay protection. Spawn when the diff touches webhook handlers, HMAC verification, or createHmac/timingSafeEqual.",
  //   prompt: {
  //     kind: "line-anchored",
  //     roleFile: "subsystem-agent.md",
  //     subsystemName: "webhook",
  //     failureModes:
  //       "signature verification not timing-safe; missing replay protection; idempotency by event-id only (payload tamper); HMAC algorithm confusion",
  //   },
  // },
  // "rbac-subsystem": {
  //   model: "sonnet",
  //   description: "RBAC / authorization review framed for privilege boundaries. Spawn when the diff touches policies, permissions, RBAC, hasPermission/canAccess/authorize calls, or @casl imports.",
  //   prompt: {
  //     kind: "line-anchored",
  //     roleFile: "subsystem-agent.md",
  //     subsystemName: "rbac",
  //     failureModes:
  //       "policy evaluation order leaks privilege; escalation via permission union; missing scope check on a new endpoint; tenant boundary leak through caller-trusted id",
  //   },
  // },
  // "multi-tenant-subsystem": {
  //   model: "sonnet",
  //   description: "Multi-tenant review framed for tenant-id leakage / cross-tenant data. Spawn when the diff touches tenantId / organizationId / workspaceId paths or queries.",
  //   prompt: {
  //     kind: "line-anchored",
  //     roleFile: "subsystem-agent.md",
  //     subsystemName: "multi-tenant",
  //     failureModes:
  //       "row-level scope missing; tenant-id leakage in cache/logs; cross-tenant pagination cursor; default to current tenant when none given",
  //   },
  // },
  // "cron-subsystem": {
  //   model: "sonnet",
  //   description: "Cron / background-job review framed for idempotency + overlap. Spawn when the diff touches /cron/, /jobs/, /workers/, or imports bullmq/bull/agenda/trigger.dev/inngest.",
  //   prompt: {
  //     kind: "line-anchored",
  //     roleFile: "subsystem-agent.md",
  //     subsystemName: "cron",
  //     failureModes:
  //       "lock not acquired; overlapping runs; partial-failure rerun without idempotency; dead-letter queue not configured; clock-skew misfire",
  //   },
  // },
} as const satisfies Record<string, AgentEntry>;

/**
 * The agent registry — re-exported as a widened map so consumers see one
 * uniform `AgentEntry` shape per row (the `as const` keeps the keys narrow
 * but would otherwise narrow each value to its literal `prompt.kind` etc.,
 * which makes property access on the union painful).
 */
export const AGENTS = AGENTS_DATA as Readonly<Record<keyof typeof AGENTS_DATA, AgentEntry>>;

/** The canonical agent name set — derived from {@link AGENTS_DATA}'s keys. */
export type AgentName = keyof typeof AGENTS_DATA;

/** Lookup helper — direct indexing also works. */
export const getAgentModel = (agent: AgentName): AgentModel => AGENTS[agent].model;

/** All agent names, stable insertion order. */
export const ALL_AGENT_NAMES = Object.keys(AGENTS_DATA) as readonly AgentName[];

/**
 * The single review agent the fan-out spawns now that the fleet is replaced
 * (feat/single-fable-review). One fable session carrying every compressed
 * skill + role-body; the other registry entries are dormant (kept for
 * reference and the router, which the review path no longer invokes).
 */
export const SINGLE_FABLE_AGENT: AgentName = "single-fable";

/** Type guard: is the string a known agent name? */
export const isAgentName = (value: string): value is AgentName => value in AGENTS_DATA;
