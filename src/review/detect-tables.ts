/**
 * Review/detect-tables.ts — detection tables orthogonal to the agent registry.
 *
 * Per-agent rows (model, prompt, triggers) live in `./agents.ts` — the single
 * CRUD surface. This file keeps only the tables that aren't per-agent:
 *  - {@link TRUST_BOUNDARY_SIGNALS} — independent of which agents fire.
 *  - {@link HIGH_STAKES_PATH_FRAGMENTS} — tier-classification input.
 *  - {@link DOGFOOD_TRIGGERS} — runtime-gate categories.
 *  - {@link TIER_LITE_MAX_LINES} / {@link TIER_LITE_MAX_FILES} — tier bounds.
 *
 * Re-exported for backward compatibility:
 *  - `AgentName` — see `./agents.ts`.
 */

export type { AgentName } from "./agents";

/**
 * Trust boundaries the diff crosses, detected per the signals column. Used to
 * compute the `{trust_boundaries}` substitution for every line-anchored agent
 * template. The failure-mode strings live in the agent prompt, not here.
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
 * trust boundary. Matching is loose — a false positive costs one extra token
 * in a prompt; a false negative misses a security lens.
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

/**
 * Path fragments that force `high_stakes = true` for tier classification,
 * independent of any agent firing. Mirror of the SKILL.md "high-stakes path"
 * list. Subsystem-agent triggers ALSO contribute to `high_stakes` — they live
 * in `./agents.ts` and are detected at plan-build time.
 */
export const HIGH_STAKES_PATH_FRAGMENTS: ReadonlyArray<string> = [
  "/auth/",
  "/crypto/",
  "/permissions/",
  "/migrations/",
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
    pathFragments: ["/electron/", "/tauri/", "/ios/", "/android/", "react-native", "/expo/"],
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
