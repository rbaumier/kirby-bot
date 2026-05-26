/**
 * Review/detect-tables.ts — tables that are still load-bearing AFTER the router
 * refactor: trust boundaries and dogfood-gate categories.
 *
 * The router (haiku in `./router.ts`) now owns every agent-spawn decision; this
 * file holds only the two tables that are NOT per-agent and that we still need
 * deterministically (not delegated to a model):
 *
 *  - {@link TRUST_BOUNDARY_SIGNALS} — substituted into every line-anchored
 *    prompt as `{trust_boundaries}` so each agent knows which boundaries the
 *    diff crosses. Detected by substring scan over file contents + import
 *    specifiers (a false positive costs one extra token; a false negative
 *    drops a security lens — bias toward inclusive matching).
 *  - {@link DOGFOOD_TRIGGERS} — runtime 3-persona gate categories, fed to the
 *    review pass result so the consuming loop knows whether to run dogfood.
 *
 * Tier classification (`Lite` / `Full`, `HIGH_STAKES_PATH_FRAGMENTS`,
 * `TIER_LITE_MAX_*`) is gone — the router decides which agents fire based on
 * the diff's actual content, not on path heuristics or line counts.
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
