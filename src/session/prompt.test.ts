/**
 * Prompt.test.ts — the unresolved-placeholder guard must validate the template's
 * own `{placeholder}` tokens, never the injected replacement values. An issue
 * body can carry `${column}`-style template literals inside code spans (issue
 * #32); those are data, not unresolved template variables.
 */
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { renderPrompt } from "./prompt";

const RUN_IMPL_KEYS = {
  iid: "578",
  title: "Sort dispatch",
  branch: "kirby/578-sort",
  worktree: "/tmp/kirby-test-worktree",
  body: "(no description)",
};

describe("renderPrompt", () => {
  it("does not flag ${…} literals in a replacement value as unresolved (#32)", async () => {
    const rendered = await Effect.runPromise(
      renderPrompt("implementation", {
        ...RUN_IMPL_KEYS,
        body: "Sort dispatch uses exhaustive `switch` on `${column}:${direction}`",
      }),
    );
    expect(rendered).toContain("${column}:${direction}");
  });

  it("still fails when one of the template's own placeholders has no replacement", async () => {
    const { body: _omitted, ...withoutBody } = RUN_IMPL_KEYS;
    const error = await Effect.runPromise(renderPrompt("implementation", withoutBody).pipe(Effect.flip));
    expect(error._tag).toBe("PromptError");
    expect(error.reason).toContain("{body}");
  });
});
