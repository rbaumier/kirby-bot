/**
 * Run_dogfood Phase — the runtime gate; `DOGFOOD_PASS` advances to merge.
 *
 * Always spawned by the orchestrator; the Session self-skips when no
 * user-facing surface was touched (see the orchestrator decomposition doc).
 * `DOGFOOD_FAIL` is a real, in-scope bug — fail the issue.
 */
import { Effect } from "effect";
import { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "../session/phase";
import { mrPhaseOptions, phaseRunHandlerError, pipelineContext } from "./runner";

/** Run_dogfood Phase Module — implements the run_dogfood state's transition. */
export const runDogfoodPhase = (
  state: Extract<State, { kind: "run_dogfood" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const verdict = yield* runPhaseSession(
      mrPhaseOptions(state, "run_dogfood", 0),
      ["DOGFOOD_PASS", "DOGFOOD_FAIL"],
    ).pipe(Effect.mapError(phaseRunHandlerError("run_dogfood")));

    if (verdict === "DOGFOOD_PASS") {
      return { kind: "merge", ...pipelineContext(state) };
    }
    return yield* Effect.fail(
      new HandlerError({
        reason: "run_dogfood: the runtime dogfood gate found an in-scope bug",
      }),
    );
  });
