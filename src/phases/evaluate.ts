/**
 * Evaluate Phase — the sole convergence authority.
 *
 * `CONVERGED` → `run_dogfood`. `NEEDS_FIX` → `fix`, unless the fix-cycle cap
 * is reached. A 4th NEEDS_FIX is a structural disagreement, not a slow fix;
 * end the issue for a human to look at.
 */
import { Effect } from "effect";
import { MAX_FIX_CYCLES } from "../config";
import { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "../session/phase";
import { mrPhaseOptions, phaseHandlerError, pipelineContext } from "./runner";

/** Evaluate Phase Module — implements the evaluate state's transition. */
export const evaluatePhase = (
  state: Extract<State, { kind: "evaluate" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const { fixCycles } = state;
    const verdict = yield* runPhaseSession(
      mrPhaseOptions(state, "evaluate", fixCycles),
      ["CONVERGED", "NEEDS_FIX"],
    ).pipe(Effect.mapError(phaseHandlerError(`evaluate[${fixCycles}]`)));

    if (verdict === "CONVERGED") {
      return { kind: "run_dogfood", ...pipelineContext(state) };
    }
    if (MAX_FIX_CYCLES <= fixCycles) {
      return yield* Effect.fail(
        new HandlerError({
          reason: `fix_cycle_cap: ${MAX_FIX_CYCLES} fix cycles without convergence`,
        }),
      );
    }
    return { kind: "fix", ...pipelineContext(state), fixCycles };
  });
