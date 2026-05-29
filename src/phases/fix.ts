/**
 * Fix Phase — apply the verified fix instructions; `FIX_DONE` loops back to review.
 *
 * Increments the fix-cycle counter on the way back so `evaluate` can cap a
 * persistent disagreement at `MAX_FIX_CYCLES`.
 */
import { Console, Effect } from "effect";
import type { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "../session/phase";
import { mrPhaseOptions, phaseHandlerError, pipelineContext } from "./runner";

const MS_PER_SECOND = 1000;

/** Fix Phase Module — implements the fix state's transition. */
export const fixPhase = (
  state: Extract<State, { kind: "fix" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const { fixCycles } = state;
    // A fix that runs out of budget without a verdict has usually still
    // committed real progress; re-review that work (and reuse the prior review
    // pass) instead of discarding the issue to fetch_queue (#42). It counts as
    // a fix cycle, so MAX_FIX_CYCLES still bounds a fix that keeps timing out.
    // Every other phase error (NoVerdict after its re-prompt, tmux, etc.) stays
    // terminal and fails the issue for a human.
    yield* runPhaseSession(mrPhaseOptions(state, "fix", fixCycles), ["FIX_DONE"]).pipe(
      Effect.catchTag("SessionTimedOut", (error) =>
        Console.log(
          `  ↳ fix[${fixCycles}] timed out after ${Math.round(error.elapsedMs / MS_PER_SECOND)}s` +
            ` — re-reviewing committed work instead of dropping the issue (#42)`,
        ).pipe(Effect.as("FIX_DONE" as const)),
      ),
      Effect.mapError(phaseHandlerError(`fix[${fixCycles}]`)),
    );
    return { kind: "review", ...pipelineContext(state), fixCycles: fixCycles + 1 };
  });
