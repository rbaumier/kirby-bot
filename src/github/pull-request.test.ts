import { describe, expect, it } from "bun:test";
import { __test } from "./pull-request";

const { findOpenQuery, needsReadyMutation, mergeMethod } = __test;

describe("findOpenQuery", () => {
  // The `head` filter only matches when given the `owner:branch` form, not the
  // bare branch name — get this wrong and the listing silently returns nothing.
  it("builds the head=owner:branch filter for an open PR", () => {
    expect(findOpenQuery("acme", "feat/x")).toEqual({
      head: "acme:feat/x",
      state: "open",
      per_page: 1,
    });
  });
});

describe("needsReadyMutation", () => {
  // An already-ready (non-draft) PR must skip the GraphQL mutation — flipping a
  // ready PR to ready again is a wasted round-trip the orchestrator avoids.
  it("is false when the PR is already non-draft", () => {
    expect(needsReadyMutation(false)).toBe(false);
  });

  it("is true while the PR is still a draft", () => {
    expect(needsReadyMutation(true)).toBe(true);
  });
});

describe("mergeMethod", () => {
  // The merge endpoint takes `merge_method`; squash is the bot's default.
  it("requests a squash merge when squash is true", () => {
    expect(mergeMethod(true)).toBe("squash");
  });

  it("requests a plain merge otherwise", () => {
    expect(mergeMethod(false)).toBe("merge");
  });
});
