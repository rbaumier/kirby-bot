/**
 * Review/diff-slices.ts — write per-agent diff slices to disk.
 *
 * Each fan-out agent gets its own diff slice — a `git diff` filtered to just
 * the files the agent is scoped to — so its prompt's `{diff_file}` placeholder
 * points at a tight per-agent patch instead of the full cross-cutting diff.
 * Measured on the upstream `code-review` skill: ~30× less diff payload per
 * agent, same agent count.
 *
 * Scoping is driven by each agent's `triggers` in `./agents.ts`. An agent
 * with no triggers (Funnel L1/L2, Correctness, Tests, generalist passes)
 * receives the full diff. An agent with triggers receives only the files
 * that match its triggers.
 *
 * Slices are written atomically: write to `<path>.tmp`, then rename — so a
 * fan-out reader never picks up a half-written patch.
 */
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Data, Effect } from "effect";
import { describeShellError, runShell } from "../shell";
import { AGENTS, type AgentName, hasTriggers } from "./agents";
import type { ChangedFile, ReviewPlan } from "./detect";

/** Failure when a diff slice cannot be written. */
export class DiffSliceError extends Data.TaggedError("DiffSliceError")<{
  readonly agent: AgentName | "full";
  readonly reason: string;
}> {}

/**
 * Return the file paths the given agent is scoped to, or `null` to mean
 * "full file set" (the agent gets the full diff).
 *
 * An agent with no `triggers` always returns `null` — that covers Funnel
 * L1/L2 (need cross-file view), Correctness, Tests, Occam Razor, and every
 * always-spawn generalist pass.
 *
 * An agent with triggers returns the files that match any trigger field
 * (OR across extensions / pathFragments / imports / codePatterns). Import
 * matching falls back to a content substring scan when the import-extraction
 * step missed a spec.
 */
export const agentScope = (
  agent: AgentName,
  files: ReadonlyArray<ChangedFile>,
): ReadonlyArray<string> | null => {
  if (!hasTriggers(agent)) return null;
  const triggers = AGENTS[agent].triggers;
  if (triggers === undefined) return null;
  const exts = triggers.extensions ?? [];
  const paths = triggers.pathFragments ?? [];
  const imports = triggers.imports ?? [];
  const codePatterns = triggers.codePatterns ?? [];
  return files
    .filter(
      (file) =>
        (exts.length > 0 && exts.includes(file.ext)) ||
        (paths.length > 0 && paths.some((frag) => file.path.includes(frag))) ||
        (imports.length > 0 &&
          imports.some(
            (needle) =>
              file.imports.some((spec) => spec.includes(needle)) ||
              file.content.includes(needle),
          )) ||
        (codePatterns.length > 0 &&
          codePatterns.some((needle) => file.content.includes(needle))),
    )
    .map((file) => file.path);
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

    // Group agents into "needs slice" vs "use full".
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
