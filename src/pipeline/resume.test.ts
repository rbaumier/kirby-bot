/**
 * Resume.test.ts — the pure Phase-resume routing (#73).
 *
 * No fs, no provider: just (from, next) → which checkpoint, and checkpoint →
 * which resumed State. Pins the downgrade guard (the `branch_push → open_draft_mr`
 * resume edge must NOT overwrite a more-advanced checkpoint) and the
 * fix-cycle-preserving routing.
 */
import { describe, expect, test } from "bun:test";
import { checkpointAfter, resumeStateFor } from "./resume";
import type { PipelineContext, State } from "./state";

const issue = { iid: 1, title: "t", body: "" };
const ctx: PipelineContext = {
  issue,
  branch: "afk/issue-1",
  worktree: "/w",
  deadline: 1_000,
  pullRequestIid: 9,
};
const openDraftMr: State = {
  kind: "open_draft_mr",
  issue,
  branch: "afk/issue-1",
  worktree: "/w",
  deadline: 1_000,
};

describe("checkpointAfter", () => {
  test("implementation → open_draft_mr marks implementation finished", () => {
    const from: State = {
      kind: "implementation",
      issue,
      branch: "afk/issue-1",
      worktree: "/w",
      plan: "approved approach",
    };
    expect(checkpointAfter(from, openDraftMr)).toEqual({ phase: "open_draft_mr", fixCycles: 0 });
  });

  test("branch_push → open_draft_mr (resume skip) writes nothing — no downgrade", () => {
    const from: State = { kind: "branch_push", issue, branch: "afk/issue-1", worktree: "/w" };
    expect(checkpointAfter(from, openDraftMr)).toBeNull();
  });

  test("entering an interactive Phase records the Phase and its fix-cycle count", () => {
    expect(checkpointAfter(openDraftMr, { kind: "review", ...ctx, fixCycles: 0 })).toEqual({
      phase: "review",
      fixCycles: 0,
    });
    expect(checkpointAfter({ kind: "fix", ...ctx, fixCycles: 1 }, { kind: "review", ...ctx, fixCycles: 2 })).toEqual({
      phase: "review",
      fixCycles: 2,
    });
  });

  test("entering merge writes nothing (no resumable checkpoint)", () => {
    expect(checkpointAfter({ kind: "qa", ...ctx, fixCycles: 0 }, { kind: "merge", ...ctx })).toBeNull();
  });

  test("queue and terminal transitions write nothing", () => {
    expect(checkpointAfter({ kind: "fetch_queue" }, { kind: "claim_issue", issue })).toBeNull();
  });
});

describe("resumeStateFor", () => {
  test("no checkpoint → review from scratch", () => {
    expect(resumeStateFor(null, ctx)).toEqual({ kind: "review", ...ctx, fixCycles: 0 });
  });

  test("implementation-finished marker → review from scratch", () => {
    expect(resumeStateFor({ phase: "open_draft_mr", fixCycles: 0 }, ctx)).toEqual({
      kind: "review",
      ...ctx,
      fixCycles: 0,
    });
  });

  test("evaluate checkpoint → resume evaluate with its fix-cycle count", () => {
    expect(resumeStateFor({ phase: "evaluate", fixCycles: 1 }, ctx)).toEqual({
      kind: "evaluate",
      ...ctx,
      fixCycles: 1,
    });
  });

  test("fix checkpoint → resume fix", () => {
    expect(resumeStateFor({ phase: "fix", fixCycles: 2 }, ctx)).toEqual({
      kind: "fix",
      ...ctx,
      fixCycles: 2,
    });
  });

  test("qa checkpoint → resume qa", () => {
    expect(resumeStateFor({ phase: "qa", fixCycles: 0 }, ctx)).toEqual({
      kind: "qa",
      ...ctx,
      fixCycles: 0,
    });
  });
});
