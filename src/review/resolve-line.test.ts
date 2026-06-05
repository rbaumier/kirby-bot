import { describe, expect, test } from "bun:test";
import type { ParsedLineFinding } from "./aggregate";
import { applyResolutions, resolveLine } from "./resolve-line";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Single-file diff. New-side line numbers:
 *  40 `let ctx = build();`      (context)
 *  41 `let token = req.headers.get("X-Token").unwrap();` (added)
 *  42 `validate(token);`        (added)
 *  43 `done();`                 (context)
 */
const SINGLE_FILE_DIFF = `diff --git a/src/auth/session.rs b/src/auth/session.rs
index abc..def 100644
--- a/src/auth/session.rs
+++ b/src/auth/session.rs
@@ -40,2 +40,4 @@ fn handler() {
 let ctx = build();
+let token = req.headers.get("X-Token").unwrap();
+validate(token);
 done();
`;

/** Two-file diff. a.ts: 1 `const a = 1;` 2 `const aa = 2;` 3 `const z = 3;`.
 *  b.ts: 10 `const b = 1;` 11 `const bb = 2;`. */
const MULTI_FILE_DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const aa = 2;
 const z = 3;
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -10,1 +10,2 @@
 const b = 1;
+const bb = 2;
`;

const bullet = (code: string, comment = "verbatim") => `\`${code}\` — ${comment}`;

// ─── resolveLine ─────────────────────────────────────────────────────────────

describe("resolveLine — new-side matching", () => {
  test("matches an added line and recomputes the real line number", () => {
    const r = resolveLine({
      file: "src/auth/session.rs",
      snippet: bullet(`let token = req.headers.get("X-Token").unwrap();`),
      reportedLine: 99,
      diff: SINGLE_FILE_DIFF,
    });
    expect(r).toEqual({ kind: "resolved", line: 41 });
  });

  test("matches a context line (added + context both count as new-side)", () => {
    const r = resolveLine({
      file: "src/auth/session.rs",
      snippet: bullet("let ctx = build();"),
      reportedLine: 1,
      diff: SINGLE_FILE_DIFF,
    });
    expect(r).toEqual({ kind: "resolved", line: 40 });
  });

  test("matches a contiguous multi-line run and returns the first line", () => {
    const fenced = ["```rust", `let token = req.headers.get("X-Token").unwrap();`, "validate(token);", "```"].join("\n");
    const r = resolveLine({
      file: "src/auth/session.rs",
      snippet: fenced,
      reportedLine: 50,
      diff: SINGLE_FILE_DIFF,
    });
    expect(r).toEqual({ kind: "resolved", line: 41 });
  });

  test("normalizes whitespace and a leading `+` before matching", () => {
    const r = resolveLine({
      file: "src/auth/session.rs",
      snippet: bullet(`+let    token =  req.headers.get("X-Token").unwrap();`),
      reportedLine: 41,
      diff: SINGLE_FILE_DIFF,
    });
    expect(r).toEqual({ kind: "resolved", line: 41 });
  });
});

describe("resolveLine — multi-file scoping", () => {
  test("resolves against the finding's own file", () => {
    const r = resolveLine({
      file: "b.ts",
      snippet: bullet("const bb = 2;"),
      reportedLine: 1,
      diff: MULTI_FILE_DIFF,
    });
    expect(r).toEqual({ kind: "resolved", line: 11 });
  });

  test("a snippet that lives in another file is unmatched for this file", () => {
    const r = resolveLine({
      file: "a.ts",
      snippet: bullet("const bb = 2;"),
      reportedLine: 1,
      diff: MULTI_FILE_DIFF,
    });
    expect(r).toEqual({ kind: "unmatched" });
  });
});

describe("resolveLine — degradation policy", () => {
  test("snippet present in the file but not on the new side → unmatched (degrade to note)", () => {
    const r = resolveLine({
      file: "src/auth/session.rs",
      snippet: bullet("totally absent line of code"),
      reportedLine: 41,
      diff: SINGLE_FILE_DIFF,
    });
    expect(r).toEqual({ kind: "unmatched" });
  });

  test("a removed line is not on the new side → unmatched", () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -5,2 +5,1 @@
-let removed = old();
 keep();
`;
    const r = resolveLine({
      file: "x.ts",
      snippet: bullet("let removed = old();"),
      reportedLine: 5,
      diff,
    });
    expect(r).toEqual({ kind: "unmatched" });
  });

  test("file absent from the slice → kept (don't degrade on a missing slice)", () => {
    const r = resolveLine({
      file: "src/not-in-diff.ts",
      snippet: bullet("let token = whatever();"),
      reportedLine: 7,
      diff: SINGLE_FILE_DIFF,
    });
    expect(r).toEqual({ kind: "kept" });
  });

  test("empty diff → kept", () => {
    const r = resolveLine({
      file: "a.ts",
      snippet: bullet("const aa = 2;"),
      reportedLine: 2,
      diff: "",
    });
    expect(r).toEqual({ kind: "kept" });
  });
});

describe("resolveLine — non-quotable snippet", () => {
  test("empty analysis chain entry → kept (fallback to reported line)", () => {
    const r = resolveLine({ file: "a.ts", snippet: "", reportedLine: 2, diff: MULTI_FILE_DIFF });
    expect(r).toEqual({ kind: "kept" });
  });

  test("prose with no backtick-quoted code → kept", () => {
    const r = resolveLine({
      file: "a.ts",
      snippet: "the function returns the wrong value here",
      reportedLine: 2,
      diff: MULTI_FILE_DIFF,
    });
    expect(r).toEqual({ kind: "kept" });
  });
});

describe("resolveLine — ambiguous match", () => {
  test("picks the candidate closest to the reported line", () => {
    const diff = `diff --git a/d.ts b/d.ts
--- a/d.ts
+++ b/d.ts
@@ -1,1 +1,3 @@
+dup();
+dup();
 end();
`;
    expect(resolveLine({ file: "d.ts", snippet: bullet("dup();"), reportedLine: 2, diff })).toEqual({
      kind: "resolved",
      line: 2,
    });
    expect(resolveLine({ file: "d.ts", snippet: bullet("dup();"), reportedLine: 1, diff })).toEqual({
      kind: "resolved",
      line: 1,
    });
  });
});

// ─── applyResolutions ────────────────────────────────────────────────────────

const parsed = (over: Partial<ParsedLineFinding>): ParsedLineFinding => ({
  agent: "correctness",
  file: "a.ts",
  line: 1,
  severity: "bug",
  confidence: "high",
  signature: "sig",
  title: "t",
  analysisChain: [],
  fixPrompt: "",
  ...over,
});

describe("applyResolutions", () => {
  test("realigns a drifted line, flags it anchored, and records the drift", () => {
    const findings = [
      parsed({ file: "a.ts", line: 99, analysisChain: [bullet("const aa = 2;")] }),
    ];
    const { findings: out, stats } = applyResolutions(
      findings,
      new Map([["correctness", MULTI_FILE_DIFF]]),
    );
    expect(out[0]!.line).toBe(2);
    expect(out[0]!.anchored).toBe(true);
    expect(stats).toMatchObject({ total: 1, resolved: 1, drifted: 1, unmatched: 0 });
    expect(stats.drifts[0]).toMatchObject({ file: "a.ts", reportedLine: 99, resolvedLine: 2 });
  });

  test("a resolved-but-already-correct line is not counted as drift", () => {
    const findings = [parsed({ file: "a.ts", line: 2, analysisChain: [bullet("const aa = 2;")] })];
    const { stats } = applyResolutions(findings, new Map([["correctness", MULTI_FILE_DIFF]]));
    expect(stats).toMatchObject({ resolved: 1, drifted: 0 });
  });

  test("an unmatched finding is flagged anchored:false (degraded to note)", () => {
    const findings = [parsed({ file: "a.ts", line: 1, analysisChain: [bullet("ghost code")] })];
    const { findings: out, stats } = applyResolutions(
      findings,
      new Map([["correctness", MULTI_FILE_DIFF]]),
    );
    expect(out[0]!.anchored).toBe(false);
    expect(stats).toMatchObject({ resolved: 0, unmatched: 1 });
  });

  test("a missing diff slice keeps the reported line, anchored", () => {
    const findings = [parsed({ file: "a.ts", line: 7, analysisChain: [bullet("const aa = 2;")] })];
    const { findings: out, stats } = applyResolutions(findings, new Map());
    expect(out[0]!.line).toBe(7);
    expect(out[0]!.anchored).toBe(true);
    expect(stats).toMatchObject({ resolved: 0, drifted: 0, unmatched: 0 });
  });
});
