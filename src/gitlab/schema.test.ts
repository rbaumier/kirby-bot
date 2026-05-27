import { Schema } from "effect";
import { describe, expect, it } from "bun:test";
import { IssueSchema, MR_STATES, MergeRequestSchema } from "./schema";

// Matches Effect Schema's `["iid"] is missing` decode error — pins each
// rejection test to the iid field so a future schema change that rejects
// for an unrelated reason still fails loudly.
const MISSING_IID_ERROR = /\biid\b[\s\S]*is missing/;

describe("MergeRequestSchema", () => {
  for (const state of MR_STATES) {
    it(`parses state ${state}`, () => {
      const parsed = Schema.decodeUnknownSync(MergeRequestSchema)({ iid: 1, state });
      expect(parsed.state).toBe(state);
    });
  }

  it("rejects an unknown state value instead of coercing it", () => {
    expect(() =>
      Schema.decodeUnknownSync(MergeRequestSchema)({ iid: 1, state: "merging" }),
    ).toThrow(/merging/);
  });

  it("rejects a missing state field instead of defaulting it", () => {
    expect(() => Schema.decodeUnknownSync(MergeRequestSchema)({ iid: 1 })).toThrow(
      /\bstate\b[\s\S]*is missing/,
    );
  });

  it("rejects when iid is missing", () => {
    expect(() => Schema.decodeUnknownSync(MergeRequestSchema)({ state: "opened" })).toThrow(
      MISSING_IID_ERROR,
    );
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
    expect(() => Schema.decodeUnknownSync(IssueSchema)({ title: "hello" })).toThrow(
      MISSING_IID_ERROR,
    );
  });
});
