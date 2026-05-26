/**
 * Review/read-changed-files.ts — gather the per-file metadata `detectReviewPlan`
 * and `writeDiffSlices` consume.
 *
 * The fan-out planner needs four facts about each file in the diff: its path,
 * its extension, the line count of its hunks, and (for trust-boundary and
 * skill detection) its current content + extracted imports. Production gets
 * these from the issue's worktree via `git`. Tests pass them in directly to
 * keep `detect.ts` pure.
 *
 * Errors are tagged. `git`-level failures (corrupt worktree, missing default
 * branch) are `ShellError`s, wrapped here as {@link ReadChangedFilesError}.
 * Missing files (post-delete, post-rename) are tolerated — they enter the
 * fan-out as empty-content, zero-import rows so language and skill detection
 * still fire on the path alone.
 */
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { $ } from "bun";
import { Data, Effect } from "effect";
import { runShell } from "../shell";
import type { ShellError } from "../shell";
import type { ChangedFile } from "./detect";

/** Failure when the changed-files set cannot be assembled. */
export class ReadChangedFilesError extends Data.TaggedError("ReadChangedFilesError")<{
  readonly operation: string;
  readonly reason: string;
}> {}

/**
 * Match every JS/TS-style import specifier — `import ... from "X"`,
 * bare `import "X"`, dynamic `import("X")`, and `require("X")`. Tolerant of
 * single quotes and templating quirks; the resulting array is what
 * `detect.ts` substring-scans for skill triggers.
 */
const IMPORT_RE =
  /(?:import(?:\s+[\s\S]*?from)?\s*|require\(\s*|import\(\s*)["']([^"']+)["']/g;

const extractImports = (content: string): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
};

const extOf = (path: string): string => {
  const ext = extname(path);
  return ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase();
};

/** Parse one `git diff --numstat` line: `<added>\t<removed>\t<path>`. */
const parseNumstatLine = (
  line: string,
): { readonly added: number; readonly removed: number; readonly path: string } | null => {
  const parts = line.split("\t");
  if (parts.length < 3) return null;
  const [addedRaw, removedRaw, pathRaw] = parts as [string, string, string];
  // Binary files show `-` instead of numbers — treat as 0-line for tier math.
  const added = addedRaw === "-" ? 0 : Number(addedRaw);
  const removed = removedRaw === "-" ? 0 : Number(removedRaw);
  if (Number.isNaN(added) || Number.isNaN(removed)) return null;
  // Renames render as `{old => new}` or `old\0new` — keep the new path only.
  // `git diff --numstat` without `-M` doesn't emit these; we still strip them
  // defensively. The Step 12 caller doesn't pass `-M`, so this is a paranoia hedge.
  const path = pathRaw.includes(" => ") ? (pathRaw.split(" => ")[1] ?? pathRaw) : pathRaw;
  return { added, removed, path };
};

/** Input for {@link readChangedFiles}. */
export type ReadChangedFilesInput = {
  /** Worktree to run `git` in (absolute path). */
  readonly worktree: string;
  /** Default branch to diff against — passed through from preflight. */
  readonly defaultBranch: string;
};

/**
 * `readChangedFiles` — list every file changed between `defaultBranch` and
 * HEAD in `worktree`, populating the `ChangedFile` shape `detectReviewPlan`
 * consumes.
 */
export const readChangedFiles = (
  input: ReadChangedFilesInput,
): Effect.Effect<ReadonlyArray<ChangedFile>, ReadChangedFilesError> =>
  Effect.gen(function* () {
    const { worktree, defaultBranch } = input;
    const range = `${defaultBranch}...HEAD`;

    const numstat = yield* runShell(
      () => $`git -C ${worktree} diff --numstat ${range}`,
    ).pipe(
      Effect.mapError(
        (error: ShellError) =>
          new ReadChangedFilesError({
            operation: `git diff --numstat ${range}`,
            reason: error._tag,
          }),
      ),
    );

    const rows = numstat.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map(parseNumstatLine)
      .filter((row): row is NonNullable<typeof row> => row !== null);

    // Read content per file in parallel. Missing-on-disk (deleted file in
    // HEAD's tree) is tolerated and surfaces as empty content.
    const files = yield* Effect.forEach(
      rows,
      (row): Effect.Effect<ChangedFile, never> =>
        Effect.tryPromise({
          try: () => readFile(join(worktree, row.path), "utf8"),
          catch: () => "",
        }).pipe(
          Effect.catchAll(() => Effect.succeed("")),
          Effect.map(
            (content): ChangedFile => ({
              path: row.path,
              ext: extOf(row.path),
              lineCount: row.added + row.removed,
              content,
              imports: extractImports(content),
            }),
          ),
        ),
      { concurrency: 8 },
    );

    return files;
  });

/** Exported for tests. */
export const _extractImports = extractImports;
export const _parseNumstatLine = parseNumstatLine;
