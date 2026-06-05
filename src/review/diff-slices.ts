/**
 * Review/diff-slices.ts — write per-agent diff slices to disk.
 *
 * Each fan-out agent gets its own diff slice — a `git diff` filtered to only
 * the files the router scoped it to — so its prompt's `{diff_file}` placeholder
 * points at a tight per-agent patch instead of the full cross-cutting diff.
 * Measured on the upstream `code-review` skill: ~30× less diff payload per
 * agent, same agent count.
 *
 * Scoping is driven by the routing pass in `./router.ts`. Each `RoutedAgent`
 * carries a list of files the router decided that agent should see:
 *  - `files: []` → the agent receives the full diff (Funnel L1/L2,
 *    Correctness, Matt Review, anything that needs the cross-file picture).
 *  - `files: [...]` → only those files (language/skill/subsystem agents).
 *
 * Slices are written atomically: write to `<path>.tmp`, then rename — so a
 * fan-out reader never picks up a half-written patch.
 */
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Data, Effect } from "effect";
import { GIT_READ_TIMEOUT_MS, MAX_DIFF_SLICE_BYTES } from "../config";
import { describeShellError, runShell, withShellRetry } from "../shell";
import type { AgentName } from "./agents";
import type { RoutedAgent } from "./router";

type AgentNameOrFull = AgentName | "full";

/** Failure when a diff slice cannot be written. */
export class DiffSliceError extends Data.TaggedError("DiffSliceError")<{
  readonly agent: AgentNameOrFull;
  readonly reason: string;
}> {}

/**
 * Truncate a diff payload to {@link MAX_DIFF_SLICE_BYTES}, appending a marker
 * so the reviewer knows bytes were dropped. Exported for testing.
 */
export const capDiffPayload = (raw: string): string => {
  const utf8Bytes = Buffer.byteLength(raw, "utf8");
  if (utf8Bytes <= MAX_DIFF_SLICE_BYTES) { return raw; }
  const truncated = Buffer.from(raw, "utf8").subarray(0, MAX_DIFF_SLICE_BYTES).toString("utf8");
  const omitted = utf8Bytes - Buffer.byteLength(truncated, "utf8");
  return `${truncated}\n\n[truncated by kirby-bot diff-slice cap: ${omitted} bytes omitted of ${utf8Bytes} total]\n`;
};

/**
 * Run `git -C <worktree> diff $defaultBranch...HEAD -- <files>` and write the
 * output to `outPath` atomically (via `.tmp` + rename). The `-C <worktree>` is
 * load-bearing: the orchestrator process runs outside the issue worktree (it
 * juggles several worktrees at once), so without it the diff is taken against
 * the wrong repo and silently comes back empty. When `cap === true`, the output
 * is truncated to {@link MAX_DIFF_SLICE_BYTES} so a runaway per-agent slice
 * cannot blow up the reviewer's prompt cost.
 */
const writeGitDiff = (
  agent: AgentNameOrFull,
  worktree: string,
  defaultBranch: string,
  outPath: string,
  files: readonly string[],
  cap: boolean,
): Effect.Effect<string, DiffSliceError> =>
  Effect.gen(function* () {
    const range = `${defaultBranch}...HEAD`;
    const tmpPath = `${outPath}.tmp`;
    const result = yield* withShellRetry(
      runShell(
        () =>
          files.length === 0
            ? $`git -C ${worktree} diff ${range}`
            : $`git -C ${worktree} diff ${range} -- ${files}`,
        GIT_READ_TIMEOUT_MS,
      ),
    ).pipe(
      Effect.mapError(
        (error) =>
          new DiffSliceError({
            agent,
            reason: `git diff failed — ${describeShellError(error)}`,
          }),
      ),
    );

    const payload = cap ? capDiffPayload(result.stdout) : result.stdout;
    yield* Effect.tryPromise({
      try: () => writeFile(tmpPath, payload),
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

/**
 * `writeFullDiff` — write the full `git diff $defaultBranch...HEAD` to a
 * single path. Used both as the input to the routing haiku and as the
 * shared `{diff_file}` for every full-diff agent the router picks.
 *
 * NOT capped — the router needs the whole picture to decide which agents to
 * spawn. Full-diff agents (correctness, funnel) read this same file; if it
 * exceeds the budget, the cost guard is the router itself shrinking the
 * fan-out, not silent truncation.
 */
type WriteFullDiffInput = {
  /** Issue worktree the diff is taken in (absolute path). */
  readonly worktree: string;
  readonly defaultBranch: string;
  readonly outPath: string;
};

export const writeFullDiff = (input: WriteFullDiffInput): Effect.Effect<string, DiffSliceError> =>
  writeGitDiff("full", input.worktree, input.defaultBranch, input.outPath, [], false);

/** Input for {@link writeDiffSlices}. */
export type WriteDiffSlicesInput = {
  readonly routes: readonly RoutedAgent[];
  /** Path to the already-written full diff — reused for full-diff agents. */
  readonly fullDiffPath: string;
  /** Issue worktree each slice's diff is taken in (absolute path). */
  readonly worktree: string;
  readonly defaultBranch: string;
  /** Directory where slices land — must exist. */
  readonly slicesDir: string;
  /** Identifier embedded in slice filenames, e.g. `review-run` + iteration. */
  readonly slug: string;
};

/**
 * Result of {@link writeDiffSlices} — one path per agent in the routes.
 *
 * Agents the router scoped to the full diff (`files: []`) share the
 * {@link WriteDiffSlicesInput.fullDiffPath}; agents with a non-empty `files`
 * list get their own slice.
 */
export type DiffSliceMap = {
  readonly fullDiffPath: string;
  readonly perAgent: ReadonlyMap<AgentName, string>;
};

/**
 * Write a diff slice per agent in `routes`. Slices are computed in parallel.
 * Full-diff agents are mapped directly to `fullDiffPath` — no extra shell-out.
 */
export const writeDiffSlices = (
  input: WriteDiffSlicesInput,
): Effect.Effect<DiffSliceMap, DiffSliceError> =>
  Effect.gen(function* () {
    const agentsNeedingSlice: { readonly agent: AgentName; readonly scope: readonly string[] }[] = [];
    const agentsUsingFull: AgentName[] = [];
    for (const route of input.routes) {
      if (route.files.length === 0) {
        agentsUsingFull.push(route.name);
      } else {
        agentsNeedingSlice.push({ agent: route.name, scope: route.files });
      }
    }

    const sliceResults = yield* Effect.forEach(
      agentsNeedingSlice,
      ({ agent, scope }) => {
        const slicePath = join(input.slicesDir, `${input.slug}-${agent}.patch`);
        return writeGitDiff(agent, input.worktree, input.defaultBranch, slicePath, scope, true).pipe(
          Effect.map((path) => [agent, path] as const),
        );
      },
      { concurrency: "unbounded" },
    );

    const perAgent = new Map<AgentName, string>();
    for (const agent of agentsUsingFull) { perAgent.set(agent, input.fullDiffPath); }
    for (const [agent, path] of sliceResults) { perAgent.set(agent, path); }

    return { fullDiffPath: input.fullDiffPath, perAgent };
  });
