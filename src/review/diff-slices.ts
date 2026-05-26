/**
 * Review/diff-slices.ts — write per-agent diff slices to disk.
 *
 * Each fan-out agent gets its own diff slice — a `git diff` filtered to just
 * the files the agent is scoped to — so its prompt's `{diff_file}` placeholder
 * points at a tight per-agent patch instead of the full cross-cutting diff.
 * Measured on the upstream `code-review` skill: ~30× less diff payload per
 * agent, same agent count.
 *
 * Some agents (Funnel L1/L2, Matt Review, Materiality, Thermo-nuclear, Occam
 * Razor, simplify, matt-improve-codebase-architecture, claude-md-compliance,
 * general-opus, security-defensive, coding-standards*, correctness, tests)
 * need the cross-file view: they receive the full diff. The split lives in
 * {@link agentScope} below.
 *
 * Slices are written atomically: write to `<path>.tmp`, then rename — so a
 * fan-out reader never picks up a half-written patch.
 */
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Data, Effect } from "effect";
import { describeShellError, runShell } from "../shell";
import type { ChangedFile } from "./detect";
import {
  type AgentName,
  IMPORT_SKILL_TRIGGERS,
  LANGUAGE_BY_EXT,
  SUBSYSTEM_TRIGGERS,
  SURFACE_TRIGGERS,
} from "./detect-tables";
import type { ReviewPlan } from "./detect";

/** Failure when a diff slice cannot be written. */
export class DiffSliceError extends Data.TaggedError("DiffSliceError")<{
  readonly agent: AgentName | "full";
  readonly reason: string;
}> {}

/**
 * Return the file paths a given agent is scoped to, or `null` to mean
 * "full file set" (the agent gets the full diff). Mirrors the upstream
 * `code-review` Step 0.2 scoping rules. Decisions:
 *
 *  - Language agents → files whose extension maps to that language.
 *  - Skill-by-import agents → files importing the lib OR mentioning it.
 *  - Surface agents → files matching the surface globs/extensions.
 *  - Subsystem agents → files matching the subsystem triggers.
 *  - Everything else → `null` (full diff). Includes Funnel L1/L2 (need
 *    cross-file view), Correctness, Tests, Occam Razor (greps repo
 *    anyway), and the various umbrella generalist passes.
 */
export const agentScope = (
  agent: AgentName,
  files: ReadonlyArray<ChangedFile>,
): ReadonlyArray<string> | null => {
  // Language by extension. Multiple extensions can map to the same language
  // agent (`.ts` + `.tsx` → `language-typescript`); union them.
  const languageExts = Object.entries(LANGUAGE_BY_EXT)
    .filter(([, mapped]) => mapped === agent)
    .map(([ext]) => ext);
  if (languageExts.length > 0) {
    return files.filter((file) => languageExts.includes(file.ext)).map((file) => file.path);
  }

  // Skill by import — matches the agent name to the trigger row.
  for (const row of IMPORT_SKILL_TRIGGERS) {
    if (row.agent !== agent) continue;
    return files
      .filter(
        (file) =>
          row.imports.some(
            (needle) =>
              file.imports.some((spec) => spec.includes(needle)) || file.content.includes(needle),
          ),
      )
      .map((file) => file.path);
  }

  // Subsystem.
  for (const row of SUBSYSTEM_TRIGGERS) {
    if (row.agent !== agent) continue;
    return files
      .filter((file) => {
        const pathHit = row.pathFragments.some((frag) => file.path.includes(frag));
        const importHit = row.imports.some(
          (needle) =>
            file.imports.some((spec) => spec.includes(needle)) || file.content.includes(needle),
        );
        const codeHit = row.codePatterns.some((pattern) => file.content.includes(pattern));
        return pathHit || importHit || codeHit;
      })
      .map((file) => file.path);
  }

  // Surface.
  for (const row of SURFACE_TRIGGERS) {
    if (!row.agents.includes(agent)) continue;
    return files
      .filter(
        (file) =>
          row.pathFragments.some((frag) => file.path.includes(frag)) ||
          row.extensions.includes(file.ext),
      )
      .map((file) => file.path);
  }

  // Everything else: full diff.
  return null;
};

/**
 * Run `git diff $defaultBranch...HEAD -- <files>` and write the output to
 * `outPath` atomically (via `.tmp` + rename).
 */
const writeGitDiff = (
  agent: AgentName | "full",
  defaultBranch: string,
  outPath: string,
  files: ReadonlyArray<string>,
): Effect.Effect<string, DiffSliceError> =>
  Effect.gen(function* () {
    const range = `${defaultBranch}...HEAD`;
    const tmpPath = `${outPath}.tmp`;
    const result = yield* runShell(() =>
      files.length === 0 ? $`git diff ${range}` : $`git diff ${range} -- ${files}`,
    ).pipe(
      Effect.mapError(
        (error) =>
          new DiffSliceError({
            agent,
            reason: `git diff failed — ${describeShellError(error)}`,
          }),
      ),
    );

    yield* Effect.tryPromise({
      try: () => writeFile(tmpPath, result.stdout),
      catch: (cause) =>
        new DiffSliceError({ agent, reason: `write tmp failed — ${String(cause)}` }),
    });
    yield* Effect.tryPromise({
      try: () => rename(tmpPath, outPath),
      catch: (cause) =>
        new DiffSliceError({ agent, reason: `rename failed — ${String(cause)}` }),
    });
    return outPath;
  });

/** Input for {@link writeDiffSlices}. */
export type WriteDiffSlicesInput = {
  readonly plan: ReviewPlan;
  readonly files: ReadonlyArray<ChangedFile>;
  readonly defaultBranch: string;
  /** Directory where slices land — must exist. */
  readonly slicesDir: string;
  /** Identifier embedded in slice filenames, e.g. `review-run` + iteration. */
  readonly slug: string;
};

/**
 * Result of {@link writeDiffSlices} — one path per agent in the plan.
 *
 * Agents whose scope = full file set share the path of the full diff
 * (`fullDiffPath`). The orchestrator writes one file once, every "full diff"
 * agent's prompt points at the same path. Saves N-1 `git diff` invocations
 * and N-1 patch files on disk.
 */
export type DiffSliceMap = {
  readonly fullDiffPath: string;
  readonly perAgent: ReadonlyMap<AgentName, string>;
};

/**
 * Write a diff slice per agent in `plan.agents`. Slices are computed in
 * parallel; the full diff is written once and reused by all "full-diff"
 * agents (no scope match).
 *
 * Returned map is keyed by agent name. Slices that contain zero files
 * (subsystem agent for a triggered code-pattern with no path hits — exotic)
 * fall back to the full diff path so the agent never receives an empty patch.
 */
export const writeDiffSlices = (
  input: WriteDiffSlicesInput,
): Effect.Effect<DiffSliceMap, DiffSliceError> =>
  Effect.gen(function* () {
    const fullDiffPath = join(input.slicesDir, `${input.slug}-full.patch`);
    yield* writeGitDiff("full", input.defaultBranch, fullDiffPath, []);

    // Group agents into "needs slice" vs "use full". Avoid writing slices for
    // agents whose scope IS the full file set — they reuse the full diff.
    const agentsNeedingSlice: Array<{ agent: AgentName; scope: ReadonlyArray<string> }> = [];
    const agentsUsingFull: AgentName[] = [];
    for (const agent of input.plan.agents) {
      const scope = agentScope(agent, input.files);
      if (scope === null || scope.length === 0) {
        agentsUsingFull.push(agent);
      } else {
        agentsNeedingSlice.push({ agent, scope });
      }
    }

    const sliceResults = yield* Effect.forEach(
      agentsNeedingSlice,
      ({ agent, scope }) => {
        const slicePath = join(input.slicesDir, `${input.slug}-${agent}.patch`);
        return writeGitDiff(agent, input.defaultBranch, slicePath, scope).pipe(
          Effect.map((path) => [agent, path] as const),
        );
      },
      { concurrency: "unbounded" },
    );

    const perAgent = new Map<AgentName, string>();
    for (const agent of agentsUsingFull) perAgent.set(agent, fullDiffPath);
    for (const [agent, path] of sliceResults) perAgent.set(agent, path);

    return { fullDiffPath, perAgent };
  });

