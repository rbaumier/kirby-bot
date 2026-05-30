/**
 * Evaluate phase — triage_results invariant tests.
 *
 * Since suggestion findings are no longer posted as resolvable discussions
 * (handled in post.ts), the evaluator session never sees them and never writes
 * them to triage.json. These tests document that invariant by verifying the
 * parseTriageFile contract: only entries present in the file appear in
 * triage_results.
 */
import { describe, expect, test } from "bun:test";
import { parseTriageFile } from "../stats/events";

describe("evaluate phase — suggestions absent from triage_results", () => {
  test("triage file with only actionable entries yields no punt rows", () => {
    const content = JSON.stringify([
      { discussionId: "abc", triage: "real" },
      { discussionId: "def", triage: "imagined" },
      { discussionId: "ghi", triage: "real-but-bloated-remedy" },
    ]);
    const rows = parseTriageFile(content);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.triage !== "punt")).toBe(true);
  });

  test("empty triage file yields no triage_results data", () => {
    const rows = parseTriageFile("[]");
    expect(rows).toHaveLength(0);
  });

  test("triage file without suggestions still produces correct triage entries", () => {
    const content = JSON.stringify([
      { discussionId: "d1", triage: "real" },
      { discussionId: "d2", triage: "imagined" },
    ]);
    const rows = parseTriageFile(content);
    const ids = rows.map((r) => r.discussionId);
    expect(ids).toContain("d1");
    expect(ids).toContain("d2");
    expect(rows.find((r) => r.discussionId === "d1")?.triage).toBe("real");
    expect(rows.find((r) => r.discussionId === "d2")?.triage).toBe("imagined");
  });
});
