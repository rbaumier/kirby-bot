/**
 * Session/phase.ts — running one pipeline phase as a fresh `claude` tmux session.
 *
 * `runPhaseSession` is the load-bearing helper. It writes the
 * Stop-hook config, renders the prompt, and drives a tmux session
 * to a verdict via {@link runOneClaudeSession}. The session-lifecycle
 * bracket and the sentinel poll live in `./phase-primitives` so the
 * per-agent fan-out runner can share them.
 *
 * Every failure is one of the typed errors in `./errors`.
 */
import { writeFile } from "node:fs/promises";
import { Clock, Effect } from "effect";
import { PHASE_CAP_MINUTES, PHASE_MODELS, SENTINEL_POLL_MS } from "../config";
import { RunArtifacts } from "../run-artifacts";
import type { PhaseError } from "./errors";
import { BudgetExhausted, UnexpectedVerdictError, WorkspaceError } from "./errors";
import { runOneClaudeSession, writeStopHookConfig } from "./phase-primitives";
import type { PromptablePhase } from "./prompt";
import { renderPrompt } from "./prompt";
import type { VerdictToken } from "./verdict";

/** Input for {@link runPhaseSession}. */
export type RunPhaseSessionInput = {
  readonly phase: PromptablePhase;
  readonly issueIid: number;
  readonly worktree: string;
  readonly iteration: number;
  readonly deadline: number;
  readonly replacements: Record<string, string>;
};

/**
 * Run one phase as a fresh `claude` tmux session and return a verdict narrowed
 * to the expected set.
 *
 * The tmux session is an `acquireUseRelease` resource (see
 * {@link runOneClaudeSession}) — guaranteed to be killed on every exit of
 * `use` (verdict, timeout, defect, or interruption).
 *
 * An out-of-set verdict fails with `UnexpectedVerdictError` so callers route
 * on tagged data rather than re-pattern-matching a verdict string.
 */
export const runPhaseSession = <const V extends VerdictToken>(
  input: RunPhaseSessionInput,
  expected: readonly V[],
): Effect.Effect<V, PhaseError, RunArtifacts> =>
  Effect.gen(function* () {
    const { phase, issueIid, worktree, iteration, deadline, replacements } = input;
    // Phase timeout: the smaller of its per-phase cap and the budget still
    // left for the issue. No floor — below one poll interval we refuse to spawn.
    const now = yield* Clock.currentTimeMillis;
    const timeoutMs = Math.min(PHASE_CAP_MINUTES[phase] * 60 * 1000, deadline - now);

    // A budget below one poll interval can never yield a verdict in time —
    // fail now rather than spawn a session that is killed mid-boot.
    if (timeoutMs < SENTINEL_POLL_MS) {
      return yield* Effect.fail(new BudgetExhausted({ phase }));
    }

    const artifacts = yield* RunArtifacts;
    const ref = { issueIid, phase, iteration };
    const session = artifacts.sessionName(ref);
    const sentinel = artifacts.sentinelPath(ref);
    const tmuxLogPath = artifacts.tmuxLogPath(ref);
    const promptFile = artifacts.promptFilePath(ref);

    yield* writeStopHookConfig(phase, worktree);
    const rendered = yield* renderPrompt(phase, replacements);
    yield* Effect.tryPromise({
      try: () => writeFile(promptFile, rendered),
      catch: (cause) =>
        new WorkspaceError({ phase, operation: "write the prompt file", reason: String(cause) }),
    });

    const verdict = yield* runOneClaudeSession({
      phase,
      worktree,
      session,
      tmuxLogPath,
      promptFile,
      sentinel,
      timeoutMs,
      logContext: { issueIid, iteration },
      model: PHASE_MODELS[phase],
      expectedVerdicts: expected,
    });

    const narrowed = expected.find((candidate) => candidate === verdict);
    if (narrowed === undefined) {
      return yield* Effect.fail(new UnexpectedVerdictError({ phase, verdict, expected }));
    }
    return narrowed;
  });
