/**
 * Summary.test.ts — render a synthetic run.jsonl into the markdown report:
 * header, 4-way fate counters, per-issue table (MR/tokens/cost are "—" by
 * design), the run-level cost table, and the documented-limits footer.
 */
import { describe, expect, it } from "bun:test";
import { type RunCostTotals, renderRunSummary } from "./summary";

const j = (at: string, obj: Record<string, unknown>): string =>
  JSON.stringify({ at, ...obj });

const RUN_LINES = [
  j("2026-05-31T10:00:00.000Z", {
    event: "run_start",
    repo: "kirby-bot",
    defaultBranch: "main",
  }),
  // #42 → done
  j("2026-05-31T10:00:02.000Z", {
    event: "transition",
    from: "implementation",
    to: "open_draft_mr",
    elapsedMs: 2000,
    issue: { iid: 42, title: "Add X" },
  }),
  j("2026-05-31T10:00:05.000Z", {
    event: "transition",
    from: "review",
    to: "fix",
    elapsedMs: 3000,
    issue: { iid: 42, title: "Add X" },
  }),
  j("2026-05-31T10:00:05.400Z", {
    event: "transition",
    from: "fix",
    to: "review",
    elapsedMs: 400,
    issue: { iid: 42, title: "Add X" },
  }),
  j("2026-05-31T10:00:09.400Z", {
    event: "transition",
    from: "qa",
    to: "merge",
    elapsedMs: 4000,
    issue: { iid: 42, title: "Add X" },
  }),
  j("2026-05-31T10:00:10.000Z", {
    event: "transition",
    from: "merge",
    to: "done",
    elapsedMs: 600,
    issue: { iid: 42, title: "Add X" },
    pullRequestIid: 1234,
  }),
  // #43 → stalled (projection collapses this to "incomplete"; the scan keeps it)
  j("2026-05-31T10:00:30.000Z", {
    event: "transition",
    from: "implementation",
    to: "stalled",
    elapsedMs: 5000,
    issue: { iid: 43, title: "Broken Y" },
  }),
  "{ torn line skipped",
  j("2026-05-31T10:05:00.000Z", { event: "run_end" }),
];

describe("renderRunSummary", () => {
  const cost: RunCostTotals = {
    totalCostUsd: 1.2345,
    perModel: [
      {
        tier: "opus",
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 500,
        costUsd: 1.0,
      },
      {
        tier: "haiku",
        inputTokens: 3000,
        outputTokens: 100,
        cacheReadTokens: 0,
        costUsd: 0.2345,
      },
    ],
  };
  const md = renderRunSummary({
    runId: "2026-05-31_10-00-00-000Z-abc123",
    lines: RUN_LINES,
    cost,
  });

  it("renders the header with repo, branch, run id, date and wall-clock duration", () => {
    expect(md).toContain("# Run summary — kirby-bot (main)");
    expect(md).toContain("**Run ID :** 2026-05-31_10-00-00-000Z-abc123");
    expect(md).toContain("**Date :** 2026-05-31 10:00");
    expect(md).toContain("**Durée totale :** 5m00s");
  });

  it("counts issues by 4-way fate (stalled survives the projection collapse)", () => {
    expect(md).toContain(
      "**Issues :** 2 — 1 done, 0 failed, 1 stalled, 0 interrupted, 0 incomplete",
    );
  });

  it("renders per-issue rows: PR iid in MR column, '—' for tokens/cost", () => {
    expect(md).toContain("| #42 | Add X | done | 10.0s | 1 | #1234 | — | — |");
    expect(md).toContain("| #43 | Broken Y | stalled | 5.0s | 0 | — | — | — |");
  });

  it("renders the run-level cost table with a bold total", () => {
    expect(md).toContain("| opus | 1,000 | 2,000 | 500 | $1.00 |");
    expect(md).toContain("| haiku | 3,000 | 100 | 0 | $0.23 |");
    expect(md).toContain("| **Total** | | | | **$1.23** |");
  });

  it("documents the per-issue cost limit and the MR-iid (not URL) caveat", () => {
    expect(md).toContain("Coût/tokens **par issue** non attribués");
    expect(md).toContain("La colonne **MR** montre l'iid");
  });

  it("falls back to '—' totals when no transcript cost is available", () => {
    const noCost = renderRunSummary({
      runId: "r",
      lines: RUN_LINES,
      cost: null,
    });
    expect(noCost).toContain("Aucun transcript Claude trouvé");
    expect(noCost).toContain("**Total : —**");
  });

  it("handles an empty run (no issues, no timestamps) without throwing", () => {
    const empty = renderRunSummary({ runId: "r", lines: [], cost: null });
    expect(empty).toContain("# Run summary — ? (?)");
    expect(empty).toContain("**Date :** —");
    expect(empty).toContain("**Durée totale :** —");
    expect(empty).toContain("**Issues :** 0 — 0 done");
    expect(empty).toContain("_Aucune issue traitée dans ce run._");
  });

  it("falls back to the projection's terminal for an issue with no terminal transition", () => {
    const midFlight = [
      j("2026-05-31T10:00:00.000Z", { event: "run_start", repo: "r", defaultBranch: "main" }),
      j("2026-05-31T10:00:02.000Z", { event: "transition", from: "implementation", to: "review", elapsedMs: 2000, issue: { iid: 7, title: "WIP" } }),
    ];
    const md2 = renderRunSummary({ runId: "r", lines: midFlight, cost: null });
    expect(md2).toContain("| #7 | WIP | incomplete | 2.0s | 0 | — | — | — |");
    expect(md2).toContain("**Issues :** 1 — 0 done, 0 failed, 0 stalled, 0 interrupted, 1 incomplete");
  });
});
