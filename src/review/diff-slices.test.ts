import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "./detect";
import { agentScope } from "./diff-slices";

const file = (overrides: Partial<ChangedFile> & { path: string }): ChangedFile => ({
  ext: overrides.path.split(".").pop() ?? "",
  lineCount: 10,
  content: "",
  imports: [],
  ...overrides,
});

describe("agentScope — language", () => {
  test("language-typescript scopes to .ts/.tsx files", () => {
    const files = [
      file({ path: "src/a.ts" }),
      file({ path: "src/b.tsx" }),
      file({ path: "src/c.rs" }),
      file({ path: "README.md" }),
    ];
    const scope = agentScope("language-typescript", files);
    expect(scope).toEqual(["src/a.ts", "src/b.tsx"]);
  });

  test("language-rust scopes to .rs files", () => {
    const files = [file({ path: "src/main.rs" }), file({ path: "src/foo.ts" })];
    expect(agentScope("language-rust", files)).toEqual(["src/main.rs"]);
  });
});

describe("agentScope — skill-by-import", () => {
  test("drizzle-orm scopes to files importing drizzle-orm", () => {
    const files = [
      file({ path: "src/db/schema.ts", imports: ["drizzle-orm"] }),
      file({ path: "src/util/format.ts" }),
    ];
    expect(agentScope("drizzle-orm", files)).toEqual(["src/db/schema.ts"]);
  });

  test("react picks up files via content fallback", () => {
    const files = [
      file({ path: "ui/comp.tsx", content: `import React from "react"` }),
      file({ path: "src/util.ts" }),
    ];
    expect(agentScope("react", files)).toEqual(["ui/comp.tsx"]);
  });
});

describe("agentScope — subsystem", () => {
  test("billing-subsystem matches by path fragment", () => {
    const files = [
      file({ path: "src/billing/charge.ts" }),
      file({ path: "src/util/format.ts" }),
    ];
    expect(agentScope("billing-subsystem", files)).toEqual(["src/billing/charge.ts"]);
  });

  test("webhook-subsystem matches by code pattern", () => {
    const files = [
      file({ path: "src/x.ts", content: "crypto.createHmac('sha256', secret)" }),
      file({ path: "src/y.ts" }),
    ];
    expect(agentScope("webhook-subsystem", files)).toEqual(["src/x.ts"]);
  });
});

describe("agentScope — surface", () => {
  test("api-design matches by /api/ path", () => {
    const files = [
      file({ path: "src/api/users.ts" }),
      file({ path: "src/lib/helper.ts" }),
    ];
    expect(agentScope("api-design", files)).toEqual(["src/api/users.ts"]);
  });

  test("ui-ux matches by /app/ path + .tsx extension", () => {
    const files = [
      file({ path: "src/app/page.tsx" }),
      file({ path: "src/app/about.mdx" }),
      file({ path: "src/util.ts" }),
    ];
    expect(agentScope("ui-ux", files)).toEqual([
      "src/app/page.tsx",
      "src/app/about.mdx",
    ]);
  });
});

describe("agentScope — full diff agents", () => {
  test("funnel-l1 → null (full diff)", () => {
    expect(agentScope("funnel-l1", [file({ path: "any.ts" })])).toBeNull();
  });

  test("correctness → null (full diff)", () => {
    expect(agentScope("correctness", [file({ path: "any.ts" })])).toBeNull();
  });

  test("tests → null (full diff)", () => {
    expect(agentScope("tests", [file({ path: "any.ts" })])).toBeNull();
  });

  test("occam-razor → null (full diff)", () => {
    expect(agentScope("occam-razor", [file({ path: "any.ts" })])).toBeNull();
  });

  test("matt-review → null (full diff)", () => {
    expect(agentScope("matt-review", [file({ path: "any.ts" })])).toBeNull();
  });

  test("security-defensive → null (full diff)", () => {
    expect(agentScope("security-defensive", [file({ path: "any.ts" })])).toBeNull();
  });
});

describe("agentScope — empty scope edge cases", () => {
  test("language-rust with no .rs files → []", () => {
    expect(agentScope("language-rust", [file({ path: "src/a.ts" })])).toEqual([]);
  });

  test("zod with no zod imports → []", () => {
    expect(agentScope("zod", [file({ path: "src/a.ts" })])).toEqual([]);
  });
});
