import { describe, expect, test } from "bun:test";
import { AGENTS, ALL_AGENT_NAMES, getAgentModel, isAgentName } from "./agents";

const VALID_MODELS = new Set(["haiku", "sonnet", "opus", "fable"]);

// These tests assert invariants over WHATEVER subset of agents is active in
// AGENTS_DATA — they never name a specific agent. Commenting a row out (the
// supported on/off switch) must not break them: only `AgentName` consumers
// with a hardcoded reference should fail to compile, and there are none here.
describe("AGENTS — registry invariants", () => {
  test("registry is non-empty", () => {
    expect(ALL_AGENT_NAMES.length).toBeGreaterThan(0);
  });

  test("every agent's model is one of haiku/sonnet/opus/fable", () => {
    for (const name of ALL_AGENT_NAMES) {
      expect(VALID_MODELS.has(AGENTS[name].model)).toBe(true);
    }
  });

  test("getAgentModel agrees with the registry for every agent", () => {
    for (const name of ALL_AGENT_NAMES) {
      expect(getAgentModel(name)).toBe(AGENTS[name].model);
    }
  });

  test("every agent carries a non-empty router description", () => {
    for (const name of ALL_AGENT_NAMES) {
      expect(AGENTS[name].description.trim().length).toBeGreaterThan(0);
    }
  });

  test("every agent has a usable prompt spec", () => {
    for (const name of ALL_AGENT_NAMES) {
      const spec = AGENTS[name].prompt;
      const file = spec.kind === "self-contained" ? spec.templateFile : spec.roleFile;
      expect(file.length).toBeGreaterThan(0);
    }
  });
});

describe("isAgentName", () => {
  test("true for every registered agent", () => {
    for (const name of ALL_AGENT_NAMES) {
      expect(isAgentName(name)).toBe(true);
    }
  });

  test("false for an unregistered name", () => {
    expect(isAgentName("does-not-exist")).toBe(false);
    expect(isAgentName("")).toBe(false);
  });
});
