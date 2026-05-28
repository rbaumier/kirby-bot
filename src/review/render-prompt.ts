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
 *
 * The per-agent spec (template file, kind, skill / subsystem substitutions)
 * lives in `./agents.ts`. This module reads from there — no agent-specific
 * data is duplicated here.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { AgentName, PromptSpec } from "./agents";
import { AGENTS } from "./agents";
import type { TrustBoundary } from "./detect-tables";

/** Errors surfaced when a template is missing or a placeholder cannot be filled. */
export class RenderError {
  readonly _tag = "RenderError";
  constructor(
    readonly reason: string,
    readonly agent: AgentName,
  ) {}
}

/** Input for {@link renderAgentPrompt}. */
export type RenderAgentPromptInput = {
  readonly agent: AgentName;
  /** Absolute path to the agent's diff slice (`{diff_file}`). */
  readonly diffFile: string;
  /** Files this agent owns (`{file_list}`). Joined by `, `. */
  readonly fileList: readonly string[];
  /** Active trust boundaries (`{trust_boundaries}`). Empty → `none`. */
  readonly trustBoundaries: readonly TrustBoundary[];
  /**
   * Re-review only — the per-agent `previous_findings_block` body. Inserted
   * into the scaffold's `{previous_findings_block}` placeholder. Pass empty
   * string on first pass.
   */
  readonly previousFindingsBlock: string;
  /**
   * Where the agent should write its final findings — JSON envelope for
   * line-anchored, prose for self-contained. The orchestrator polls this
   * path (via the sentinel mechanism, in parallel with the verdict).
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
    const entry = AGENTS[input.agent] as { readonly prompt: PromptSpec } | undefined;
    if (entry === undefined) {
      return yield* Effect.fail(new RenderError("no spec for agent", input.agent));
    }
    const prompt = entry.prompt;

    const trustBoundaries =
      input.trustBoundaries.length === 0 ? "none" : input.trustBoundaries.join(", ");
    const fileList = input.fileList.join(", ");

    const baseSubs: Readonly<Record<string, string>> = {
      diff_file: input.diffFile,
      file_list: fileList,
      trust_boundaries: trustBoundaries,
      previous_findings_block: input.previousFindingsBlock,
    };

    if (prompt.kind === "self-contained") {
      const body = yield* readTemplate(input.templatesDir, prompt.templateFile, input.agent);
      return kirbyPreamble(input.findingsFile) + substitute(body, baseSubs);
    }

    // Line-anchored: read scaffold + role body in parallel, swap, substitute.
    const [scaffold, roleBody] = yield* Effect.all(
      [
        readTemplate(input.templatesDir, "_line-anchored-scaffold.md", input.agent),
        readTemplate(input.templatesDir, prompt.roleFile, input.agent),
      ],
      { concurrency: "unbounded" },
    );

    const roleSubs: Readonly<Record<string, string>> = {
      ...baseSubs,
      skill_name: prompt.skillName ?? "",
      skill_names: prompt.skillNames?.join(", ") ?? "",
      subsystem_name: prompt.subsystemName ?? "",
      failure_modes: prompt.failureModes ?? "",
    };

    // Substitute role-body placeholders first, then wrap with the scaffold and
    // substitute scaffold-level placeholders. Order matters: the role body
    // contains placeholders the scaffold doesn't know about (skill_name,
    // subsystem_name, failure_modes).
    const roleBodyFilled = substitute(roleBody, roleSubs);
    const wrapped = scaffold.replaceAll("{role_specific}", roleBodyFilled);
    const scaffoldFilled = substitute(wrapped, baseSubs);

    return kirbyPreamble(input.findingsFile) + scaffoldFilled;
  });
