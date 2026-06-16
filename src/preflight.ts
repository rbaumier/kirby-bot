/**
 * Preflight.ts — startup checks, run as a typed Effect before the machine.
 *
 * A failure here is a typed {@link PreflightError} that
 * `BunRuntime.runMain` reports cleanly, and the module stays
 * importable without side effects.
 */
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { $ } from "bun";
import { Data, Effect } from "effect";
import { ProviderConfigError } from "./provider/types";
import { RunArtifacts } from "./run-artifacts";
import { selectDriver } from "./session/driver";
import { runShell } from "./shell";

/**
 * A startup precondition failed. Every mode (missing tool, not
 * a repo, no origin/HEAD) is fatal and handled identically.
 * The `reason` carries the specifics.
 */
export class PreflightError extends Data.TaggedError("PreflightError")<{
  readonly reason: string;
}> {}

/** Repository facts the orchestrator needs throughout a run. */
export type Environment = {
  readonly repoName: string;
  readonly defaultBranch: string;
};

/**
 * External tools every run needs, regardless of session driver. `tmux` is
 * required conditionally — only the legacy tmux driver shells out to it — so it
 * is checked in {@link preflight} after the driver is resolved.
 */
const REQUIRED_TOOLS = ["jq", "claude", "git"] as const;

const ORIGIN_PREFIX_RE = /^origin\//;

/** Check that a required tool is in PATH. */
const assertToolInPath = (tool: string): Effect.Effect<void, PreflightError> =>
  runShell(() => $`which ${tool}`).pipe(
    Effect.mapError(
      () =>
        new PreflightError({ reason: `${tool} is not in PATH — required by the orchestrator` }),
    ),
    Effect.asVoid,
  );

/**
 * Create the run directory and verify the environment, returning
 * the repo facts. Fails fast with a clear, actionable message.
 */
export const preflight: Effect.Effect<Environment, PreflightError, RunArtifacts> = Effect.gen(
  function* () {
    const artifacts = yield* RunArtifacts;
    yield* Effect.tryPromise({
      try: () => mkdir(artifacts.dir, { recursive: true }),
      catch: (cause) =>
        new PreflightError({ reason: `could not create the run directory: ${String(cause)}` }),
    });

    // Resolve the session driver up front: an invalid $KIRBY_DRIVER fails fast
    // here (like an unknown $KIRBY_PROVIDER), and it decides whether tmux is
    // required — the default headless `claude -p` driver does not need it.
    const driver = yield* Effect.try({
      try: () => selectDriver(),
      catch: (cause): PreflightError =>
        new PreflightError({
          reason: cause instanceof ProviderConfigError ? cause.detail : String(cause),
        }),
    });

    for (const tool of REQUIRED_TOOLS) {
      yield* assertToolInPath(tool);
    }
    if (driver === "tmux") {
      yield* assertToolInPath("tmux");
    }

    const topLevel = yield* runShell(() => $`git rev-parse --show-toplevel`).pipe(
      Effect.mapError(() => new PreflightError({ reason: "not inside a git repository" })),
    );

    const originHead = yield* runShell(
      () => $`git symbolic-ref --short refs/remotes/origin/HEAD`,
    ).pipe(
      Effect.mapError(
        () =>
          new PreflightError({
            reason: "origin/HEAD is not set locally — run: git remote set-head origin -a",
          }),
      ),
    );

    return {
      repoName: basename(topLevel.stdout.trim()),
      defaultBranch: originHead.stdout.trim().replace(ORIGIN_PREFIX_RE, ""),
    };
  },
);
