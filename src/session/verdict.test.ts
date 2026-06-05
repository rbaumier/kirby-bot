import { describe, expect, it } from "bun:test";
import { containsVerdictLine, parseVerdict, VERDICT_TOKENS } from "./verdict";

describe("parseVerdict", () => {
  it("extracts a verdict that is the last line", () => {
    expect(parseVerdict("did the work\nVERDICT: READY_FOR_REVIEW")).toBe("READY_FOR_REVIEW");
  });

  it("parses the plan-gate PLAN_DONE verdict (#75)", () => {
    expect(parseVerdict("plan approved\nVERDICT: PLAN_DONE")).toBe("PLAN_DONE");
  });

  for (const token of VERDICT_TOKENS) {
    it(`accepts known token ${token}`, () => {
      expect(parseVerdict(`summary line\nVERDICT: ${token}`)).toBe(token);
    });
  }

  it("ignores trailing blank / whitespace-only lines after the verdict", () => {
    expect(parseVerdict("done\nVERDICT: CONVERGED\n\n  \n")).toBe("CONVERGED");
  });

  it("tolerates trailing whitespace on the verdict line itself", () => {
    expect(parseVerdict("done\nVERDICT: FIX_DONE   ")).toBe("FIX_DONE");
  });

  it("returns null when there is no verdict line", () => {
    expect(parseVerdict("I think the work is done now.")).toBeNull();
  });

  it("does not match a token mentioned inside prose", () => {
    expect(parseVerdict("it is not yet READY_FOR_REVIEW so I keep going")).toBeNull();
  });

  it("accepts a verdict followed by trailing chatty prose (real #34 case)", () => {
    // The model sometimes ignores the prompt's "nothing after it" rule and
    // appends an MR pleasantry. The verdict line itself is well-formed and
    // unique — accept it instead of failing a complete implementation.
    expect(parseVerdict("VERDICT: READY_FOR_REVIEW\nMR !613 ouvert")).toBe("READY_FOR_REVIEW");
  });

  it("accepts a verdict wrapped in markdown bold (real #34 case)", () => {
    // Captured in prod: `MR créée : **https://...** --- **VERDICT: READY_FOR_REVIEW**`.
    expect(parseVerdict("MR créée\n---\n**VERDICT: READY_FOR_REVIEW**")).toBe("READY_FOR_REVIEW");
  });

  it("accepts a verdict wrapped in markdown italic underscores", () => {
    expect(parseVerdict("done\n__VERDICT: CONVERGED__")).toBe("CONVERGED");
  });

  it("returns null on multiple verdict lines (ambiguous)", () => {
    expect(parseVerdict("VERDICT: NEEDS_FIX\nVERDICT: CONVERGED")).toBeNull();
  });

  it("returns null on a well-formed line carrying an unknown token", () => {
    expect(parseVerdict("VERDICT: ALL_GOOD")).toBeNull();
  });

  it("requires the exact 'VERDICT: ' prefix", () => {
    expect(parseVerdict("verdict: CONVERGED")).toBeNull();
    expect(parseVerdict("VERDICT:CONVERGED")).toBeNull();
    expect(parseVerdict("  VERDICT: CONVERGED")).toBe("CONVERGED");
  });

  it("returns null on an empty message", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("   \n  \n")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    expect(parseVerdict("did work\r\nVERDICT: CONVERGED\r\n")).toBe("CONVERGED");
  });

  it("returns null when a standalone VERDICT line also appears earlier", () => {
    expect(parseVerdict("VERDICT: NEEDS_FIX\nmore text\nVERDICT: CONVERGED")).toBeNull();
  });

  it("returns null on trailing content after the token on the verdict line", () => {
    expect(parseVerdict("done\nVERDICT: CONVERGED now")).toBeNull();
  });
});

describe("containsVerdictLine", () => {
  it("is true for a well-formed verdict line", () => {
    expect(containsVerdictLine("done\nVERDICT: READY_FOR_REVIEW")).toBe(true);
  });

  it("is true even for an unknown token — validity is parseVerdict's job", () => {
    // The Stop hook must still capture `VERDICT: DONE` so parseVerdict can
    // reject the bad token and the orchestrator reprompts, rather than the
    // hook silently dropping the agent's (malformed) attempt.
    expect(containsVerdictLine("VERDICT: DONE")).toBe(true);
    expect(parseVerdict("VERDICT: DONE")).toBeNull();
  });

  it("is true for a markdown-wrapped verdict line", () => {
    expect(containsVerdictLine("MR créée\n**VERDICT: READY_FOR_REVIEW**")).toBe(true);
  });

  it("is true when two verdict lines appear (ambiguous for parse, present for capture)", () => {
    // parseVerdict refuses to guess, but the line IS present — the hook should
    // still prefer this message over a verdict-less trailing one.
    expect(containsVerdictLine("VERDICT: NEEDS_FIX\nVERDICT: CONVERGED")).toBe(true);
    expect(parseVerdict("VERDICT: NEEDS_FIX\nVERDICT: CONVERGED")).toBeNull();
  });

  it("is false for prose that merely mentions a token", () => {
    expect(containsVerdictLine("it is not yet READY_FOR_REVIEW so I keep going")).toBe(false);
  });

  it("is false for empty or whitespace-only text", () => {
    expect(containsVerdictLine("")).toBe(false);
    expect(containsVerdictLine("   \n  \n")).toBe(false);
  });
});
