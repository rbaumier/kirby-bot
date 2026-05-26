/**
 * Review/detect-tables.ts — data tables that drive `detectReviewPlan`.
 *
 * Ported from `~/.claude/skills/code-review/reference/{always-spawn,trust-boundaries,subsystems,surfaces-and-dogfood}.md`.
 * Keep them in sync with that source — the skill is the spec; this file is the
 * machine-readable replica the orchestrator consults at fan-out time.
 *
 * All path patterns are `minimatch` globs and are matched recursively
 * (`**` is implied around any bare segment unless the pattern is anchored).
 * All import patterns are matched as substrings against any import-spec the
 * caller extracts from the diff. Failure-mode columns are not stored here —
 * they live verbatim in the line-anchored agent prompt at render time
 * (see `renderAgentPrompt`).
 */

/** A canonical agent name. Subagent prompts reference this label. */
export type AgentName =
  // Always-spawn (Full)
  | "funnel-l1"
  | "funnel-l2"
  | "occam-razor"
  | "correctness"
  | "tests"
  | "simplify"
  | "matt-improve-codebase-architecture"
  | "matt-review"
  | "thermo-nuclear"
  | "security-defensive"
  | "coding-standards"
  | "coding-standards:design"
  | "coding-standards:errors"
  | "coding-standards:hygiene"
  | "coding-standards:style"
  | "general-opus"
  // Conditional — CLAUDE.md
  | "claude-md-compliance"
  | "claude-md-materiality"
  // Language by extension
  | "language-typescript"
  | "language-rust"
  | "language-swift"
  | "vue"
  // Skill by import
  | "better-result-adopt"
  | "database"
  | "docker"
  | "drizzle-orm"
  | "i18n"
  | "kubernetes"
  | "react"
  | "shadcn"
  | "tailwind"
  | "tanstack-query"
  | "tanstack-start-best-practices"
  | "ui-animations"
  | "zod"
  // Surface
  | "ui-ux"
  | "frontend"
  | "make-interfaces-feel-better"
  | "web-performance"
  | "api-design"
  // Subsystem
  | "billing-subsystem"
  | "auth-subsystem"
  | "schema-migration-subsystem"
  | "webhook-subsystem"
  | "rbac-subsystem"
  | "multi-tenant-subsystem"
  | "cron-subsystem";

/**
 * The agents that fire on every Full-tier run regardless of file shape.
 * Ticked through explicitly so a regression in `detect.ts` can't silently
 * drop one — the table mirrors the checkbox list in `always-spawn.md`.
 */
export const FULL_ALWAYS_SPAWN: readonly AgentName[] = [
  "funnel-l1",
  "funnel-l2",
  "occam-razor",
  "correctness",
  "tests",
  "simplify",
  "matt-improve-codebase-architecture",
  "matt-review",
  "thermo-nuclear",
  "security-defensive",
  "coding-standards",
  "coding-standards:design",
  "coding-standards:errors",
  "coding-standards:hygiene",
  "coding-standards:style",
  "general-opus",
] as const;

/**
 * The Lite-tier subset — Lite cuts the umbrella sub-skills, the matt-/Opus
 * generalist passes, security-defensive, and ALL conditional spawns
 * (no subsystem, no surface, no import). One Correctness, one language
 * agent (caller picks the dominant ext), the umbrella coding-standards.
 */
export const LITE_ALWAYS_SPAWN: readonly AgentName[] = [
  "funnel-l1",
  "funnel-l2",
  "occam-razor",
  "correctness",
  "tests",
  "simplify",
  "coding-standards",
] as const;

/**
 * Map a file extension to its language skill agent.
 * Returns `null` for extensions we don't have a language skill for —
 * the caller falls back to the generic Correctness pass.
 */
export const LANGUAGE_BY_EXT: Readonly<Record<string, AgentName | null>> = {
  ts: "language-typescript",
  tsx: "language-typescript",
  rs: "language-rust",
  swift: "language-swift",
  vue: "vue",
};

/**
 * Trust boundaries the diff crosses, detected per the signals column.
 * Used to compute the `{trust_boundaries}` substitution for every line-anchored
 * agent template. The failure-mode strings live in the agent prompt, not here.
 */
export type TrustBoundary =
  | "user-input"
  | "network"
  | "filesystem"
  | "secrets"
  | "process-exec"
  | "database"
  | "auth"
  | "permissions"
  | "concurrency"
  | "external-api"
  | "serialization";

/**
 * Signals that, when present anywhere in a changed file, activate the named
 * trust boundary. Each row's `signals` is the union of all detection knobs:
 * import substrings (matched against `import …` lines), code-pattern
 * substrings (matched against the file body), and path-glob fragments.
 *
 * Matching is intentionally loose — false-positives cost one extra
 * `{trust_boundaries}` token in a prompt; false-negatives miss a security lens.
 */
export const TRUST_BOUNDARY_SIGNALS: ReadonlyArray<{
  readonly boundary: TrustBoundary;
  readonly signals: ReadonlyArray<string>;
}> = [
  {
    boundary: "user-input",
    signals: ["req.body", "req.query", "req.params", "formData", "parseBody"],
  },
  {
    boundary: "network",
    signals: ["fetch(", "http.get(", "http.request(", "axios", "got", "undici"],
  },
  {
    boundary: "filesystem",
    signals: ["fs/promises", "node:fs", "std::fs", "path.join", "writeFile", "readFile"],
  },
  {
    boundary: "secrets",
    signals: ["_KEY", "_SECRET", "_TOKEN", "jwt.sign", "kms.", "vault."],
  },
  {
    boundary: "process-exec",
    signals: ["child_process", "node:child_process", "Bun.spawn", "$`", "execSync", "spawnSync"],
  },
  {
    boundary: "database",
    signals: ["drizzle", "prisma", "typeorm", "sqlx", "sea-orm", "db.query", "pool.execute"],
  },
  {
    boundary: "auth",
    signals: ["getSession", "verifyJwt", "bcrypt", "argon2", "@clerk/", "next-auth", "better-auth"],
  },
  {
    boundary: "permissions",
    signals: ["hasPermission", "canAccess", "authorize(", "Policy.", "@casl/"],
  },
  {
    boundary: "concurrency",
    signals: ["Promise.all", "tokio::spawn", "Worker(", "Mutex", "Atomic"],
  },
  {
    boundary: "external-api",
    signals: ["stripe", "twilio", "@aws-sdk/", "openai", "@anthropic-ai"],
  },
  {
    boundary: "serialization",
    signals: ["JSON.parse", "yaml.load", "msgpack", "protobuf", "pickle.loads", "serde"],
  },
];

/** A subsystem trigger row, mirroring `subsystems.md`. */
export type SubsystemRow = {
  readonly agent: AgentName;
  /** Path-glob fragments — substring-matched against changed paths. */
  readonly pathFragments: ReadonlyArray<string>;
  /** Import substrings. */
  readonly imports: ReadonlyArray<string>;
  /** Code-pattern substrings. */
  readonly codePatterns: ReadonlyArray<string>;
};

export const SUBSYSTEM_TRIGGERS: ReadonlyArray<SubsystemRow> = [
  {
    agent: "billing-subsystem",
    pathFragments: ["/billing/", "/payments/", "/invoices/", "/subscriptions/"],
    imports: ["stripe", "@paddle/", "@lemonsqueezy/"],
    codePatterns: ["chargeAmount", "refundAmount", "idempotencyKey"],
  },
  {
    agent: "auth-subsystem",
    pathFragments: ["/auth/", "/session/"],
    imports: ["better-auth", "next-auth", "lucia", "@clerk/", "@auth/"],
    codePatterns: ["signIn(", "signUp(", "getSession(", "verifyJwt", "bcrypt", "argon2"],
  },
  {
    agent: "schema-migration-subsystem",
    pathFragments: ["/migrations/", "/drizzle/migrations/", "/prisma/migrations/"],
    imports: [],
    codePatterns: ["alterTable", "dropColumn", "addColumn"],
  },
  {
    agent: "webhook-subsystem",
    pathFragments: ["webhook"],
    imports: [],
    codePatterns: ["verifySignature", "crypto.createHmac", "crypto.timingSafeEqual"],
  },
  {
    agent: "rbac-subsystem",
    pathFragments: ["/policies/", "/permissions/", "/rbac/"],
    imports: ["@casl/", "casl"],
    codePatterns: ["hasPermission(", "canAccess(", "authorize(", "Policy."],
  },
  {
    agent: "multi-tenant-subsystem",
    pathFragments: [],
    imports: [],
    codePatterns: ["tenantId", "organizationId", "workspaceId"],
  },
  {
    agent: "cron-subsystem",
    pathFragments: ["/cron/", "/jobs/", "/workers/"],
    imports: ["bullmq", "bull", "agenda", "node-cron", "@trigger.dev/", "inngest"],
    codePatterns: ["defineJob(", "enqueue(", ".cron("],
  },
];

/**
 * Whether any subsystem trigger fires → forces `high_stakes` for tier
 * classification. Mirrored from the SKILL.md tier section.
 */
export const HIGH_STAKES_PATH_FRAGMENTS: ReadonlyArray<string> = [
  "/auth/",
  "/crypto/",
  "/permissions/",
  "/migrations/",
];

/** A skill-by-import trigger row. */
export type ImportSkillRow = {
  readonly agent: AgentName;
  readonly imports: ReadonlyArray<string>;
};

export const IMPORT_SKILL_TRIGGERS: ReadonlyArray<ImportSkillRow> = [
  { agent: "better-result-adopt", imports: ["better-result"] },
  { agent: "database", imports: ["pg", "mysql2", "sqlite3", "@libsql/", "postgres"] },
  { agent: "docker", imports: ["dockerode"] },
  { agent: "drizzle-orm", imports: ["drizzle-orm", "drizzle-kit"] },
  { agent: "i18n", imports: ["i18next", "next-intl", "@formatjs/", "react-i18next"] },
  { agent: "kubernetes", imports: ["@kubernetes/client-node"] },
  { agent: "react", imports: ["react", "react-dom"] },
  { agent: "shadcn", imports: ["@radix-ui/", "components/ui/"] },
  { agent: "tailwind", imports: ["tailwind", "tw-merge", "clsx"] },
  { agent: "tanstack-query", imports: ["@tanstack/react-query", "@tanstack/query-core"] },
  {
    agent: "tanstack-start-best-practices",
    imports: ["@tanstack/start", "@tanstack/react-start"],
  },
  { agent: "ui-animations", imports: ["framer-motion", "motion/react", "@react-spring/"] },
  { agent: "zod", imports: ["zod"] },
];

/** A surface trigger row — path globs → skill agents AND dogfood categories. */
export type SurfaceRow = {
  readonly pathFragments: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
  readonly agents: ReadonlyArray<AgentName>;
};

export const SURFACE_TRIGGERS: ReadonlyArray<SurfaceRow> = [
  {
    pathFragments: ["/app/", "/pages/", "/src/routes/"],
    extensions: ["tsx", "jsx", "vue", "svelte", "astro", "mdx"],
    agents: ["ui-ux", "frontend", "make-interfaces-feel-better", "web-performance"],
  },
  {
    pathFragments: ["tokens.", "theme."],
    extensions: ["css", "scss"],
    agents: ["ui-ux", "make-interfaces-feel-better"],
  },
  {
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
    agents: ["api-design"],
  },
];

/** Dogfood category — drives the runtime 3-persona gate after static review. */
export type DogfoodCategory = "web-ui" | "http-api" | "cli" | "native";

/** A dogfood-category trigger row. */
export type DogfoodRow = {
  readonly category: DogfoodCategory;
  readonly pathFragments: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
  readonly imports: ReadonlyArray<string>;
};

export const DOGFOOD_TRIGGERS: ReadonlyArray<DogfoodRow> = [
  {
    category: "web-ui",
    pathFragments: ["/app/", "/pages/", "/src/routes/", "tokens.", "theme.", "/public/"],
    extensions: ["tsx", "jsx", "vue", "svelte", "astro", "mdx", "html", "css", "scss"],
    imports: [],
  },
  {
    category: "http-api",
    pathFragments: ["/route.", "middleware.", "/server/api/", "/api/", "/routes/"],
    extensions: [],
    imports: ["next", "express", "fastify", "hono", "koa", "@trpc/server"],
  },
  {
    category: "cli",
    pathFragments: ["/bin/", "/cli/", "/src/cli/"],
    extensions: [],
    imports: ["commander", "yargs", "oclif", "clipanion", "cac", "meow"],
  },
  {
    category: "native",
    pathFragments: [
      "/electron/",
      "/tauri/",
      "/ios/",
      "/android/",
      "react-native",
      "/expo/",
    ],
    extensions: [],
    imports: ["electron", "@tauri-apps/", "react-native", "expo"],
  },
];

/**
 * Tier rule: Lite iff `total_lines ≤ 50` AND `file_count ≤ 5` AND no
 * `high_stakes` trigger. Otherwise Full. Override (force-Full) is the
 * caller's call when the user explicitly asked for a deep review.
 */
export const TIER_LITE_MAX_LINES = 50;
export const TIER_LITE_MAX_FILES = 5;
