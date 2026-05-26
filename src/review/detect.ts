/**
 * Review/detect.ts — `detectReviewPlan`: given the diff file-set, decide which
 * agents to fan out, which trust boundaries are active, which dogfood surfaces
 * the diff touches, and the overall tier (Lite vs Full).
 *
 * Pure and deterministic on the inputs. No filesystem reads, no shell-outs —
 * the caller passes the diff metadata in, this returns the plan out. Easy to
 * unit-test in isolation.
 *
 * Per-agent data (model, prompt, triggers) lives in `./agents.ts`. This module
 * iterates over that registry once and applies the spawn rules.
 */
import {
  AGENTS,
  ALL_AGENT_NAMES,
  type AgentName,
  hasTriggers,
  isSubsystemAgent,
  type SpawnTriggers,
} from "./agents";
import {
  type DogfoodCategory,
  DOGFOOD_TRIGGERS,
  HIGH_STAKES_PATH_FRAGMENTS,
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
  /** File body — used for code-pattern matching and to extract import specs. */
  readonly content: string;
  /** Import specifiers extracted from `import … from "X"` lines. */
  readonly imports: ReadonlyArray<string>;
};

/** Tier — Lite trims the panel; Full spawns the long list. */
export type ReviewTier = "lite" | "full";

/** The plan a fan-out runner consumes. */
export type ReviewPlan = {
  readonly tier: ReviewTier;
  readonly agents: ReadonlyArray<AgentName>;
  readonly trustBoundaries: ReadonlyArray<TrustBoundary>;
  readonly dogfoodRequired: boolean;
  readonly dogfoodSurfaces: ReadonlyArray<DogfoodCategory>;
  readonly totalLines: number;
  readonly fileCount: number;
  readonly highStakes: boolean;
};

/** Input for {@link detectReviewPlan}. */
export type DetectReviewPlanInput = {
  readonly files: ReadonlyArray<ChangedFile>;
  /** Force Full tier even when the size signals Lite — `--deep-review`-style override. */
  readonly forceFull?: boolean;
};

/** Input for {@link computeTier} — the four signals the rule depends on. */
export type ComputeTierInput = {
  readonly totalLines: number;
  readonly fileCount: number;
  readonly highStakes: boolean;
  readonly forceFull: boolean;
};

/**
 * Pure tier rule on pre-computed totals. Exposed for testing the boundary
 * conditions without re-deriving the totals.
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
 * Test whether any of an agent's spawn triggers fire against the diff.
 * OR semantics across fields, OR across needles within each field.
 */
const triggersFire = (
  triggers: SpawnTriggers,
  files: ReadonlyArray<ChangedFile>,
): boolean => {
  const exts = triggers.extensions;
  if (exts !== undefined && exts.length > 0 && files.some((file) => exts.includes(file.ext))) {
    return true;
  }
  const paths = triggers.pathFragments;
  if (
    paths !== undefined &&
    paths.length > 0 &&
    files.some((file) => paths.some((frag) => file.path.includes(frag)))
  ) {
    return true;
  }
  const imports = triggers.imports;
  if (imports !== undefined && imports.length > 0) {
    const hit = files.some((file) =>
      imports.some(
        (needle) =>
          file.imports.some((spec) => spec.includes(needle)) || file.content.includes(needle),
      ),
    );
    if (hit) return true;
  }
  const codePatterns = triggers.codePatterns;
  if (
    codePatterns !== undefined &&
    codePatterns.length > 0 &&
    files.some((file) => codePatterns.some((needle) => file.content.includes(needle)))
  ) {
    return true;
  }
  return false;
};

/** Build a stably-ordered, deduplicated agent list (insertion order). */
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
 * `detectReviewPlan` — produce the {@link ReviewPlan} for a diff file-set.
 *
 * Algorithm:
 *  1. Compute totals (lines, file count).
 *  2. Walk every agent in {@link AGENTS}, marking those whose conditional
 *     `triggers` would fire on this diff (tier-independent).
 *  3. Compute `highStakes` from path fragments + any subsystem agent firing.
 *  4. Pick tier (Lite/Full).
 *  5. Final agent list = (always-in-tier) ∪ (conditional hits, Full tier only).
 *  6. Compute trust boundaries and dogfood surfaces (tier-independent).
 */
export const detectReviewPlan = (input: DetectReviewPlanInput): ReviewPlan => {
  const { files, forceFull = false } = input;

  const totalLines = files.reduce((sum, file) => sum + file.lineCount, 0);
  const fileCount = files.length;

  // Pass 1 — which conditional agents would fire on this diff.
  const conditionalHits = new Set<AgentName>();
  for (const agent of ALL_AGENT_NAMES) {
    if (!hasTriggers(agent)) continue;
    const triggers = AGENTS[agent].triggers;
    if (triggers === undefined) continue;
    if (triggersFire(triggers, files)) conditionalHits.add(agent);
  }

  // high_stakes: any subsystem agent fired, or any high-stakes path matched.
  const pathHighStakes = files.some((file) =>
    HIGH_STAKES_PATH_FRAGMENTS.some((frag) => file.path.includes(frag)),
  );
  const subsystemFired = [...conditionalHits].some(isSubsystemAgent);
  const highStakes = pathHighStakes || subsystemFired;

  const tier = computeTier({ totalLines, fileCount, highStakes, forceFull });

  // Pass 2 — assemble final agent list.
  const agents: AgentName[] = [];
  for (const agent of ALL_AGENT_NAMES) {
    const entry = AGENTS[agent];
    if (entry.alwaysIn?.includes(tier) === true) {
      agents.push(agent);
      continue;
    }
    if (tier === "full" && conditionalHits.has(agent)) {
      agents.push(agent);
    }
  }

  // Trust boundaries — tier-independent.
  const allImports = files.flatMap((file) => [...file.imports, ...file.content.split(/\n/)]);
  const contents = files.map((file) => file.content);
  const trustBoundaries: TrustBoundary[] = [];
  for (const row of TRUST_BOUNDARY_SIGNALS) {
    const hit =
      row.signals.some((needle) => allImports.some((haystack) => haystack.includes(needle))) ||
      row.signals.some((needle) => contents.some((haystack) => haystack.includes(needle)));
    if (hit) trustBoundaries.push(row.boundary);
  }

  // Dogfood surfaces — tier-independent.
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
