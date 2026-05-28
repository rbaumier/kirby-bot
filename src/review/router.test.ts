import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  _parseRouterOutput,
  _renderAgentCatalog,
  _renderFileRoster,
  ROUTER_DIFF_MAX_BYTES,
  RouterMalformedOutput,
  truncateDiff,
} from "./router";
import { AGENTS, ALL_AGENT_NAMES } from "./agents";
import type { ChangedFile } from "./detect";

describe("truncateDiff", () => {
  test("returns input untouched when under the cap", () => {
    const small = "diff --git a/x b/x\n+small\n";
    const { text, truncated } = truncateDiff(small);
    expect(text).toBe(small);
    expect(truncated).toBe(false);
  });

  test("truncates a single oversized file", () => {
    const huge = `diff --git a/x b/x\n${"+padding\n".repeat(100_000)}`;
    const { text, truncated } = truncateDiff(huge, 1_024);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_024);
    expect(text).toContain("[truncated by kirby-bot router]");
  });

  test("splits the budget equitably across files", () => {
    const fileA = `diff --git a/a b/a\n${"+a\n".repeat(10_000)}`;
    const fileB = `diff --git a/b b/b\n${"+b\n".repeat(10_000)}`;
    const fileC = `diff --git a/c b/c\n${"+c\n".repeat(10_000)}`;
    const { text, truncated } = truncateDiff(fileA + fileB + fileC, 3_000);
    expect(truncated).toBe(true);
    expect(text).toContain("diff --git a/a b/a");
    expect(text).toContain("diff --git a/b b/b");
    expect(text).toContain("diff --git a/c b/c");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(3_000);
  });

  test("respects default cap constant", () => {
    expect(ROUTER_DIFF_MAX_BYTES).toBeGreaterThan(0);
    const huge = `diff --git a/x b/x\n${"+x\n".repeat(60_000)}`;
    const { truncated } = truncateDiff(huge);
    expect(truncated).toBe(true);
  });
});

describe("_parseRouterOutput", () => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSyncExit(effect);

  test("valid JSON with known agents parses to RoutedAgent[]", () => {
    const raw = JSON.stringify({
      agents: [
        { name: "funnel", files: [] },
        { name: "language-rust", files: ["src/a.rs", "src/b.rs"] },
      ],
    });
    const exit = run(_parseRouterOutput(raw));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toHaveLength(2);
      expect(exit.value[0]).toEqual({ name: "funnel", files: [] });
      expect(exit.value[1]).toEqual({
        name: "language-rust",
        files: ["src/a.rs", "src/b.rs"],
      });
    }
  });

  test("empty input fails with RouterMalformedOutput", () => {
    const exit = run(_parseRouterOutput("   "));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = (exit.cause as { error: unknown }).error ?? exit.cause;
      expect(String((error as { _tag?: string })?._tag ?? "")).toBe("RouterMalformedOutput");
    }
  });

  test("invalid JSON fails with RouterMalformedOutput", () => {
    const exit = run(_parseRouterOutput("not json"));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("missing 'agents' field fails with RouterMalformedOutput", () => {
    const exit = run(_parseRouterOutput(JSON.stringify({ other: [] })));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("empty agents array fails with RouterMalformedOutput", () => {
    const exit = run(_parseRouterOutput(JSON.stringify({ agents: [] })));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("unknown agent name fails with RouterMalformedOutput", async () => {
    const result = await Effect.runPromiseExit(
      _parseRouterOutput(
        JSON.stringify({ agents: [{ name: "no-such-agent", files: [] }] }),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
  });

  test("non-array files fails with RouterMalformedOutput", () => {
    const exit = run(
      _parseRouterOutput(
        JSON.stringify({ agents: [{ name: "funnel", files: "src/a.ts" }] }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("non-string file entry fails with RouterMalformedOutput", () => {
    const exit = run(
      _parseRouterOutput(
        JSON.stringify({ agents: [{ name: "funnel", files: [42] }] }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("error class fingerprint stable", () => {
    const m = new RouterMalformedOutput({ reason: "x", raw: "" });
    expect(m._tag).toBe("RouterMalformedOutput");
  });
});

describe("_renderAgentCatalog", () => {
  // Asserts over whatever subset of agents is active — never names one.
  test("emits exactly one line per active agent, with its name + description", () => {
    const out = _renderAgentCatalog();
    const lines = out.split("\n").filter((line) => line !== "");
    const agentCount = ALL_AGENT_NAMES.length;
    expect(lines).toHaveLength(agentCount);
    for (const name of ALL_AGENT_NAMES) {
      expect(out).toContain(`- \`${name}\`: ${AGENTS[name].description}`);
    }
  });
});

describe("_renderFileRoster", () => {
  const file = (overrides: Partial<ChangedFile> & { path: string }): ChangedFile => ({
    ext: overrides.path.split(".").at(-1) ?? "",
    lineCount: 10,
    content: "",
    imports: [],
    ...overrides,
  });

  test("renders path · ext · line count · imports", () => {
    const out = _renderFileRoster([
      file({ path: "src/a.ts", lineCount: 42, imports: ["drizzle-orm", "zod"] }),
    ]);
    expect(out).toContain("src/a.ts");
    expect(out).toContain(".ts");
    expect(out).toContain("42 lines");
    expect(out).toContain("drizzle-orm");
    expect(out).toContain("zod");
  });

  test("omits the imports suffix when none", () => {
    const out = _renderFileRoster([file({ path: "x.ts" })]);
    expect(out).not.toContain("imports:");
  });

  test("caps imports to 10 to keep the prompt tight", () => {
    const imports = Array.from({ length: 25 }, (_, i) => `pkg-${i}`);
    const out = _renderFileRoster([file({ path: "x.ts", imports })]);
    expect(out).toContain("pkg-0");
    expect(out).toContain("pkg-9");
    expect(out).not.toContain("pkg-15");
  });
});
