import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { IssueSchema, MR_STATES, MergeRequestSchema } from "./schema";

describe("MergeRequestSchema", () => {
  it.each(MR_STATES)("parses state %s", (state) => {
    const parsed = Schema.decodeUnknownSync(MergeRequestSchema)({ iid: 1, state });
    expect(parsed.state).toBe(state);
  });

  it('defaults state to "opened" when the field is absent', () => {
    const parsed = Schema.decodeUnknownSync(MergeRequestSchema)({ iid: 1 });
    expect(parsed.state).toBe("opened");
  });

  it("rejects an unknown state value", () => {
    expect(() => Schema.decodeUnknownSync(MergeRequestSchema)({ iid: 1, state: "draft" })).toThrow(/transformation failure|is missing|Expected/);
  });

  it("rejects when iid is missing", () => {
    expect(() => Schema.decodeUnknownSync(MergeRequestSchema)({ state: "opened" })).toThrow(/transformation failure|is missing|Expected/);
  });
});

describe("IssueSchema", () => {
  it("defaults labels to [] when the field is absent", () => {
    const parsed = Schema.decodeUnknownSync(IssueSchema)({ iid: 7, title: "hello" });
    expect(parsed.labels).toEqual([]);
  });

  it("preserves labels when provided", () => {
    const parsed = Schema.decodeUnknownSync(IssueSchema)({
      iid: 7,
      title: "hello",
      labels: ["bug", "urgent"],
    });
    expect(parsed.labels).toEqual(["bug", "urgent"]);
  });

  it("defaults description to null when absent", () => {
    const parsed = Schema.decodeUnknownSync(IssueSchema)({ iid: 7, title: "hello" });
    expect(parsed.description).toBeNull();
  });

  it("rejects when iid is missing", () => {
    expect(() => Schema.decodeUnknownSync(IssueSchema)({ title: "hello" })).toThrow(/transformation failure|is missing|Expected/);
  });
});
