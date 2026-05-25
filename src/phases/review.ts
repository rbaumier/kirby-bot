/**
 * Review Phase — run the review Session; `REVIEW_DONE` advances to evaluate.
 *
 * The Phase posts each `code-review` finding as a resolvable MR discussion
 * (see the orchestrator decomposition doc, §"The MR is the review medium").
 * It is the only Phase whose verdict set is a singleton — convergence is
 * decided downstream by `evaluate`, not here.
 */
import { Effect } from "effect";
import type { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "../session/phase";
import { mrPhaseOptions, phaseHandlerError, pipelineContext } from "./runner";

/** Review Phase Module — implements the review state's transition. */
export const reviewPhase = (
  state: Extract<State, { kind: "review" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const { fixCycles } = state;
    yield* runPhaseSession(mrPhaseOptions(state, "review", fixCycles), ["REVIEW_DONE"]).pipe(
      Effect.mapError(phaseHandlerError(`review[${fixCycles}]`)),
    );
    return { kind: "evaluate", ...pipelineContext(state), fixCycles };
  });
