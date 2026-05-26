import { describe, expect, test } from "bun:test";
import { analyzeReviewInputs, type ChangedFile } from "./detect";

/** Build a `ChangedFile` with sensible defaults for tests. */
const file = (overrides: Partial<ChangedFile> & { path: string }): ChangedFile => ({
  ext: overrides.path.split(".").pop() ?? "",
  lineCount: 10,
  content: "",
  imports: [],
  ...overrides,
});

describe("analyzeReviewInputs — trust boundaries", () => {
  test("network boundary on fetch usage", () => {
    const analysis = analyzeReviewInputs([
      file({ path: "src/foo.ts", lineCount: 100, content: `await fetch("https://…")` }),
    ]);
    expect(analysis.trustBoundaries).toContain("network");
  });

  test("filesystem + process-exec when both signals present", () => {
    const analysis = analyzeReviewInputs([
      file({
        path: "src/foo.ts",
        lineCount: 100,
        content: `import { writeFile } from "fs/promises"; Bun.spawn(["ls"])`,
      }),
    ]);
    expect(analysis.trustBoundaries).toContain("filesystem");
    expect(analysis.trustBoundaries).toContain("process-exec");
  });

  test("serialization boundary on JSON.parse", () => {
    const analysis = analyzeReviewInputs([
      file({ path: "src/foo.ts", lineCount: 10, content: `JSON.parse(input)` }),
    ]);
    expect(analysis.trustBoundaries).toContain("serialization");
  });

  test("no boundaries on a comment-only diff", () => {
    const analysis = analyzeReviewInputs([
      file({ path: "src/foo.ts", lineCount: 10, content: `// hello world` }),
    ]);
    expect(analysis.trustBoundaries).toEqual([]);
  });

  test("database boundary picked from import specifier", () => {
    const analysis = analyzeReviewInputs([
      file({ path: "src/db.ts", lineCount: 10, imports: ["drizzle-orm"] }),
    ]);
    expect(analysis.trustBoundaries).toContain("database");
  });
});

describe("analyzeReviewInputs — dogfood gate", () => {
  test("web-ui category on .tsx under /app/", () => {
    const analysis = analyzeReviewInputs([
      file({ path: "src/app/page.tsx", lineCount: 100 }),
    ]);
    expect(analysis.dogfoodRequired).toBe(true);
    expect(analysis.dogfoodSurfaces).toContain("web-ui");
  });

  test("http-api category on import 'fastify'", () => {
    const analysis = analyzeReviewInputs([
      file({ path: "src/server.ts", lineCount: 100, imports: ["fastify"] }),
    ]);
    expect(analysis.dogfoodSurfaces).toContain("http-api");
  });

  test("cli category on /bin/ path", () => {
    const analysis = analyzeReviewInputs([
      file({ path: "src/bin/run.ts", lineCount: 50 }),
    ]);
    expect(analysis.dogfoodSurfaces).toContain("cli");
  });

  test("no dogfood requirement on a pure library diff", () => {
    const analysis = analyzeReviewInputs([
      file({ path: "src/util/format.ts", lineCount: 100 }),
    ]);
    expect(analysis.dogfoodRequired).toBe(false);
    expect(analysis.dogfoodSurfaces).toEqual([]);
  });
});

describe("analyzeReviewInputs — totals", () => {
  test("totalLines sums every file's lineCount", () => {
    const analysis = analyzeReviewInputs([
      file({ path: "a.ts", lineCount: 10 }),
      file({ path: "b.ts", lineCount: 5 }),
      file({ path: "c.ts", lineCount: 80 }),
    ]);
    expect(analysis.totalLines).toBe(95);
    expect(analysis.fileCount).toBe(3);
  });

  test("zero files → zero totals", () => {
    const analysis = analyzeReviewInputs([]);
    expect(analysis.totalLines).toBe(0);
    expect(analysis.fileCount).toBe(0);
    expect(analysis.trustBoundaries).toEqual([]);
    expect(analysis.dogfoodRequired).toBe(false);
  });
});

describe("analyzeReviewInputs — determinism", () => {
  test("same input → same output", () => {
    const input = [
      file({ path: "src/foo.ts", lineCount: 60, imports: ["zod"] }),
      file({ path: "src/api/bar.ts", lineCount: 10, imports: ["fastify"] }),
    ];
    const a = analyzeReviewInputs(input);
    const b = analyzeReviewInputs(input);
    expect(a.trustBoundaries).toEqual(b.trustBoundaries);
    expect(a.dogfoodSurfaces).toEqual(b.dogfoodSurfaces);
    expect(a.totalLines).toBe(b.totalLines);
  });
});
