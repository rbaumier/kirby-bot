import { describe, expect, it } from "bun:test";
import { __test } from "./pull-request";

const { findOpenQuery, mergeMethod } = __test;

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

describe("mergeMethod", () => {
  // The merge endpoint takes `merge_method`; squash is the bot's default.
  it("requests a squash merge when squash is true", () => {
    expect(mergeMethod(true)).toBe("squash");
  });

  it("requests a plain merge otherwise", () => {
    expect(mergeMethod(false)).toBe("merge");
  });
});
