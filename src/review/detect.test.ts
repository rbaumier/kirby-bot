import { describe, expect, test } from "bun:test";
import { type ChangedFile, computeTier, detectReviewPlan } from "./detect";

/** Build a `ChangedFile` with sensible defaults for tests. */
const file = (overrides: Partial<ChangedFile> & { path: string }): ChangedFile => ({
  ext: overrides.path.split(".").pop() ?? "",
  lineCount: 10,
  content: "",
  imports: [],
  ...overrides,
});

describe("detectReviewPlan — tier classification", () => {
  test("Lite tier on tiny non-high-stakes diff", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/foo.ts", lineCount: 20 })],
    });
    expect(plan.tier).toBe("lite");
    expect(plan.agents).toContain("funnel-l1");
    expect(plan.agents).toContain("coding-standards");
    // Lite drops the umbrella subs, matt-, opus generalist, security-defensive.
    expect(plan.agents).not.toContain("matt-review");
    expect(plan.agents).not.toContain("security-defensive");
    expect(plan.agents).not.toContain("coding-standards:style");
    // Lite drops every conditional spawn — no language-typescript despite .ts.
    expect(plan.agents).not.toContain("language-typescript");
  });

  test("Full tier when file_count > 5", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file({ path: `src/f${i}.ts`, lineCount: 5 }),
    );
    const plan = detectReviewPlan({ files });
    expect(plan.tier).toBe("full");
    expect(plan.agents).toContain("matt-review");
    expect(plan.agents).toContain("language-typescript");
  });

  test("Full tier when total_lines > 50", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/big.ts", lineCount: 51 })],
    });
    expect(plan.tier).toBe("full");
  });

  test("boundary: total_lines == TIER_LITE_MAX_LINES (50) stays Lite", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/edge.ts", lineCount: 50 })],
    });
    expect(plan.tier).toBe("lite");
  });

  test("boundary: file_count == TIER_LITE_MAX_FILES (5) stays Lite", () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      file({ path: `src/f${i}.ts`, lineCount: 5 }),
    );
    const plan = detectReviewPlan({ files });
    expect(plan.tier).toBe("lite");
  });

  test("Full tier on high-stakes path even when small", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/auth/login.ts", lineCount: 10 })],
    });
    expect(plan.tier).toBe("full");
    expect(plan.highStakes).toBe(true);
    expect(plan.agents).toContain("auth-subsystem");
  });

  test("forceFull override flips tiny Lite-eligible diff", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/foo.ts", lineCount: 5 })],
      forceFull: true,
    });
    expect(plan.tier).toBe("full");
  });
});

describe("detectReviewPlan — conditional spawns (Full tier)", () => {
  test("language-rust spawned for .rs files", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/main.rs", lineCount: 100 })],
    });
    expect(plan.agents).toContain("language-rust");
  });

  test("multiple language agents when extensions mix", () => {
    const plan = detectReviewPlan({
      files: [
        file({ path: "src/a.ts", lineCount: 60 }),
        file({ path: "src/b.rs", lineCount: 10 }),
        file({ path: "ui/c.vue", lineCount: 5 }),
      ],
    });
    expect(plan.agents).toContain("language-typescript");
    expect(plan.agents).toContain("language-rust");
    expect(plan.agents).toContain("vue");
  });

  test("import-skill trigger: drizzle-orm", () => {
    const plan = detectReviewPlan({
      files: [
        file({
          path: "src/db/schema.ts",
          lineCount: 100,
          imports: ["drizzle-orm"],
        }),
      ],
    });
    expect(plan.agents).toContain("drizzle-orm");
  });

  test("import-skill trigger: react via fallback content scan", () => {
    const plan = detectReviewPlan({
      files: [
        file({
          path: "ui/comp.tsx",
          lineCount: 100,
          content: `import React from "react"`,
        }),
      ],
    });
    expect(plan.agents).toContain("react");
  });

  test("surface trigger: api-design on /api/ path", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/api/users.ts", lineCount: 100 })],
    });
    expect(plan.agents).toContain("api-design");
  });

  test("surface trigger: ui-ux on /app/ + .tsx", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/app/page.tsx", lineCount: 100 })],
    });
    expect(plan.agents).toContain("ui-ux");
    expect(plan.agents).toContain("frontend");
  });

  test("subsystem: webhook by code-pattern", () => {
    const plan = detectReviewPlan({
      files: [
        file({
          path: "src/integrations/stripe-webhook.ts",
          lineCount: 100,
          content: `crypto.createHmac("sha256", secret)`,
        }),
      ],
    });
    expect(plan.agents).toContain("webhook-subsystem");
    expect(plan.highStakes).toBe(true);
  });

  test("subsystem: billing by path", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/billing/charge.ts", lineCount: 100 })],
    });
    expect(plan.agents).toContain("billing-subsystem");
  });
});

describe("detectReviewPlan — trust boundaries", () => {
  test("network boundary on fetch usage", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/foo.ts", lineCount: 100, content: `await fetch("https://…")` })],
    });
    expect(plan.trustBoundaries).toContain("network");
  });

  test("filesystem + process-exec when both signals present", () => {
    const plan = detectReviewPlan({
      files: [
        file({
          path: "src/foo.ts",
          lineCount: 100,
          content: `import { writeFile } from "fs/promises"; Bun.spawn(["ls"])`,
        }),
      ],
    });
    expect(plan.trustBoundaries).toContain("filesystem");
    expect(plan.trustBoundaries).toContain("process-exec");
  });

  test("trust boundaries computed for Lite tier too", () => {
    const plan = detectReviewPlan({
      files: [
        file({ path: "src/foo.ts", lineCount: 10, content: `JSON.parse(input)` }),
      ],
    });
    expect(plan.tier).toBe("lite");
    expect(plan.trustBoundaries).toContain("serialization");
  });

  test("no boundaries on a comment-only diff", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/foo.ts", lineCount: 10, content: `// hello world` })],
    });
    expect(plan.trustBoundaries).toEqual([]);
  });
});

describe("detectReviewPlan — dogfood gate", () => {
  test("web-ui category on .tsx under /app/", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/app/page.tsx", lineCount: 100 })],
    });
    expect(plan.dogfoodRequired).toBe(true);
    expect(plan.dogfoodSurfaces).toContain("web-ui");
  });

  test("http-api category on import 'fastify'", () => {
    const plan = detectReviewPlan({
      files: [
        file({
          path: "src/server.ts",
          lineCount: 100,
          imports: ["fastify"],
        }),
      ],
    });
    expect(plan.dogfoodSurfaces).toContain("http-api");
  });

  test("no dogfood requirement on a pure library diff", () => {
    const plan = detectReviewPlan({
      files: [file({ path: "src/util/format.ts", lineCount: 100 })],
    });
    expect(plan.dogfoodRequired).toBe(false);
    expect(plan.dogfoodSurfaces).toEqual([]);
  });
});

describe("detectReviewPlan — determinism", () => {
  test("agent list is deduplicated", () => {
    // Two files that would both trigger surface agents for /app/ — output must dedup.
    const plan = detectReviewPlan({
      files: [
        file({ path: "src/app/a.tsx", lineCount: 60 }),
        file({ path: "src/app/b.tsx", lineCount: 5 }),
      ],
    });
    const ui = plan.agents.filter((a) => a === "ui-ux");
    expect(ui).toHaveLength(1);
  });

  test("same input → same output (stable ordering)", () => {
    const input = {
      files: [
        file({ path: "src/foo.ts", lineCount: 60, imports: ["zod"] }),
        file({ path: "src/api/bar.ts", lineCount: 10 }),
      ],
    };
    const a = detectReviewPlan(input);
    const b = detectReviewPlan(input);
    expect(a.agents).toEqual(b.agents);
    expect(a.trustBoundaries).toEqual(b.trustBoundaries);
  });
});

describe("computeTier — pure rule on pre-computed totals", () => {
  const base = { totalLines: 10, fileCount: 1, highStakes: false, forceFull: false };

  test("Lite when every signal is below threshold", () => {
    expect(computeTier(base)).toBe("lite");
  });

  test("totalLines == 50 stays Lite (inclusive boundary)", () => {
    expect(computeTier({ ...base, totalLines: 50 })).toBe("lite");
  });

  test("totalLines == 51 flips to Full", () => {
    expect(computeTier({ ...base, totalLines: 51 })).toBe("full");
  });

  test("fileCount == 5 stays Lite (inclusive boundary)", () => {
    expect(computeTier({ ...base, fileCount: 5 })).toBe("lite");
  });

  test("fileCount == 6 flips to Full", () => {
    expect(computeTier({ ...base, fileCount: 6 })).toBe("full");
  });

  test("highStakes forces Full regardless of size", () => {
    expect(computeTier({ ...base, highStakes: true })).toBe("full");
  });

  test("forceFull overrides every other signal", () => {
    expect(computeTier({ ...base, forceFull: true })).toBe("full");
  });
});
