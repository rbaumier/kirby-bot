/**
 * Review/detect.ts — `detectReviewPlan`: given the diff file-set, decide which
 * agents to fan out, which trust boundaries are active, which dogfood surfaces
 * the diff touches, and the overall tier (Lite vs Full).
 *
 * Pure and deterministic on the inputs. No filesystem reads, no shell-outs —
 * the caller passes the diff metadata in, this returns the plan out. Easy to
 * unit-test in isolation.
 */
import {
  type AgentName,
  type DogfoodCategory,
  DOGFOOD_TRIGGERS,
  FULL_ALWAYS_SPAWN,
  HIGH_STAKES_PATH_FRAGMENTS,
  IMPORT_SKILL_TRIGGERS,
  LANGUAGE_BY_EXT,
  LITE_ALWAYS_SPAWN,
  SUBSYSTEM_TRIGGERS,
  SURFACE_TRIGGERS,
  TIER_LITE_MAX_FILES,
  TIER_LITE_MAX_LINES,
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
  /**
   * The file body — used for code-pattern matching and to extract import
   * specs. The caller can pass the full file or the diff hunk; both work as
   * substring sources. Keep it small when possible.
   */
  readonly content: string;
  /**
   * Import specifiers extracted from `import … from "X"` lines. Pass an empty
   * array if you cannot extract them; trust-boundary and import-skill
   * detection then fall back to substring scans of `content`.
   */
  readonly imports: ReadonlyArray<string>;
};

/** Tier — Lite trims the panel; Full spawns the long list. */
export type ReviewTier = "lite" | "full";

/** The plan a fan-out runner consumes. */
export type ReviewPlan = {
  readonly tier: ReviewTier;
  /** Agents to spawn, deduplicated and stably ordered. */
  readonly agents: ReadonlyArray<AgentName>;
  /** Active trust boundaries — pass-through to every line-anchored prompt. */
  readonly trustBoundaries: ReadonlyArray<TrustBoundary>;
  /** Dogfood gate state — set by the consuming loop, recorded here. */
  readonly dogfoodRequired: boolean;
  readonly dogfoodSurfaces: ReadonlyArray<DogfoodCategory>;
  /** Total non-noise lines and file count — useful for logging the tier decision. */
  readonly totalLines: number;
  readonly fileCount: number;
  /** Whether any high-stakes path or subsystem trigger fired. */
  readonly highStakes: boolean;
};

/** Input for {@link detectReviewPlan}. */
export type DetectReviewPlanInput = {
  readonly files: ReadonlyArray<ChangedFile>;
  /**
   * Force the Full tier even if the diff would otherwise compute Lite —
   * passed through from the user's `--deep-review` style override.
   */
  readonly forceFull?: boolean;
};

/** Test whether any signal fragment appears as substring of any haystack string. */
const anyMatches = (
  haystacks: ReadonlyArray<string>,
  needles: ReadonlyArray<string>,
): boolean => {
  if (needles.length === 0) return false;
  return haystacks.some((hay) => needles.some((needle) => hay.includes(needle)));
};

/** Test whether any of `paths` contains any of `fragments` as a substring. */
const anyPathHas = (paths: ReadonlyArray<string>, fragments: ReadonlyArray<string>): boolean =>
  anyMatches(paths, fragments);

/** Input for {@link computeTier} — the four signals the rule depends on. */
export type ComputeTierInput = {
  readonly totalLines: number;
  readonly fileCount: number;
  readonly highStakes: boolean;
  readonly forceFull: boolean;
};

/**
 * `computeTier` — apply the Lite-vs-Full rule on the pre-computed totals.
 *
 * Lite iff: small (`totalLines <= TIER_LITE_MAX_LINES` AND
 * `fileCount <= TIER_LITE_MAX_FILES`) AND not high-stakes AND not forced Full.
 * Otherwise Full.
 *
 * Extracted from {@link detectReviewPlan} so the boundary conditions
 * (`<= MAX` vs `> MAX`) can be unit-tested without constructing a fake
 * `ChangedFile[]`.
 */
export const computeTier = (input: ComputeTierInput): ReviewTier => {
  const { totalLines, fileCount, highStakes, forceFull } = input;
  const liteEligible =
    !forceFull &&
    !highStakes &&
    totalLines <= TIER_LITE_MAX_LINES &&
    fileCount <= TIER_LITE_MAX_FILES;
  return liteEligible ? "lite" : "full";
};

/**
 * Build a stably-ordered, deduplicated agent list. We preserve insertion order
 * so the always-spawn agents lead and conditional spawns append in deterministic
 * order — easier to read in logs and stable for snapshot tests.
 */
const uniqueAgents = (agents: ReadonlyArray<AgentName>): ReadonlyArray<AgentName> => {
  const seen = new Set<AgentName>();
  const out: AgentName[] = [];
  for (const agent of agents) {
    if (seen.has(agent)) continue;
    seen.add(agent);
    out.push(agent);
  }
  return out;
};

/**
 * `detectReviewPlan` — produce the `ReviewPlan` for a diff file-set.
 *
 * The algorithm mirrors `code-review`'s Step 0 + tier classification:
 *  1. Compute totals (lines, file count, high_stakes).
 *  2. Pick a tier (Lite/Full) — overridable by `forceFull`.
 *  3. Seed agents from the tier's always-spawn list.
 *  4. Append conditional spawns: language (by ext), skill (by import),
 *     surface (by path glob), subsystem (by trigger), unless the tier excludes
 *     them. Lite drops every conditional row.
 *  5. Compute active trust boundaries, dogfood gate state.
 */
export const detectReviewPlan = (input: DetectReviewPlanInput): ReviewPlan => {
  const { files, forceFull = false } = input;

  const totalLines = files.reduce((sum, file) => sum + file.lineCount, 0);
  const fileCount = files.length;
  const paths = files.map((file) => file.path);
  const contents = files.map((file) => file.content);
  const allImports = files.flatMap((file) => [...file.imports, ...file.content.split(/\n/)]);

  // high_stakes — any subsystem trigger OR any high-stakes path fragment.
  const pathHighStakes = anyPathHas(paths, HIGH_STAKES_PATH_FRAGMENTS);
  const subsystemAgents: AgentName[] = [];
  for (const row of SUBSYSTEM_TRIGGERS) {
    const hit =
      anyPathHas(paths, row.pathFragments) ||
      anyMatches(allImports, row.imports) ||
      anyMatches(contents, row.codePatterns);
    if (hit) subsystemAgents.push(row.agent);
  }
  const highStakes = pathHighStakes || subsystemAgents.length > 0;

  const tier = computeTier({ totalLines, fileCount, highStakes, forceFull });

  // Seed with the tier's always-spawn list.
  const baseAgents = tier === "lite" ? LITE_ALWAYS_SPAWN : FULL_ALWAYS_SPAWN;
  const agents: AgentName[] = [...baseAgents];

  // Lite skips every conditional row — no language, no skill, no surface,
  // no subsystem. The early return keeps the wiring obvious.
  if (tier === "full") {
    // Language by extension. We take any matching language agent — when the
    // diff spans `.ts` + `.rs`, both get spawned.
    const languageAgents = new Set<AgentName>();
    for (const file of files) {
      const agent = LANGUAGE_BY_EXT[file.ext];
      if (agent !== undefined && agent !== null) languageAgents.add(agent);
    }
    agents.push(...languageAgents);

    // Skill by import.
    for (const row of IMPORT_SKILL_TRIGGERS) {
      if (anyMatches(allImports, row.imports)) agents.push(row.agent);
    }

    // Surface by path / extension.
    for (const row of SURFACE_TRIGGERS) {
      const pathHit = anyPathHas(paths, row.pathFragments);
      const extHit = files.some((file) => row.extensions.includes(file.ext));
      if (pathHit || extHit) agents.push(...row.agents);
    }

    // Subsystem (already detected above for high_stakes).
    agents.push(...subsystemAgents);
  }

  // Trust boundaries — runs for BOTH tiers per the SKILL spec.
  const trustBoundaries: TrustBoundary[] = [];
  for (const row of TRUST_BOUNDARY_SIGNALS) {
    if (anyMatches(allImports, row.signals) || anyMatches(contents, row.signals)) {
      trustBoundaries.push(row.boundary);
    }
  }

  // Dogfood — runs for both tiers; the consuming loop decides when to gate.
  const dogfoodSurfaces: DogfoodCategory[] = [];
  for (const row of DOGFOOD_TRIGGERS) {
    const pathHit = anyPathHas(paths, row.pathFragments);
    const extHit = files.some((file) => row.extensions.includes(file.ext));
    const importHit = anyMatches(allImports, row.imports);
    if (pathHit || extHit || importHit) dogfoodSurfaces.push(row.category);
  }

  return {
    tier,
    agents: uniqueAgents(agents),
    trustBoundaries,
    dogfoodRequired: dogfoodSurfaces.length > 0,
    dogfoodSurfaces,
    totalLines,
    fileCount,
    highStakes,
  };
};
