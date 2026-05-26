import { describe, expect, test } from "bun:test";
import { AGENT_MODELS, getAgentModel } from "./agent-models";

describe("AGENT_MODELS — tier sanity", () => {
  test("Funnel L1/L2 → haiku (structural prose, no line-anchoring)", () => {
    expect(getAgentModel("funnel-l1")).toBe("haiku");
    expect(getAgentModel("funnel-l2")).toBe("haiku");
  });

  test("Correctness / Tests / Occam → sonnet (heavy reasoning)", () => {
    expect(getAgentModel("correctness")).toBe("sonnet");
    expect(getAgentModel("tests")).toBe("sonnet");
    expect(getAgentModel("occam-razor")).toBe("sonnet");
  });

  test("General Opus → opus", () => {
    expect(getAgentModel("general-opus")).toBe("opus");
  });

  test("Light skill (ui-ux, tailwind, i18n) → haiku", () => {
    expect(getAgentModel("ui-ux")).toBe("haiku");
    expect(getAgentModel("tailwind")).toBe("haiku");
    expect(getAgentModel("i18n")).toBe("haiku");
  });

  test("Heavy skill (security-defensive, language-typescript, drizzle-orm) → sonnet", () => {
    expect(getAgentModel("security-defensive")).toBe("sonnet");
    expect(getAgentModel("language-typescript")).toBe("sonnet");
    expect(getAgentModel("drizzle-orm")).toBe("sonnet");
  });

  test("All subsystem agents → sonnet", () => {
    expect(getAgentModel("billing-subsystem")).toBe("sonnet");
    expect(getAgentModel("auth-subsystem")).toBe("sonnet");
    expect(getAgentModel("webhook-subsystem")).toBe("sonnet");
  });

  test("Materiality → haiku (textual lift)", () => {
    expect(getAgentModel("claude-md-materiality")).toBe("haiku");
  });

  test("only haiku/sonnet/opus values present", () => {
    const valid = new Set(["haiku", "sonnet", "opus"]);
    for (const [agent, model] of Object.entries(AGENT_MODELS)) {
      expect(valid.has(model)).toBe(true);
      // Tag the assertion failure with the offending agent name.
      if (!valid.has(model)) throw new Error(`bad model for ${agent}: ${model}`);
    }
  });
});
