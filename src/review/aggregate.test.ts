/**
 * Aggregate.test.ts — integration of the line-resolution wiring: aggregateFindings
 * reads each agent's diff slice off disk and realigns line-anchored findings to
 * the verbatim snippet's real position before returning them.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { RunArtifacts } from "../run-artifacts";
import type { RunArtifactsShape } from "../run-artifacts";
import type { FanOutResult } from "../session/fanout";
import { aggregateFindings } from "./aggregate";
import type { ReviewAnalysis } from "./detect";

const emptyAnalysis: ReviewAnalysis = {
  trustBoundaries: [],
  dogfoodRequired: false,
  dogfoodSurfaces: [],
  totalLines: 0,
  fileCount: 0,
};

/** New-side: 10 `const a = 1;`, 11 `const target = compute();`. */
const SLICE = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,1 +10,2 @@
 const a = 1;
+const target = compute();
`;

const makeArtifacts = (): { layer: Layer.Layer<RunArtifacts>; events: Record<string, unknown>[] } => {
  const events: Record<string, unknown>[] = [];
  const layer = Layer.succeed(RunArtifacts, {
    dir: "/tmp/test",
    runId: "test",
    logPath: "/tmp/test/run.jsonl",
    sentinelPath: () => "",
    tmuxLogPath: () => "",
    promptFilePath: () => "",
    findingsPath: () => "",
    triagePath: () => "",
    sessionName: () => "",
    logEvent: (e) => {
      events.push(e);
      return Effect.void;
    },
  } satisfies RunArtifactsShape);
  return { layer, events };
};

/** Write a findings envelope + slice to a temp dir; return a one-agent FanOutResult. */
const fanOutWith = (
  findings: readonly Record<string, unknown>[],
  opts: { withSlice: boolean },
): FanOutResult => {
  const dir = mkdtempSync(join(tmpdir(), "kirby-aggregate-"));
  const findingsPath = join(dir, "findings.json");
  writeFileSync(findingsPath, JSON.stringify({ findings }));
  const slicePath = join(dir, "slice.patch");
  writeFileSync(slicePath, SLICE);
  return {
    analysis: emptyAnalysis,
    routes: [],
    routerTruncated: false,
    outcomes: [{ kind: "ok", agent: "correctness", findingsPath, totalMs: 1 }],
    fullDiffPath: slicePath,
    perAgentDiffPath: opts.withSlice ? new Map([["correctness", slicePath]]) : new Map(),
    okCount: 1,
    totalCount: 1,
  };
};

const run = (fanOut: FanOutResult, layer: Layer.Layer<RunArtifacts>) =>
  Effect.runPromise(
    aggregateFindings(fanOut, { issueIid: 42, iteration: 0 }).pipe(Effect.provide(layer)),
  );

const finding = (over: Record<string, unknown>) => ({
  file: "src/foo.ts",
  line: 1,
  severity: "bug",
  confidence: "high",
  signature: "sig",
  title: "t",
  analysis_chain: [],
  fix_prompt: "",
  ...over,
});

describe("aggregateFindings — line resolution wiring", () => {
  test("realigns a drifted finding against its slice and emits the drift event", async () => {
    const { layer, events } = makeArtifacts();
    const fanOut = fanOutWith(
      [finding({ line: 999, analysis_chain: ["`const target = compute();` — verbatim"] })],
      { withSlice: true },
    );
    const review = await run(fanOut, layer);
    expect(review.lineAnchoredFindings).toHaveLength(1);
    expect(review.lineAnchoredFindings[0]!.line).toBe(11);
    expect(review.lineAnchoredFindings[0]!.anchored).toBe(true);
    const event = events.find((e) => e.event === "review_line_resolution");
    expect(event).toMatchObject({ total: 1, resolved: 1, drifted: 1, unmatched: 0 });
  });

  test("degrades a snippet-not-in-diff finding to anchored:false", async () => {
    const { layer } = makeArtifacts();
    const fanOut = fanOutWith(
      [finding({ line: 5, analysis_chain: ["`ghost code never in the diff` — verbatim"] })],
      { withSlice: true },
    );
    const review = await run(fanOut, layer);
    expect(review.lineAnchoredFindings[0]!.anchored).toBe(false);
  });

  test("keeps the reported line, anchored, when the slice is missing", async () => {
    const { layer } = makeArtifacts();
    const fanOut = fanOutWith(
      [finding({ line: 7, analysis_chain: ["`const target = compute();` — verbatim"] })],
      { withSlice: false },
    );
    const review = await run(fanOut, layer);
    expect(review.lineAnchoredFindings[0]!.line).toBe(7);
    expect(review.lineAnchoredFindings[0]!.anchored).toBe(true);
  });
});
