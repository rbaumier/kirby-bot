/**
 * Run-artifacts.ts — the run's footprint on disk, as an Effect service.
 *
 * Owns the per-run directory and every path beneath it (the JSONL event log,
 * per-phase sentinels, tmux logs, rendered prompts), plus the structured
 * logger. Exposed via {@link RunArtifacts} so test code can inject a
 * deterministic Clock and seeded Random and observe the same `dir` shape.
 *
 * Cross-cutting: both the session and pipeline slices yield it, so it sits
 * at the top level rather than inside either.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Console, Context, Effect, Layer, Random } from "effect";
import type { Phase } from "./config";
import { RUNS_DIR } from "./config";

/**
 * Identifies one phase run — unique per issue, phase, iteration.
 *
 * `agent` disambiguates per-agent sessions in a fan-out phase: when set, every
 * path helper suffixes its filename with the agent name so N parallel `claude`
 * sessions never collide on a sentinel/log/prompt/tmux name. Absent for the
 * single-prompt phases (run_impl, evaluate, fix, run_dogfood) — filenames stay
 * identical to before the field was added.
 */
export type PhaseRef = {
  readonly issueIid: number;
  readonly phase: Phase;
  readonly iteration: number;
  readonly agent?: string;
};

/** The shape provided by {@link RunArtifacts}. */
export type RunArtifactsShape = {
  /** This run's unique directory under ~/.afk-runs/. */
  readonly dir: string;
  /** The run's machine-readable event log. */
  readonly logPath: string;
  /**
   * The sentinel file a phase's Stop hook writes its final message into.
   * `iteration` keeps the review/fix loop's repeated phases from colliding.
   */
  readonly sentinelPath: (ref: PhaseRef) => string;
  /** The file a phase's tmux pane is mirrored into, for live tailing. */
  readonly tmuxLogPath: (ref: PhaseRef) => string;
  /** The rendered prompt handed to a phase's claude session. */
  readonly promptFilePath: (ref: PhaseRef) => string;
  /** The tmux session name for one phase run. */
  readonly sessionName: (ref: PhaseRef) => string;
  /**
   * Append one structured event to the run's JSONL log. Best-effort: a logging
   * failure must never abort a run, so the returned Effect never fails.
   */
  readonly logEvent: (event: Record<string, unknown>) => Effect.Effect<void>;
};

/** Effect Tag for the per-run artifact paths and structured logger. */
export class RunArtifacts extends Context.Tag("RunArtifacts")<
  RunArtifacts,
  RunArtifactsShape
>() {}

const COLON_OR_DOT_RE = /[:.]/g;
const RANDOM_SUFFIX_LEN = 6;

/** Build the shape from a precomputed `dir` so the helpers can close over it. */
const shapeFor = (dir: string): RunArtifactsShape => {
  const logPath = join(dir, "run.jsonl");
  // When `agent` is set, the suffix gets a trailing `-<agent>` so per-agent
  // fan-out files don't collide. Absent → identical to the pre-fan-out format.
  const refSuffix = ({ issueIid, phase, iteration, agent }: PhaseRef) =>
    agent === undefined
      ? `${issueIid}-${phase}-${iteration}`
      : `${issueIid}-${phase}-${iteration}-${agent}`;
  return {
    dir,
    logPath,
    sentinelPath: (ref) => join(dir, `sentinel-${refSuffix(ref)}.flag`),
    tmuxLogPath: (ref) => join(dir, `tmux-${refSuffix(ref)}.log`),
    promptFilePath: (ref) => join(dir, `prompt-${refSuffix(ref)}.md`),
    sessionName: (ref) => `afk-${refSuffix(ref)}`,
    logEvent: (event) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.tryPromise(() =>
          appendFile(
            logPath,
            `${JSON.stringify({ at: new Date(now).toISOString(), ...event })}\n`,
          ),
        );
      }).pipe(
        Effect.tapError((cause) => Console.error(`[run-artifacts] logEvent failed: ${String(cause)}`)),
        Effect.ignore,
      ),
  };
};

/**
 * Compute a fresh `RunArtifactsShape` using the ambient Clock and Random.
 * Exported for tests that want to drive the computation under a specific
 * TestClock / seeded Random.
 */
export const buildRunArtifacts: Effect.Effect<RunArtifactsShape> = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const rand = yield* Random.nextInt;
  const startedAt = new Date(now).toISOString().replaceAll(COLON_OR_DOT_RE, "-").replace("T", "_");
  const randomSuffix = Math.abs(rand).toString(16).padStart(RANDOM_SUFFIX_LEN, "0").slice(0, RANDOM_SUFFIX_LEN);
  return shapeFor(join(RUNS_DIR, `${startedAt}-${randomSuffix}`));
});

/** Live {@link RunArtifacts} — Clock + Random read at layer construction. */
export const RunArtifactsLive: Layer.Layer<RunArtifacts> = Layer.effect(
  RunArtifacts,
  buildRunArtifacts,
);
