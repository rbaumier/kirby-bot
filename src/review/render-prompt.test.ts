import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
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

describe("renderAgentPrompt — kirby-bot preamble", () => {
  test("every prompt is prefixed with the kirby-bot preamble + VERDICT marker", async () => {
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: "correctness" }));
    expect(prompt).toStartWith("# kirby-bot per-agent review session");
    expect(prompt).toContain("Do NOT use the Task / Agent tool.");
    expect(prompt).toContain("VERDICT: AGENT_DONE");
    expect(prompt).toContain("/tmp/findings-agent.json");
  });

  test("self-contained agent also gets the preamble", async () => {
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: "funnel-l1" }));
    expect(prompt).toContain("# kirby-bot per-agent review session");
    expect(prompt).toContain("VERDICT: AGENT_DONE");
  });
});

describe("renderAgentPrompt — line-anchored", () => {
  test("correctness: scaffold + role body, trust_boundaries filled", async () => {
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: "correctness" }));
    // Scaffold sentinel
    expect(prompt).toContain("Read diff from /tmp/diff-slice.patch");
    expect(prompt).toContain("filtered to src/auth/login.ts, src/auth/session.ts");
    // Role body sentinel
    expect(prompt).toContain("You hunt bugs.");
    expect(prompt).toContain("Trust boundaries: auth, user-input");
    // Placeholder never leaks in raw form
    expect(prompt).not.toContain("{trust_boundaries}");
    expect(prompt).not.toContain("{diff_file}");
    expect(prompt).not.toContain("{role_specific}");
  });

  test("skill-agent (language-typescript): {skill_name} substituted", async () => {
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: "language-typescript" }));
    expect(prompt).toContain("Load skill `language-typescript` via Skill tool.");
    expect(prompt).not.toContain("{skill_name}");
  });

  test("subsystem (billing): {subsystem_name} + {failure_modes} substituted", async () => {
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: "billing-subsystem" }));
    expect(prompt).toContain("framed as the **billing** reviewer");
    expect(prompt).toContain("idempotency");
    expect(prompt).not.toContain("{subsystem_name}");
    expect(prompt).not.toContain("{failure_modes}");
  });

  test("empty trust boundaries → 'none'", async () => {
    const prompt = await run(
      renderAgentPrompt({ ...baseInput, trustBoundaries: [], agent: "correctness" }),
    );
    expect(prompt).toContain("Trust boundaries: none");
  });

  test("previous_findings_block substituted on re-review", async () => {
    const prevBlock = "## Previous-pass findings — verify resolution\n- src/foo.ts:42 …";
    const prompt = await run(
      renderAgentPrompt({ ...baseInput, previousFindingsBlock: prevBlock, agent: "correctness" }),
    );
    expect(prompt).toContain(prevBlock);
    expect(prompt).not.toContain("{previous_findings_block}");
  });
});

describe("renderAgentPrompt — self-contained", () => {
  test("funnel-l1: role template + substitutions, no scaffold", async () => {
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: "funnel-l1" }));
    expect(prompt).toContain("Review code for necessity and completeness.");
    expect(prompt).toContain("Read the diff from /tmp/diff-slice.patch");
    // The line-anchored scaffold's "Context verification" section MUST NOT leak in.
    expect(prompt).not.toContain("Context verification — drop the finding silently");
  });

  test("matt-review: self-contained template", async () => {
    const prompt = await run(renderAgentPrompt({ ...baseInput, agent: "matt-review" }));
    expect(prompt).toContain("VERDICT: AGENT_DONE");
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
    const exit = await Effect.runPromiseExit(
      renderAgentPrompt({ ...baseInput, templatesDir: "/nonexistent/path", agent: "correctness" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
