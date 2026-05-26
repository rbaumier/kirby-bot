/**
 * Review/agents.ts — **the agent registry. Single source of truth.**
 *
 * Each row in {@link AGENTS} declares everything kirby-bot needs to know about
 * one review agent:
 *  - `model` — which Claude tier the session runs on (`haiku` / `sonnet` / `opus`)
 *  - `alwaysIn` — which review tiers spawn this agent unconditionally
 *  - `triggers` — conditional spawn signals (Full tier only)
 *  - `prompt` — which template to render + the per-agent substitutions
 *
 * ## CRUD playbook
 *
 *  - **Add an agent.** Insert one row. The compile-time `satisfies` clause
 *    refuses to let you forget any required field, and `AgentName` automatically
 *    widens to include the new key.
 *  - **Remove an agent.** Delete the row. Every importer dereferences via
 *    `keyof typeof AGENTS` — the compiler flags any stale reference.
 *  - **Re-tier an agent's model.** Change one field.
 *  - **Re-route an agent's template.** Change `prompt.roleFile` / `templateFile`.
 *  - **Change when an agent fires.** Edit `alwaysIn` and / or `triggers`.
 *
 * Trigger evaluation is OR-of-fields, OR-of-needles within each field:
 *  - `extensions: ["ts","tsx"]` fires if any changed file has `ext` in the list.
 *  - `pathFragments: ["/billing/"]` fires if any changed path contains the fragment.
 *  - `imports: ["stripe"]` fires if any extracted import OR file content contains the needle.
 *  - `codePatterns: ["verifySignature"]` fires if any file content contains the needle.
 *
 * Detection logic lives in `./detect.ts`; prompt rendering in `./render-prompt.ts`;
 * per-agent diff slicing in `./diff-slices.ts`. They all read from this file.
 *
 * ## Shared trigger blocks
 *
 * Several agents fire on the same surface (e.g. ui-ux, frontend, make-interfaces-feel-better,
 * and web-performance all match the same UI surface). The constants below let each agent
 * compose a self-contained spec without duplicating the underlying signature lists.
 */

/** The three Claude model aliases the CLI accepts as `--model <alias>`. */
export type AgentModel = "haiku" | "sonnet" | "opus";

/** Review tier — drives the Lite vs Full panel split. */
export type ReviewTier = "lite" | "full";

/**
 * Conditional spawn triggers — any non-empty field whose needles match the
 * diff fires the agent. OR semantics within each field AND across fields.
 */
export type SpawnTriggers = {
  readonly extensions?: ReadonlyArray<string>;
  readonly pathFragments?: ReadonlyArray<string>;
  readonly imports?: ReadonlyArray<string>;
  readonly codePatterns?: ReadonlyArray<string>;
};

/** Prompt spec — drives `renderAgentPrompt`. */
export type PromptSpec =
  | { readonly kind: "self-contained"; readonly templateFile: string }
  | {
      readonly kind: "line-anchored";
      /** Path within `assets/code-review-templates/` for the role body. */
      readonly roleFile: string;
      /** Substituted into `{skill_name}` (skill-agent.md). */
      readonly skillName?: string;
      /** Substituted into `{subsystem_name}` (subsystem-agent.md). */
      readonly subsystemName?: string;
      /** Substituted into `{failure_modes}` (subsystem-agent.md). */
      readonly failureModes?: string;
    };

/** One agent's complete declaration — the only place to CRUD an agent. */
export type AgentEntry = {
  readonly model: AgentModel;
  readonly alwaysIn?: ReadonlyArray<ReviewTier>;
  readonly triggers?: SpawnTriggers;
  readonly prompt: PromptSpec;
};

// ──────────────────────────────────────────────────────────────────────────
// Shared trigger blocks — composed into agents below.
// ──────────────────────────────────────────────────────────────────────────

const UI_SURFACE = {
  pathFragments: ["/app/", "/pages/", "/src/routes/"],
  extensions: ["tsx", "jsx", "vue", "svelte", "astro", "mdx"],
} as const;

const DESIGN_TOKENS = {
  pathFragments: ["tokens.", "theme."],
  extensions: ["css", "scss"],
} as const;

const API_SURFACE = {
  pathFragments: [
    "/route.",
    "middleware.",
    "/server/api/",
    "/api/",
    "/routes/",
    "openapi.",
    "swagger.",
  ],
  extensions: ["graphql", "gql"],
} as const;

/** Merge surface specs into one trigger object. */
const surface = (
  ...specs: ReadonlyArray<{
    readonly pathFragments?: ReadonlyArray<string>;
    readonly extensions?: ReadonlyArray<string>;
  }>
): SpawnTriggers => ({
  pathFragments: specs.flatMap((spec) => spec.pathFragments ?? []),
  extensions: specs.flatMap((spec) => spec.extensions ?? []),
});

// ──────────────────────────────────────────────────────────────────────────
// THE registry. Add / remove / edit rows here.
// ──────────────────────────────────────────────────────────────────────────

const AGENTS_DATA = {
  // ─── Funnel & generalists ──────────────────────────────────────────────
  "funnel-l1": {
    model: "haiku",
    alwaysIn: ["lite", "full"],
    prompt: { kind: "self-contained", templateFile: "funnel-l1.md" },
  },
  "funnel-l2": {
    model: "haiku",
    alwaysIn: ["lite", "full"],
    prompt: { kind: "self-contained", templateFile: "funnel-l2.md" },
  },
  "occam-razor": {
    model: "sonnet",
    alwaysIn: ["lite", "full"],
    prompt: { kind: "line-anchored", roleFile: "occam-razor.md" },
  },
  correctness: {
    model: "sonnet",
    alwaysIn: ["lite", "full"],
    prompt: { kind: "line-anchored", roleFile: "correctness.md" },
  },
  tests: {
    model: "sonnet",
    alwaysIn: ["lite", "full"],
    prompt: { kind: "line-anchored", roleFile: "tests-agent.md" },
  },
  simplify: {
    model: "sonnet",
    alwaysIn: ["lite", "full"],
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "simplify" },
  },
  "coding-standards": {
    model: "sonnet",
    alwaysIn: ["lite", "full"],
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "coding-standards" },
  },
  "matt-improve-codebase-architecture": {
    model: "sonnet",
    alwaysIn: ["full"],
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "matt-improve-codebase-architecture",
    },
  },
  "matt-review": {
    model: "sonnet",
    alwaysIn: ["full"],
    prompt: { kind: "self-contained", templateFile: "matt-review.md" },
  },
  "thermo-nuclear": {
    model: "sonnet",
    alwaysIn: ["full"],
    prompt: { kind: "self-contained", templateFile: "thermo-nuclear-review.md" },
  },
  "security-defensive": {
    model: "sonnet",
    alwaysIn: ["full"],
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "security-defensive",
    },
  },
  "coding-standards:design": {
    model: "sonnet",
    alwaysIn: ["full"],
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "coding-standards:design",
    },
  },
  "coding-standards:errors": {
    model: "sonnet",
    alwaysIn: ["full"],
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "coding-standards:errors",
    },
  },
  "coding-standards:hygiene": {
    model: "sonnet",
    alwaysIn: ["full"],
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "coding-standards:hygiene",
    },
  },
  "coding-standards:style": {
    model: "sonnet",
    alwaysIn: ["full"],
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "coding-standards:style",
    },
  },
  "general-opus": {
    model: "opus",
    alwaysIn: ["full"],
    prompt: { kind: "line-anchored", roleFile: "correctness.md" },
  },

  // ─── CLAUDE.md ─────────────────────────────────────────────────────────
  // Detection of CLAUDE.md presence is the consuming loop's responsibility;
  // here we only declare the agent and its template. Currently spawned
  // explicitly by the orchestrator when a CLAUDE.md exists.
  "claude-md-compliance": {
    model: "sonnet",
    prompt: { kind: "line-anchored", roleFile: "claude-md-compliance.md" },
  },
  "claude-md-materiality": {
    model: "haiku",
    prompt: { kind: "self-contained", templateFile: "materiality.md" },
  },

  // ─── Language by extension ─────────────────────────────────────────────
  "language-typescript": {
    model: "sonnet",
    triggers: { extensions: ["ts", "tsx"] },
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "language-typescript",
    },
  },
  "language-rust": {
    model: "sonnet",
    triggers: { extensions: ["rs"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "language-rust" },
  },
  "language-swift": {
    model: "sonnet",
    triggers: { extensions: ["swift"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "language-swift" },
  },
  vue: {
    model: "haiku",
    triggers: { extensions: ["vue"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "vue" },
  },

  // ─── Skill by import — heavy (sonnet) ──────────────────────────────────
  react: {
    model: "sonnet",
    triggers: { imports: ["react", "react-dom"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "react" },
  },
  database: {
    model: "sonnet",
    triggers: { imports: ["pg", "mysql2", "sqlite3", "@libsql/", "postgres"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "database" },
  },
  "drizzle-orm": {
    model: "sonnet",
    triggers: { imports: ["drizzle-orm", "drizzle-kit"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "drizzle-orm" },
  },

  // ─── Skill by import — light (haiku) ───────────────────────────────────
  i18n: {
    model: "haiku",
    triggers: { imports: ["i18next", "next-intl", "@formatjs/", "react-i18next"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "i18n" },
  },
  tailwind: {
    model: "haiku",
    triggers: { imports: ["tailwind", "tw-merge", "clsx"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "tailwind" },
  },
  "ui-animations": {
    model: "haiku",
    triggers: { imports: ["framer-motion", "motion/react", "@react-spring/"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "ui-animations" },
  },
  shadcn: {
    model: "haiku",
    triggers: { imports: ["@radix-ui/", "components/ui/"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "shadcn" },
  },
  "tanstack-query": {
    model: "haiku",
    triggers: { imports: ["@tanstack/react-query", "@tanstack/query-core"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "tanstack-query" },
  },
  "tanstack-start-best-practices": {
    model: "haiku",
    triggers: { imports: ["@tanstack/start", "@tanstack/react-start"] },
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "tanstack-start-best-practices",
    },
  },
  "better-result-adopt": {
    model: "haiku",
    triggers: { imports: ["better-result"] },
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "better-result-adopt",
    },
  },
  docker: {
    model: "haiku",
    triggers: { imports: ["dockerode"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "docker" },
  },
  kubernetes: {
    model: "haiku",
    triggers: { imports: ["@kubernetes/client-node"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "kubernetes" },
  },
  zod: {
    model: "haiku",
    triggers: { imports: ["zod"] },
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "zod" },
  },

  // ─── Surface (UI / design tokens / API) ────────────────────────────────
  "ui-ux": {
    model: "haiku",
    triggers: surface(UI_SURFACE, DESIGN_TOKENS),
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "ui-ux" },
  },
  "make-interfaces-feel-better": {
    model: "haiku",
    triggers: surface(UI_SURFACE, DESIGN_TOKENS),
    prompt: {
      kind: "line-anchored",
      roleFile: "skill-agent.md",
      skillName: "make-interfaces-feel-better",
    },
  },
  frontend: {
    model: "sonnet",
    triggers: surface(UI_SURFACE),
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "frontend" },
  },
  "web-performance": {
    model: "sonnet",
    triggers: surface(UI_SURFACE),
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "web-performance" },
  },
  "api-design": {
    model: "sonnet",
    triggers: surface(API_SURFACE),
    prompt: { kind: "line-anchored", roleFile: "skill-agent.md", skillName: "api-design" },
  },

  // ─── Subsystem (high-stakes — all sonnet) ──────────────────────────────
  "billing-subsystem": {
    model: "sonnet",
    triggers: {
      pathFragments: ["/billing/", "/payments/", "/invoices/", "/subscriptions/"],
      imports: ["stripe", "@paddle/", "@lemonsqueezy/"],
      codePatterns: ["chargeAmount", "refundAmount", "idempotencyKey"],
    },
    prompt: {
      kind: "line-anchored",
      roleFile: "subsystem-agent.md",
      subsystemName: "billing",
      failureModes:
        "idempotency keys reused/missing; Decimal vs float for money; invoice numbering races; refund double-apply; double-charge on retry; currency mismatch",
    },
  },
  "auth-subsystem": {
    model: "sonnet",
    triggers: {
      pathFragments: ["/auth/", "/session/"],
      imports: ["better-auth", "next-auth", "lucia", "@clerk/", "@auth/"],
      codePatterns: ["signIn(", "signUp(", "getSession(", "verifyJwt", "bcrypt", "argon2"],
    },
    prompt: {
      kind: "line-anchored",
      roleFile: "subsystem-agent.md",
      subsystemName: "auth",
      failureModes:
        "session expiry edges; token refresh races; password reset replay; MFA bypass; OAuth state CSRF; downgrade to weaker auth path",
    },
  },
  "schema-migration-subsystem": {
    model: "sonnet",
    triggers: {
      pathFragments: ["/migrations/", "/drizzle/migrations/", "/prisma/migrations/"],
      codePatterns: ["alterTable", "dropColumn", "addColumn"],
    },
    prompt: {
      kind: "line-anchored",
      roleFile: "subsystem-agent.md",
      subsystemName: "schema-migration",
      failureModes:
        "data loss on DROP; default backfill on a huge table races writes; FK/index drift; rollback impossible without data loss; long-lock blocking",
    },
  },
  "webhook-subsystem": {
    model: "sonnet",
    triggers: {
      pathFragments: ["webhook"],
      codePatterns: ["verifySignature", "crypto.createHmac", "crypto.timingSafeEqual"],
    },
    prompt: {
      kind: "line-anchored",
      roleFile: "subsystem-agent.md",
      subsystemName: "webhook",
      failureModes:
        "signature verification not timing-safe; missing replay protection; idempotency by event-id only (payload tamper); HMAC algorithm confusion",
    },
  },
  "rbac-subsystem": {
    model: "sonnet",
    triggers: {
      pathFragments: ["/policies/", "/permissions/", "/rbac/"],
      imports: ["@casl/", "casl"],
      codePatterns: ["hasPermission(", "canAccess(", "authorize(", "Policy."],
    },
    prompt: {
      kind: "line-anchored",
      roleFile: "subsystem-agent.md",
      subsystemName: "rbac",
      failureModes:
        "policy evaluation order leaks privilege; escalation via permission union; missing scope check on a new endpoint; tenant boundary leak through caller-trusted id",
    },
  },
  "multi-tenant-subsystem": {
    model: "sonnet",
    triggers: { codePatterns: ["tenantId", "organizationId", "workspaceId"] },
    prompt: {
      kind: "line-anchored",
      roleFile: "subsystem-agent.md",
      subsystemName: "multi-tenant",
      failureModes:
        "row-level scope missing; tenant-id leakage in cache/logs; cross-tenant pagination cursor; default to current tenant when none given",
    },
  },
  "cron-subsystem": {
    model: "sonnet",
    triggers: {
      pathFragments: ["/cron/", "/jobs/", "/workers/"],
      imports: ["bullmq", "bull", "agenda", "node-cron", "@trigger.dev/", "inngest"],
      codePatterns: ["defineJob(", "enqueue(", ".cron("],
    },
    prompt: {
      kind: "line-anchored",
      roleFile: "subsystem-agent.md",
      subsystemName: "cron",
      failureModes:
        "lock not acquired; overlapping runs; partial-failure rerun without idempotency; dead-letter queue not configured; clock-skew misfire",
    },
  },
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
export const ALL_AGENT_NAMES = Object.keys(AGENTS) as ReadonlyArray<AgentName>;

/** Subset that spawns unconditionally in the given tier. */
export const alwaysSpawnIn = (tier: ReviewTier): ReadonlyArray<AgentName> =>
  ALL_AGENT_NAMES.filter((agent) => AGENTS[agent].alwaysIn?.includes(tier) === true);

/** Whether the agent declares any conditional trigger at all. */
export const hasTriggers = (agent: AgentName): boolean => {
  const triggers = AGENTS[agent].triggers;
  if (triggers === undefined) return false;
  return (
    (triggers.extensions?.length ?? 0) +
      (triggers.pathFragments?.length ?? 0) +
      (triggers.imports?.length ?? 0) +
      (triggers.codePatterns?.length ?? 0) >
    0
  );
};

/** Whether the agent represents a subsystem (drives high_stakes tier classification). */
export const isSubsystemAgent = (agent: AgentName): boolean => {
  const prompt = AGENTS[agent].prompt;
  return prompt.kind === "line-anchored" && prompt.subsystemName !== undefined;
};
