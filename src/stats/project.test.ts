/**
 * Project.test.ts — the stats projection folds a synthetic run.jsonl into the
 * expected per-issue / per-agent numbers, exercising the discussionId join
 * across two iterations, the prose one-to-many row, and torn-line tolerance.
 */
import { describe, expect, it } from "bun:test";
import { projectRunStats } from "./project";

const j = (obj: Record<string, unknown>): string => JSON.stringify(obj);

const RUN_LINES = [
  j({ event: "run_start", repo: "kirby-bot", defaultBranch: "main" }),
  j({ event: "transition", from: "implementation", to: "open_draft_mr", elapsedMs: 2000, issue: { iid: 42, title: "Add X" } }),
  j({ event: "fanout_plan", phase: "review", iteration: 0, issueIid: 42, agents: ["correctness", "tests"], skippedAgents: ["security"], routerTruncated: false, trustBoundaries: ["auth"], dogfoodRequired: true, dogfoodSurfaces: ["cli"] }),
  j({ event: "fanout_complete", phase: "review", iteration: 0, issueIid: 42, okCount: 1, total: 2, outcomes: [{ agent: "correctness", kind: "ok", totalMs: 1200 }, { agent: "tests", kind: "error", totalMs: 500, reason: "timeout" }] }),
  j({ event: "review_findings", issueIid: 42, iteration: 0, findings: [{ discussionId: "d1", agent: "correctness", file: "a.ts", line: 10, severity: "bug" }, { discussionId: "d2", agent: "correctness", file: "b.ts", line: 20, severity: "suggestion" }], prose: { discussionId: "dp", byAgent: [{ agent: "tests", count: 2 }] } }),
  j({ event: "transition", from: "review", to: "evaluate", elapsedMs: 3000, issue: { iid: 42, title: "Add X" } }),
  j({ event: "triage_results", issueIid: 42, iteration: 0, triages: [{ discussionId: "d1", triage: "real" }, { discussionId: "d2", triage: "imagined" }, { discussionId: "dp", triage: "punt" }] }),
  j({ event: "transition", from: "evaluate", to: "fix", elapsedMs: 500, issue: { iid: 42, title: "Add X" } }),
  j({ event: "transition", from: "fix", to: "review", elapsedMs: 400, issue: { iid: 42, title: "Add X" } }),
  j({ event: "review_findings", issueIid: 42, iteration: 1, findings: [{ discussionId: "d3", agent: "correctness", file: "a.ts", line: 11, severity: "bug" }] }),
  j({ event: "transition", from: "review", to: "evaluate", elapsedMs: 2500, issue: { iid: 42, title: "Add X" } }),
  j({ event: "triage_results", issueIid: 42, iteration: 1, triages: [{ discussionId: "d3", triage: "real" }] }),
  j({ event: "transition", from: "evaluate", to: "qa", elapsedMs: 300, issue: { iid: 42, title: "Add X" } }),
  j({ event: "transition", from: "qa", to: "merge", elapsedMs: 4000, issue: { iid: 42, title: "Add X" } }),
  j({ event: "transition", from: "merge", to: "done", elapsedMs: 600, issue: { iid: 42, title: "Add X" } }),
  "{ this line is torn and should be skipped",
  j({ event: "run_end" }),
];

describe("projectRunStats", () => {
  const stats = projectRunStats(RUN_LINES);
  const issue = stats.issues.find((entry) => entry.iid === 42);

  it("captures run-level + issue-lifecycle facts", () => {
    expect(stats.repo).toBe("kirby-bot");
    expect(stats.defaultBranch).toBe("main");
    expect(issue).toBeDefined();
    expect(issue?.title).toBe("Add X");
    expect(issue?.totalMs).toBe(13_300);
    expect(issue?.fixCycles).toBe(1);
    expect(issue?.terminal).toBe("done");
    expect(issue?.qa).toBe("pass");
  });

  it("sums phase durations by the originating (`from`) phase", () => {
    const review = issue?.phaseDurations.find((phase) => phase.phase === "review");
    const evaluate = issue?.phaseDurations.find((phase) => phase.phase === "evaluate");
    expect(review?.ms).toBe(5500);
    expect(evaluate?.ms).toBe(800);
  });

  it("joins findings to triage per (issue, iteration) and attributes by agent", () => {
    const correctness = issue?.agents.find((agent) => agent.agent === "correctness");
    expect(correctness).toMatchObject({
      ran: 1,
      ok: 1,
      error: 0,
      totalMs: 1200,
      findings: 3, // d1 + d2 (iter0) + d3 (iter1)
      accepted: 2, // d1 real + d3 real
      rejected: 1, // d2 imagined
      punted: 0,
      untriaged: 0,
    });
  });

  it("attributes the collapsed prose thread to its agents with counts", () => {
    const tests = issue?.agents.find((agent) => agent.agent === "tests");
    expect(tests).toMatchObject({
      ran: 1,
      error: 1,
      findings: 2, // prose byAgent count
      punted: 2, // prose thread triaged as punt
      accepted: 0,
      rejected: 0,
    });
  });

  it("records routing + detection snapshots per iteration", () => {
    expect(issue?.routing).toHaveLength(1);
    expect(issue?.routing[0]).toMatchObject({
      iteration: 0,
      routed: ["correctness", "tests"],
      skipped: ["security"],
      trustBoundaries: ["auth"],
      dogfoodRequired: true,
      dogfoodSurfaces: ["cli"],
    });
  });

  it("counts a finding with no matching triage row as untriaged", () => {
    const stats2 = projectRunStats([
      j({ event: "review_findings", issueIid: 7, iteration: 0, findings: [{ discussionId: "x", agent: "skill", file: "f.ts", line: 1, severity: "bug" }] }),
    ]);
    const agent = stats2.issues[0]?.agents.find((a) => a.agent === "skill");
    expect(agent).toMatchObject({ findings: 1, untriaged: 1, accepted: 0, rejected: 0 });
  });
});
