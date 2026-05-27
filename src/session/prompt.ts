/**
 * Session/prompt.ts — load a phase's prompt template and fill its placeholders.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { Phase } from "../config";
import { PROMPTS_DIR } from "../config";
import { PromptError } from "./errors";

/**
 * Subset of {@link Phase} that uses the legacy single-prompt session loader.
 * `review` is excluded because the per-agent fan-out (Phase: Review) renders
 * its prompts via {@link renderAgentPrompt} from `src/review/render-prompt.ts`
 * — there is no monolithic `review.md` anymore.
 */
export type PromptablePhase = Exclude<Phase, "review">;

/** The template file backing each promptable phase. */
const TEMPLATE_FILE: Record<PromptablePhase, string> = {
  implementation: "implementation.md",
  evaluate: "evaluate.md",
  fix: "fix.md",
  qa: "qa.md",
};

/** A `{placeholder}` token — lowercase letters and underscores between braces. */
const PLACEHOLDER = /\{[a-z_]+\}/g;

/** Replace every `{key}` in `text` with the corresponding value. */
const applyReplacements = (
  text: string,
  entries: readonly (readonly [string, string])[],
): string => {
  let result = text;
  for (const [key, value] of entries) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
};

/**
 * Read the `phase` template and substitute every `{placeholder}`.
 *
 * Fails with {@link PromptError} if the template cannot be read,
 * or if any `{placeholder}` is left unresolved. A literal
 * `{worktree}` reaching the claude session would be a silently
 * wrong prompt, caught here instead.
 *
 * The unresolved check scans the *template*, not the rendered output:
 * a replacement value (e.g. an issue body) may legitimately contain
 * `${column}`-style template literals inside code spans, and those must
 * not be mistaken for template variables the engine failed to resolve.
 */
export const renderPrompt = (
  phase: PromptablePhase,
  replacements: Record<string, string>,
): Effect.Effect<string, PromptError> =>
  Effect.gen(function* () {
    const template = yield* Effect.tryPromise({
      try: () => readFile(join(PROMPTS_DIR, TEMPLATE_FILE[phase]), "utf8"),
      catch: (cause) =>
        new PromptError({
          phase,
          reason: `could not read the ${phase} template: ${String(cause)}`,
        }),
    });

    const provided = new Set(Object.keys(replacements));
    const unresolved = [...new Set(template.match(PLACEHOLDER) ?? [])].filter(
      (token) => !provided.has(token.slice(1, -1)),
    );
    if (unresolved.length > 0) {
      return yield* Effect.fail(
        new PromptError({
          phase,
          reason: `template has unresolved placeholders: ${unresolved.join(", ")}`,
        }),
      );
    }

    return applyReplacements(template, Object.entries(replacements));
  });
