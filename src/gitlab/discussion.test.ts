import { describe, expect, it } from "bun:test";
import { ProviderHttpError, ProviderNetworkError } from "../provider/types";
import { __test, toDiscussionSummary } from "./discussion";

const { isLineNotAnchorable } = __test;

const httpError = (status: number, body: string) =>
  new ProviderHttpError({ method: "POST", path: "discussions", status, body });

describe("isLineNotAnchorable", () => {
  it("matches a 400 whose body names the line/position — the unanchorable case", () => {
    expect(isLineNotAnchorable(httpError(400, '{"message":["line_code can\'t be blank"]}'))).toBe(
      true,
    );
    expect(isLineNotAnchorable(httpError(400, "Note position is invalid"))).toBe(true);
  });

  it("does NOT match a 400 from an unrelated payload error — so real bugs still surface", () => {
    expect(isLineNotAnchorable(httpError(400, '{"message":"base_sha is missing"}'))).toBe(false);
  });

  it("does NOT match other statuses (404/422/500) or non-HTTP errors", () => {
    expect(isLineNotAnchorable(httpError(404, "line not found"))).toBe(false);
    expect(isLineNotAnchorable(httpError(422, "line problem"))).toBe(false);
    expect(
      isLineNotAnchorable(new ProviderNetworkError({ method: "POST", path: "d", cause: "line" })),
    ).toBe(false);
  });
});

describe("toDiscussionSummary", () => {
  it("maps a resolved discussion", () => {
    const raw = {
      id: "abc",
      notes: [{ body: "finding", resolvable: true, resolved: true, author: { username: "afk" } }],
    };
    expect(toDiscussionSummary(raw)).toEqual({
      id: "abc",
      resolved: true,
      notes: [{ author: "afk", body: "finding" }],
    });
  });

  it("is unresolved when any resolvable note is unresolved", () => {
    const raw = {
      id: "x",
      notes: [
        { body: "a", resolvable: true, resolved: true, author: { username: "u" } },
        { body: "b", resolvable: true, resolved: false, author: { username: "u" } },
      ],
    };
    expect(toDiscussionSummary(raw).resolved).toBe(false);
  });

  it("treats a discussion with no resolvable notes as resolved (non-blocking)", () => {
    const raw = { id: "sys", notes: [{ body: "system note", resolvable: false, author: null }] };
    expect(toDiscussionSummary(raw).resolved).toBe(true);
  });

  it("falls back to 'unknown' for a missing author", () => {
    const raw = {
      id: "x",
      notes: [{ body: "b", resolvable: true, resolved: false, author: null }],
    };
    const notes = toDiscussionSummary(raw).notes;
    expect(notes).toHaveLength(1);
    expect(notes.at(0)?.author).toBe("unknown");
  });

  it("keeps every note (resolvable or not) in the summary", () => {
    const raw = {
      id: "x",
      notes: [
        { body: "root", resolvable: true, resolved: false, author: { username: "a" } },
        { body: "reply", resolvable: false, author: { username: "b" } },
      ],
    };
    expect(toDiscussionSummary(raw).notes).toHaveLength(2);
  });

  it("is unresolved when a resolvable note has no `resolved` key", () => {
    const raw = { id: "x", notes: [{ body: "b", resolvable: true, author: { username: "u" } }] };
    expect(toDiscussionSummary(raw).resolved).toBe(false);
  });

  it("handles garbage / empty input without throwing", () => {
    expect(toDiscussionSummary(null)).toEqual({ id: "", resolved: true, notes: [] });
    expect(toDiscussionSummary({})).toEqual({ id: "", resolved: true, notes: [] });
    expect(toDiscussionSummary({ id: 5, notes: "nope" })).toEqual({
      id: "5",
      resolved: true,
      notes: [],
    });
  });

  it("drops non-object note entries instead of throwing", () => {
    const raw = {
      id: "x",
      notes: [
        null,
        5,
        { body: "real", resolvable: true, resolved: true, author: { username: "u" } },
      ],
    };
    const summary = toDiscussionSummary(raw);
    expect(summary.notes).toEqual([{ author: "u", body: "real" }]);
    expect(summary.resolved).toBe(true);
  });
});
