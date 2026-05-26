/**
 * Review/detect.ts — `analyzeReviewInputs`: the deterministic-analysis half of
 * the review-pass pipeline. The agent-spawn decisions live in `./router.ts`
 * now (haiku); this module only computes what does NOT need a model:
 *
 *  - trust boundaries the diff crosses (drives every line-anchored agent's
 *    `{trust_boundaries}` substitution),
 *  - dogfood-gate categories (drives the consuming loop's runtime 3-persona
 *    gate),
 *  - total lines / file count (informational, surfaced in the run JSONL).
 *
 * Pure and deterministic on the inputs. No filesystem reads, no shell-outs —
 * the caller passes the diff metadata in, this returns the analysis out.
 */
import {
  type DogfoodCategory,
  DOGFOOD_TRIGGERS,
  TRUST_BOUNDARY_SIGNALS,
  type TrustBoundary,
} from "./detect-tables";

/** Metadata for one file in the diff that detection consumes. */
export type ChangedFile = {
  /** Path relative to repo root, forward-slashed even on Windows. */
  readonly path: string;
  /** Lowercased extension without the dot, e.g. `"tsx"`. Empty string if none. */
  readonly ext: string;
  /** Added + removed lines (after Step 0.5 cheap-triage filter, if any). */
  readonly lineCount: number;
  /** File body — used for code-pattern matching and to extract import specs. */
  readonly content: string;
  /** Import specifiers extracted from `import … from "X"` lines. */
  readonly imports: ReadonlyArray<string>;
};

/**
 * The deterministic analysis the fan-out consumes alongside the router's
 * decision: which trust boundaries cross the diff, which dogfood surfaces the
 * runtime gate should validate, and totals for logging.
 */
export type ReviewAnalysis = {
  readonly trustBoundaries: ReadonlyArray<TrustBoundary>;
  readonly dogfoodRequired: boolean;
  readonly dogfoodSurfaces: ReadonlyArray<DogfoodCategory>;
  readonly totalLines: number;
  readonly fileCount: number;
};

/**
 * `analyzeReviewInputs` — pure analysis pass over the diff's file roster.
 *
 * No model call, no shell, no IO. The caller hands in the metadata; this
 * returns the trust boundaries and dogfood categories the diff activates,
 * plus totals for the run log.
 */
export const analyzeReviewInputs = (
  files: ReadonlyArray<ChangedFile>,
): ReviewAnalysis => {
  const totalLines = files.reduce((sum, file) => sum + file.lineCount, 0);
  const fileCount = files.length;

  // Trust boundaries — substring scan over imports + file content. Inclusive
  // matching by design (over-tagging a boundary costs one prompt token; under-
  // tagging drops a security lens).
  const allImports = files.flatMap((file) => [...file.imports, ...file.content.split(/\n/)]);
  const contents = files.map((file) => file.content);
  const trustBoundaries: TrustBoundary[] = [];
  for (const row of TRUST_BOUNDARY_SIGNALS) {
    const hit =
      row.signals.some((needle) => allImports.some((haystack) => haystack.includes(needle))) ||
      row.signals.some((needle) => contents.some((haystack) => haystack.includes(needle)));
    if (hit) trustBoundaries.push(row.boundary);
  }

  // Dogfood surfaces — path/extension/import triggers. Broad on purpose so the
  // runtime gate fires for any user-facing surface change.
  const dogfoodSurfaces: DogfoodCategory[] = [];
  for (const row of DOGFOOD_TRIGGERS) {
    const pathHit = files.some((file) =>
      row.pathFragments.some((frag) => file.path.includes(frag)),
    );
    const extHit = files.some((file) => row.extensions.includes(file.ext));
    const importHit = row.imports.some((needle) =>
      allImports.some((haystack) => haystack.includes(needle)),
    );
    if (pathHit || extHit || importHit) dogfoodSurfaces.push(row.category);
  }

  return {
    trustBoundaries,
    dogfoodRequired: dogfoodSurfaces.length > 0,
    dogfoodSurfaces,
    totalLines,
    fileCount,
  };
};
