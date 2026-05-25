/**
 * Fix Phase — apply the verified fix instructions; `FIX_DONE` loops back to review.
 *
 * Increments the fix-cycle counter on the way back so `evaluate` can cap a
 * persistent disagreement at `MAX_FIX_CYCLES`.
 */
import { Effect } from "effect";
import type { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { RunArtifacts } from "../run-artifacts";
import { mrPhaseOptions, phaseRunHandlerError, pipelineContext, runPhase } from "./runner";

/** Fix Phase Module — implements the fix state's transition. */
export const fixPhase = (
  state: Extract<State, { kind: "fix" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const { fixCycles } = state;
    yield* runPhase("fix", mrPhaseOptions(state, fixCycles), ["FIX_DONE"]).pipe(
      Effect.mapError(phaseRunHandlerError(`fix[${fixCycles}]`)),
    );
    return { kind: "review", ...pipelineContext(state), fixCycles: fixCycles + 1 };
  });
