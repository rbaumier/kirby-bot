/**
 * Review/render-prompt.ts — `renderAgentPrompt`: build one agent's prompt by
 * substituting placeholders into vendored templates from
 * `assets/code-review-templates/`.
 *
 * Two template kinds:
 *
 *   - **Line-anchored** — `_line-anchored-scaffold.md` wraps a role-specific
 *     body. Used by Correctness, Tests, Skill, Subsystem, CLAUDE.md
 *     Compliance, Occam Razor, and every framework/lib/surface skill agent.
 *     Output contract: JSON envelope (defined in the scaffold).
 *
 *   - **Self-contained** — Funnel L1/L2, Materiality, Matt Review,
 *     Thermo-nuclear. Output contract: prose, `[must]` / `[suggestion]` tags.
 *
 * On top of the upstream `code-review` skill contract, we prepend a
 * **kirby-bot preamble** that adapts the prompt to our one-shot per-agent
 * tmux-session execution model:
 *  - No Task / Agent tool: this session IS the fan-out unit.
 *  - Write the final output (either the JSON envelope or the prose
 *    findings, verbatim) to a designated `findings_file` path.
 *  - End the session with `VERDICT: AGENT_DONE` as the last non-empty line —
 *    the orchestrator's sentinel-Stop-hook contract requires it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { AgentName, TrustBoundary } from "./detect-tables";

/** Errors surfaced when a template is missing or a placeholder cannot be filled. */
export class RenderError {
  readonly _tag = "RenderError";
  constructor(
    readonly reason: string,
    readonly agent: AgentName,
  ) {}
}

/**
 * Agent → template + per-agent substitutions. Drives `renderAgentPrompt`.
 *
 * `kind: "line-anchored"` agents get wrapped by `_line-anchored-scaffold.md`
 * with `{role_specific}` swapped for `roleFile`. `kind: "self-contained"`
 * agents use `templateFile` alone.
 *
 * `skillName` / `subsystemName` / `failureModes` populate the corresponding
 * placeholders in `skill-agent.md` / `subsystem-agent.md`. Empty string when
 * the template doesn't reference them.
 */
type AgentSpec =
  | { readonly kind: "line-anchored"; readonly roleFile: string; readonly skillName?: string; readonly subsystemName?: string; readonly failureModes?: string }
  | { readonly kind: "self-contained"; readonly templateFile: string };

/**
 * Subsystem failure-mode strings — verbatim text the `subsystem-agent.md`
 * template embeds under `{failure_modes}`. Kept inline here (not in
 * `detect-tables.ts`) because this is rendering-time data: detection only
 * needs to know that the subsystem triggered, not what to hunt for.
 *
 * The `satisfies Partial<Record<AgentName, string>>` clause keeps this map
 * keyed on the exact `AgentName` union — adding a subsystem to
 * `detect-tables.ts` without adding its failure-mode string here would
 * silently degrade the rendered prompt (subsystem-agent template would
 * substitute the empty string for `{failure_modes}`). The compile-time
 * constraint catches the gap before it ships.
 */
const SUBSYSTEM_FAILURE_MODES = {
  "billing-subsystem":
    "idempotency keys reused/missing; Decimal vs float for money; invoice numbering races; refund double-apply; double-charge on retry; currency mismatch",
  "auth-subsystem":
    "session expiry edges; token refresh races; password reset replay; MFA bypass; OAuth state CSRF; downgrade to weaker auth path",
  "schema-migration-subsystem":
    "data loss on DROP; default backfill on a huge table races writes; FK/index drift; rollback impossible without data loss; long-lock blocking",
  "webhook-subsystem":
    "signature verification not timing-safe; missing replay protection; idempotency by event-id only (payload tamper); HMAC algorithm confusion",
  "rbac-subsystem":
    "policy evaluation order leaks privilege; escalation via permission union; missing scope check on a new endpoint; tenant boundary leak through caller-trusted id",
  "multi-tenant-subsystem":
    "row-level scope missing; tenant-id leakage in cache/logs; cross-tenant pagination cursor; default to current tenant when none given",
  "cron-subsystem":
    "lock not acquired; overlapping runs; partial-failure rerun without idempotency; dead-letter queue not configured; clock-skew misfire",
} as const satisfies Partial<Record<AgentName, string>>;

/**
 * Skill-name for skill-agent.md templated runs (language / lib / surface).
 *
 * `as const satisfies Partial<Record<AgentName, string>>` narrows the inferred
 * key type to the literal subset — so `keyof typeof SKILL_BY_AGENT` is the
 * precise enumeration of skill agents, which lets {@link AGENT_SPECS} below
 * trust the spread result without a runtime check.
 */
const SKILL_BY_AGENT = {
  "language-typescript": "language-typescript",
  "language-rust": "language-rust",
  "language-swift": "language-swift",
  vue: "vue",
  "better-result-adopt": "better-result-adopt",
  database: "database",
  docker: "docker",
  "drizzle-orm": "drizzle-orm",
  i18n: "i18n",
  kubernetes: "kubernetes",
  react: "react",
  shadcn: "shadcn",
  tailwind: "tailwind",
  "tanstack-query": "tanstack-query",
  "tanstack-start-best-practices": "tanstack-start-best-practices",
  "ui-animations": "ui-animations",
  zod: "zod",
  "ui-ux": "ui-ux",
  frontend: "frontend",
  "make-interfaces-feel-better": "make-interfaces-feel-better",
  "web-performance": "web-performance",
  "api-design": "api-design",
  simplify: "simplify",
  "matt-improve-codebase-architecture": "matt-improve-codebase-architecture",
  "security-defensive": "security-defensive",
  "coding-standards": "coding-standards",
  "coding-standards:design": "coding-standards:design",
  "coding-standards:errors": "coding-standards:errors",
  "coding-standards:hygiene": "coding-standards:hygiene",
  "coding-standards:style": "coding-standards:style",
} as const satisfies Partial<Record<AgentName, string>>;

/**
 * Skill-agent specs built from {@link SKILL_BY_AGENT}. Cast to the precise key
 * set so the {@link AGENT_SPECS} spread carries its keys into the outer
 * `satisfies` check.
 */
const SKILL_AGENT_SPECS = Object.fromEntries(
  Object.entries(SKILL_BY_AGENT).map(([agent, skill]) => [
    agent,
    { kind: "line-anchored", roleFile: "skill-agent.md", skillName: skill } satisfies AgentSpec,
  ]),
) as Record<keyof typeof SKILL_BY_AGENT, AgentSpec>;

/** Subsystem-agent specs built from {@link SUBSYSTEM_FAILURE_MODES}. */
const SUBSYSTEM_AGENT_SPECS = Object.fromEntries(
  Object.entries(SUBSYSTEM_FAILURE_MODES).map(([agent, modes]) => [
    agent,
    {
      kind: "line-anchored",
      roleFile: "subsystem-agent.md",
      subsystemName: agent.replace("-subsystem", ""),
      failureModes: modes,
    } satisfies AgentSpec,
  ]),
) as Record<keyof typeof SUBSYSTEM_FAILURE_MODES, AgentSpec>;

/**
 * Static spec table — exhaustive over {@link AgentName}. The `satisfies` clause
 * is the load-bearing guarantee: adding an agent to `AgentName` without
 * extending {@link SKILL_BY_AGENT}/{@link SUBSYSTEM_FAILURE_MODES} or this
 * table is a compile error, not a runtime `undefined`.
 */
const AGENT_SPECS = {
  // Generic line-anchored
  correctness: { kind: "line-anchored", roleFile: "correctness.md" },
  "general-opus": { kind: "line-anchored", roleFile: "correctness.md" },
  tests: { kind: "line-anchored", roleFile: "tests-agent.md" },
  "occam-razor": { kind: "line-anchored", roleFile: "occam-razor.md" },
  "claude-md-compliance": { kind: "line-anchored", roleFile: "claude-md-compliance.md" },

  // Skill-agent variants (skillName driven)
  ...SKILL_AGENT_SPECS,

  // Subsystem variants (subsystemName + failureModes driven)
  ...SUBSYSTEM_AGENT_SPECS,

  // Self-contained
  "funnel-l1": { kind: "self-contained", templateFile: "funnel-l1.md" },
  "funnel-l2": { kind: "self-contained", templateFile: "funnel-l2.md" },
  "matt-review": { kind: "self-contained", templateFile: "matt-review.md" },
  "thermo-nuclear": { kind: "self-contained", templateFile: "thermo-nuclear-review.md" },
  "claude-md-materiality": { kind: "self-contained", templateFile: "materiality.md" },
} satisfies Record<AgentName, AgentSpec>;

/** Input for {@link renderAgentPrompt}. */
export type RenderAgentPromptInput = {
  readonly agent: AgentName;
  /** Absolute path to the agent's diff slice (`{diff_file}`). */
  readonly diffFile: string;
  /** Files this agent owns (`{file_list}`). Joined by `, `. */
  readonly fileList: ReadonlyArray<string>;
  /** Active trust boundaries (`{trust_boundaries}`). Empty → `none`. */
  readonly trustBoundaries: ReadonlyArray<TrustBoundary>;
  /**
   * Re-review only — the per-agent `previous_findings_block` body. Inserted
   * into the scaffold's `{previous_findings_block}` placeholder. Pass empty
   * string on first pass.
   */
  readonly previousFindingsBlock: string;
  /**
   * Where the agent should write its final findings — JSON envelope for
   * line-anchored, prose for self-contained. The orchestrator polls this path
   * (via the sentinel mechanism, in parallel with the verdict).
   */
  readonly findingsFile: string;
  /** Absolute path to `assets/code-review-templates/`. */
  readonly templatesDir: string;
};

/**
 * The kirby-bot preamble — prepended to every rendered prompt.
 *
 * Adapts the upstream prompt (originally designed to run as a Task-tool
 * subagent of a parent code-review session) to our per-agent tmux-session
 * model: the agent IS the session, has no Task tool to fan out further, and
 * must produce both a side-channel output file and a session-ending verdict
 * marker our Stop hook can latch on.
 */
const kirbyPreamble = (findingsFile: string): string =>
  [
    "# kirby-bot per-agent review session",
    "",
    "You are running as a one-shot review agent in an isolated `claude` session spawned by the kirby-bot orchestrator.",
    "",
    "## Hard constraints",
    "",
    "- **Do NOT use the Task / Agent tool.** This session IS one unit of the fan-out — spawning subagents here defeats the orchestrator's per-agent budget tracking and breaks the Stop-hook contract.",
    `- Write your final output (the JSON envelope from the role template, or the prose findings, verbatim) to ${findingsFile}. Write atomically: write to ${findingsFile}.tmp, then rename. Do NOT print the JSON in chat — only the file matters.`,
    "- After writing the findings file, end your final assistant turn with this token on its own line as the **last non-empty line**:",
    "",
    "  VERDICT: AGENT_DONE",
    "",
    "  The orchestrator's Stop hook watches for this token. Nothing else (no closing remarks, no markdown fences, no trailing summary).",
    "",
    "---",
    "",
  ].join("\n");

/** Apply every `{key} → value` substitution to `text`. Literal, not regex. */
const substitute = (text: string, mapping: Readonly<Record<string, string>>): string =>
  Object.entries(mapping).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, value),
    text,
  );

/** Read a template file off disk into a string. */
const readTemplate = (
  templatesDir: string,
  filename: string,
  agent: AgentName,
): Effect.Effect<string, RenderError> =>
  Effect.tryPromise({
    try: () => readFile(join(templatesDir, filename), "utf8"),
    catch: (cause) => new RenderError(`failed to read ${filename}: ${String(cause)}`, agent),
  });

/**
 * `renderAgentPrompt` — produce one agent's tmux-pasted prompt.
 *
 * Reads the template(s), substitutes every placeholder mechanically (literal
 * find-and-replace, no template engine — the scaffold is small enough that a
 * full Mustache-style dependency would be more code than this whole module),
 * and prepends the kirby-bot preamble.
 */
export const renderAgentPrompt = (
  input: RenderAgentPromptInput,
): Effect.Effect<string, RenderError> =>
  Effect.gen(function* () {
    // Widen the per-key literal type from `satisfies` back to the open
    // {@link AgentSpec} union — the consumer code below needs to see optional
    // fields (`skillName`, `subsystemName`, `failureModes`) that exist on
    // *some* members of the union, not just the literal spec for one key.
    const spec: AgentSpec | undefined = AGENT_SPECS[input.agent];
    if (spec === undefined) {
      return yield* Effect.fail(new RenderError("no spec for agent", input.agent));
    }

    const trustBoundaries =
      input.trustBoundaries.length === 0 ? "none" : input.trustBoundaries.join(", ");
    const fileList = input.fileList.join(", ");

    const baseSubs: Readonly<Record<string, string>> = {
      diff_file: input.diffFile,
      file_list: fileList,
      trust_boundaries: trustBoundaries,
      previous_findings_block: input.previousFindingsBlock,
    };

    if (spec.kind === "self-contained") {
      const body = yield* readTemplate(input.templatesDir, spec.templateFile, input.agent);
      return kirbyPreamble(input.findingsFile) + substitute(body, baseSubs);
    }

    // Line-anchored: read scaffold + role body in parallel, swap, substitute.
    const [scaffold, roleBody] = yield* Effect.all(
      [
        readTemplate(input.templatesDir, "_line-anchored-scaffold.md", input.agent),
        readTemplate(input.templatesDir, spec.roleFile, input.agent),
      ],
      { concurrency: "unbounded" },
    );

    const roleSubs: Readonly<Record<string, string>> = {
      ...baseSubs,
      skill_name: spec.skillName ?? "",
      subsystem_name: spec.subsystemName ?? "",
      failure_modes: spec.failureModes ?? "",
    };

    // Substitute placeholders in the role body *first*, then wrap with the
    // scaffold and substitute the scaffold-level placeholders. Order matters:
    // the role body itself contains placeholders the scaffold doesn't know
    // about (`{skill_name}`, `{subsystem_name}`, `{failure_modes}`).
    const roleBodyFilled = substitute(roleBody, roleSubs);
    const wrapped = scaffold.replaceAll("{role_specific}", roleBodyFilled);
    const scaffoldFilled = substitute(wrapped, baseSubs);

    return kirbyPreamble(input.findingsFile) + scaffoldFilled;
  });
