import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import type { AgentName, PromptSpec } from "./agents";
import { AGENTS, ALL_AGENT_NAMES } from "./agents";
import { renderAgentPrompt } from "./render-prompt";

const TEMPLATES_DIR = join(import.meta.dirname, "..", "..", "assets", "code-review-templates");

const baseInput = {
  diffFile: "/tmp/diff-slice.patch",
  fileList: ["src/auth/login.ts", "src/auth/session.ts"],
  trustBoundaries: ["auth", "user-input"] as const,
  previousFindingsBlock: "",
  findingsFile: "/tmp/findings-agent.json",
  templatesDir: TEMPLATES_DIR,
};

const run = (effect: Effect.Effect<string, unknown>): Promise<string> =>
  Effect.runPromise(effect as Effect.Effect<string, never>);

// Pick a representative agent per prompt SHAPE from whatever is active in the
// registry, rather than hardcoding names. Commenting an agent out (the
// supported on/off switch) must not break rendering tests: each test exercises
// a prompt mechanic (scaffold substitution, skill_name, subsystem framing,
// self-contained) using the first active agent of the matching shape, and
// no-ops when no such agent is active.
const firstAgent = (pred: (spec: PromptSpec) => boolean): AgentName | undefined =>
  ALL_AGENT_NAMES.find((name) => pred(AGENTS[name].prompt));

const selfContainedAgent = firstAgent((s) => s.kind === "self-contained");
const plainLineAnchored = firstAgent(
  (s) => s.kind === "line-anchored" && s.skillName === undefined && s.subsystemName === undefined,
);
const skillAgent = firstAgent((s) => s.kind === "line-anchored" && s.skillName !== undefined);
const subsystemAgent = firstAgent((s) => s.kind === "line-anchored" && s.subsystemName !== undefined);

describe("renderAgentPrompt — kirby-bot preamble", () => {
  test("line-anchored prompt carries preamble + VERDICT marker + findings path", async () => {
    if (plainLineAnchored === undefined) { return; }
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: plainLineAnchored }));
    expect(prompt).toStartWith("# kirby-bot per-agent review session");
    expect(prompt).toContain("Do NOT use the Task / Agent tool.");
    expect(prompt).toContain("VERDICT: AGENT_DONE");
    expect(prompt).toContain("/tmp/findings-agent.json");
  });

  test("self-contained agent also gets the preamble", async () => {
    if (selfContainedAgent === undefined) { return; }
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: selfContainedAgent }));
    expect(prompt).toContain("# kirby-bot per-agent review session");
    expect(prompt).toContain("VERDICT: AGENT_DONE");
  });
});

describe("renderAgentPrompt — line-anchored", () => {
  test("scaffold mechanics: diff file, file list, trust boundaries, no leaked placeholders", async () => {
    if (plainLineAnchored === undefined) { return; }
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: plainLineAnchored }));
    // Scaffold sentinels — agent-independent (come from _line-anchored-scaffold.md).
    expect(prompt).toContain("Read diff from /tmp/diff-slice.patch");
    expect(prompt).toContain("filtered to src/auth/login.ts, src/auth/session.ts");
    expect(prompt).toContain("Trust boundaries: auth, user-input");
    // Placeholders never leak in raw form.
    expect(prompt).not.toContain("{trust_boundaries}");
    expect(prompt).not.toContain("{diff_file}");
    expect(prompt).not.toContain("{role_specific}");
  });

  test("skill-agent: {skill_name} substituted from the registry", async () => {
    if (skillAgent === undefined) { return; }
    const spec = AGENTS[skillAgent].prompt;
    if (spec.kind !== "line-anchored" || spec.skillName === undefined) { return; }
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: skillAgent }));
    expect(prompt).toContain(`Load skill \`${spec.skillName}\` via Skill tool.`);
    expect(prompt).not.toContain("{skill_name}");
  });

  test("subsystem: {subsystem_name} + {failure_modes} substituted from the registry", async () => {
    if (subsystemAgent === undefined) { return; }
    const spec = AGENTS[subsystemAgent].prompt;
    if (spec.kind !== "line-anchored" || spec.subsystemName === undefined) { return; }
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: subsystemAgent }));
    expect(prompt).toContain(`framed as the **${spec.subsystemName}** reviewer`);
    if (spec.failureModes !== undefined) {
      expect(prompt).toContain(spec.failureModes);
    }
    expect(prompt).not.toContain("{subsystem_name}");
    expect(prompt).not.toContain("{failure_modes}");
  });

  test("empty trust boundaries → 'none'", async () => {
    if (plainLineAnchored === undefined) { return; }
    const prompt = await run(
      renderAgentPrompt({ ...baseInput, trustBoundaries: [], agent: plainLineAnchored }),
    );
    expect(prompt).toContain("Trust boundaries: none");
  });

  test("previous_findings_block substituted on re-review", async () => {
    if (plainLineAnchored === undefined) { return; }
    const prevBlock = "## Previous-pass findings — verify resolution\n- src/foo.ts:42 …";
    const prompt = await run(
      renderAgentPrompt({ ...baseInput, previousFindingsBlock: prevBlock, agent: plainLineAnchored }),
    );
    expect(prompt).toContain(prevBlock);
    expect(prompt).not.toContain("{previous_findings_block}");
  });
});

describe("renderAgentPrompt — self-contained", () => {
  test("self-contained skips the line-anchored scaffold", async () => {
    if (selfContainedAgent === undefined) { return; }
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: selfContainedAgent }));
    expect(prompt).toContain("# kirby-bot per-agent review session");
    expect(prompt).toContain("VERDICT: AGENT_DONE");
    // The line-anchored scaffold's "Context verification" section MUST NOT leak in.
    expect(prompt).not.toContain("Context verification — drop the finding silently");
    expect(prompt).not.toContain("{diff_file}");
  });
});

describe("renderAgentPrompt — failure modes", () => {
  test("unknown agent fails with RenderError", async () => {
    const exit = await Effect.runPromiseExit(
      renderAgentPrompt({
        ...baseInput,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agent: "does-not-exist" as any,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("missing template dir fails with RenderError", async () => {
    if (plainLineAnchored === undefined) { return; }
    const exit = await Effect.runPromiseExit(
      renderAgentPrompt({ ...baseInput, templatesDir: "/nonexistent/path", agent: plainLineAnchored }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
