import { describe, expect, it } from "bun:test";
import { toDiscussionSummary } from "./discussion";

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
