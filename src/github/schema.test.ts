import { Schema } from "effect";
import { describe, expect, it } from "bun:test";
import { IssueSchema, PullRequestSchema } from "./schema";

describe("IssueSchema", () => {
  it("decodes a real GitHub issue JSON sample, mapping number→iid and body→description", () => {
    const parsed = Schema.decodeUnknownSync(IssueSchema)({
      number: 42,
      title: "Add the GitHub boundary",
      body: "see the spec",
      labels: [{ name: "bug" }, { name: "agent-ready" }],
      updated_at: "2026-05-29T10:00:00Z",
    });
    expect(parsed.iid).toBe(42);
    expect(parsed.description).toBe("see the spec");
    expect(parsed.labels).toEqual(["bug", "agent-ready"]);
    expect(parsed.updated_at).toBe("2026-05-29T10:00:00Z");
  });

  it("defaults labels to [] and description to null when absent", () => {
    const parsed = Schema.decodeUnknownSync(IssueSchema)({ number: 7, title: "hello" });
    expect(parsed.labels).toEqual([]);
    expect(parsed.description).toBeNull();
  });

  it("keeps the pull_request object so PRs can be filtered out of the issue listing", () => {
    const parsed = Schema.decodeUnknownSync(IssueSchema)({
      number: 9,
      title: "a PR surfacing in the issues feed",
      pull_request: { url: "https://api.github.com/repos/o/r/pulls/9" },
    });
    expect(parsed.pull_request).toBeDefined();
  });

  it("rejects when number is missing", () => {
    expect(() => Schema.decodeUnknownSync(IssueSchema)({ title: "hello" })).toThrow(
      /\bnumber\b[\s\S]*is missing/,
    );
  });
});

describe("PullRequestSchema", () => {
  it("decodes a PR JSON sample with draft:true and head.sha present", () => {
    const parsed = Schema.decodeUnknownSync(PullRequestSchema)({
      number: 12,
      draft: true,
      merged: false,
      state: "open",
      node_id: "PR_kwDOABCD",
      head: { sha: "deadbeef" },
      html_url: "https://github.com/o/r/pull/12",
    });
    expect(parsed.iid).toBe(12);
    expect(parsed.draft).toBe(true);
    expect(parsed.state).toBe("open");
    expect(parsed.node_id).toBe("PR_kwDOABCD");
    expect(parsed.head.sha).toBe("deadbeef");
  });

  it("defaults draft/merged/html_url when absent", () => {
    const parsed = Schema.decodeUnknownSync(PullRequestSchema)({
      number: 13,
      state: "closed",
      node_id: "PR_x",
      head: { sha: "abc" },
    });
    expect(parsed.draft).toBe(false);
    expect(parsed.merged).toBe(false);
    expect(parsed.html_url).toBe("");
  });

  it("rejects an unknown state value instead of coercing it", () => {
    expect(() =>
      Schema.decodeUnknownSync(PullRequestSchema)({
        number: 1,
        state: "merging",
        node_id: "PR_x",
        head: { sha: "abc" },
      }),
    ).toThrow(/merging/);
  });
});
