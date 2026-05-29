import { Effect, Either } from "effect";
import { describe, expect, it } from "bun:test";
import { __test, updateIssueLabels } from "./issue";
import type { GitHubIssue } from "./schema";
import { ProviderHttpError } from "../provider/types";

const { filterIssues, isNotFound, swallowNotFound } = __test;

/** Build a decoded issue with sane defaults; override only what the test cares about. */
const issue = (over: Partial<GitHubIssue>): GitHubIssue => ({
  iid: 1,
  title: "t",
  description: null,
  labels: [],
  updated_at: "",
  pull_request: undefined,
  ...over,
});

describe("filterIssues", () => {
  // GitHub's issue list returns PRs too (a PR is an issue, carrying a
  // `pull_request` object); they must never reach the queue as issues.
  it("drops entries carrying a pull_request field", () => {
    const kept = issue({ iid: 1 });
    const pr = issue({ iid: 2, pull_request: { url: "x" } });
    expect(filterIssues([kept, pr], undefined)).toEqual([kept]);
  });

  // The REST list endpoint has no label-exclusion param, so exclusion is done
  // client-side after the fetch.
  it("removes issues bearing an exclude label", () => {
    const kept = issue({ iid: 1, labels: ["bug"] });
    const dropped = issue({ iid: 2, labels: ["bug", "wip"] });
    expect(filterIssues([kept, dropped], ["wip"])).toEqual([kept]);
  });
});

describe("updateIssueLabels", () => {
  // Both sides empty → return void without firing a request. Were the guard
  // broken, the call would hit the runner and fail in this env (no GitHub
  // config), so a clean `undefined` is proof no request was attempted.
  it("performs no request when both add and remove are empty", async () => {
    expect(await Effect.runPromise(updateIssueLabels(1, {}))).toBeUndefined();
    expect(await Effect.runPromise(updateIssueLabels(1, { add: [], remove: [] }))).toBeUndefined();
  });
});

describe("swallowNotFound", () => {
  const httpError = (status: number): ProviderHttpError =>
    new ProviderHttpError({ method: "DELETE", path: "p", status, body: "" });

  it("identifies a 404 and only a 404", () => {
    expect(isNotFound(httpError(404))).toBe(true);
    expect(isNotFound(httpError(500))).toBe(false);
  });

  // Deleting an already-absent label returns 404; the post-condition (label
  // gone) holds, so removal stays idempotent.
  it("swallows a 404 as success", async () => {
    expect(await Effect.runPromise(swallowNotFound(Effect.fail(httpError(404))))).toBeUndefined();
  });

  it("re-raises a non-404 error", async () => {
    const either = await Effect.runPromise(Effect.either(swallowNotFound(Effect.fail(httpError(500)))));
    expect(either).toMatchObject({ _tag: "Left", left: { _tag: "ProviderHttpError", status: 500 } });
  });
});
