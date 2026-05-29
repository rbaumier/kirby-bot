import { describe, expect, it } from "bun:test";
import { parseFindingHeader, toDiscussionSummary } from "./discussion";

describe("parseFindingHeader", () => {
  it("extracts file and line from a real finding header", () => {
    expect(parseFindingHeader("severity: bug | src/x.ts:42\n\nbody")).toEqual({
      file: "src/x.ts",
      line: 42,
    });
  });

  it("returns null for the synthetic review-summary header", () => {
    expect(parseFindingHeader("severity: suggestion | review-summary:0")).toBeNull();
  });

  it("returns null for a malformed header", () => {
    expect(parseFindingHeader("not a header at all")).toBeNull();
    expect(parseFindingHeader("severity: bug | src/x.ts:notanumber")).toBeNull();
  });
});

describe("toDiscussionSummary", () => {
  it("maps a resolved review-thread node, mapping author.login to the note author", () => {
    const raw = {
      id: "PRRT_thread1",
      isResolved: true,
      comments: { nodes: [{ author: { login: "afk" }, body: "finding" }] },
    };
    expect(toDiscussionSummary(raw)).toEqual({
      id: "PRRT_thread1",
      resolved: true,
      notes: [{ author: "afk", body: "finding" }],
    });
  });

  it("reports an unresolved thread as resolved: false", () => {
    const raw = {
      id: "t",
      isResolved: false,
      comments: { nodes: [{ author: { login: "u" }, body: "b" }] },
    };
    expect(toDiscussionSummary(raw).resolved).toBe(false);
  });

  it("falls back to 'unknown' for a missing author", () => {
    const raw = { id: "t", isResolved: false, comments: { nodes: [{ body: "b", author: null }] } };
    const notes = toDiscussionSummary(raw).notes;
    expect(notes).toHaveLength(1);
    expect(notes.at(0)?.author).toBe("unknown");
  });

  it("handles garbage / empty input without throwing", () => {
    expect(toDiscussionSummary(null)).toEqual({ id: "", resolved: false, notes: [] });
    expect(toDiscussionSummary({})).toEqual({ id: "", resolved: false, notes: [] });
    expect(toDiscussionSummary({ id: 5, comments: "nope" })).toEqual({
      id: "5",
      resolved: false,
      notes: [],
    });
  });

  it("drops non-object comment nodes instead of throwing", () => {
    const raw = {
      id: "t",
      isResolved: true,
      comments: { nodes: [null, 5, { author: { login: "u" }, body: "real" }] },
    };
    const summary = toDiscussionSummary(raw);
    expect(summary.notes).toEqual([{ author: "u", body: "real" }]);
    expect(summary.resolved).toBe(true);
  });
});
