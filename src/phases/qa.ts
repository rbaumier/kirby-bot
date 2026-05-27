/**
 * QA Phase — the runtime gate; `QA_PASS` advances to merge.
 *
 * Always spawned by the orchestrator; the Session self-skips when no
 * user-facing surface was touched (see the orchestrator decomposition doc).
 * `QA_FAIL` is a real, in-scope bug: route it back to `fix` so the loop can
 * address it, sharing the same `fixCycles` budget as the evaluate→fix path.
 * Only when that budget is exhausted do we fail the issue for a human.
 */
import { Effect } from "effect";
import { MAX_FIX_CYCLES } from "../config";
import { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "../session/phase";
import { mrPhaseOptions, phaseHandlerError, pipelineContext } from "./runner";

/** QA Phase Module — implements the qa state's transition. */
export const qaPhase = (
  state: Extract<State, { kind: "qa" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const { fixCycles } = state;
    const verdict = yield* runPhaseSession(
      mrPhaseOptions(state, "qa", fixCycles),
      ["QA_PASS", "QA_FAIL"],
    ).pipe(Effect.mapError(phaseHandlerError("qa")));

    if (verdict === "QA_PASS") {
      return { kind: "merge", ...pipelineContext(state) };
    }
    if (MAX_FIX_CYCLES <= fixCycles) {
      return yield* Effect.fail(
        new HandlerError({
          reason: `fix_cycle_cap: ${MAX_FIX_CYCLES} fix cycles, qa still failing`,
        }),
      );
    }
    return { kind: "fix", ...pipelineContext(state), fixCycles };
  });
