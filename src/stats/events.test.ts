/**
 * Events.test.ts — `parseTriageFile` is tolerant of LLM-written input: it must
 * never throw, drops rows it cannot key, and downgrades unknown verdicts.
 */
import { describe, expect, it } from "bun:test";
import { parseTriageFile } from "./events";

describe("parseTriageFile", () => {
  it("parses a well-formed array", () => {
    const rows = parseTriageFile(
      JSON.stringify([
        { discussionId: "a", triage: "real" },
        { discussionId: "b", triage: "imagined" },
        { discussionId: "c", triage: "punt" },
        { discussionId: "d", triage: "real-but-bloated-remedy" },
      ]),
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ discussionId: "a", triage: "real" });
  });

  it("keeps the intent verdict (not downgraded to unknown)", () => {
    const rows = parseTriageFile(JSON.stringify([{ discussionId: "a", triage: "intent" }]));
    expect(rows[0]).toEqual({ discussionId: "a", triage: "intent" });
  });

  it("downgrades an unrecognized triage value to unknown", () => {
    const rows = parseTriageFile(JSON.stringify([{ discussionId: "a", triage: "maybe" }]));
    expect(rows[0]).toEqual({ discussionId: "a", triage: "unknown" });
  });

  it("drops rows without a usable discussionId", () => {
    const rows = parseTriageFile(
      JSON.stringify([{ triage: "real" }, { discussionId: "", triage: "real" }, { discussionId: 7, triage: "real" }]),
    );
    expect(rows).toHaveLength(0);
  });

  it("returns [] for malformed JSON or a non-array", () => {
    expect(parseTriageFile("not json")).toEqual([]);
    expect(parseTriageFile(JSON.stringify({ discussionId: "a" }))).toEqual([]);
    expect(parseTriageFile("")).toEqual([]);
  });
});
