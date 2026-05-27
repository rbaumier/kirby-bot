/**
 * Evaluate Phase — the sole convergence authority.
 *
 * `CONVERGED` → `qa`. `NEEDS_FIX` → `fix`, unless the fix-cycle cap
 * is reached. A 4th NEEDS_FIX is a structural disagreement, not a slow fix;
 * end the issue for a human to look at.
 *
 * The session also writes a per-Finding `triage.json` (see `evaluate.md`); we
 * read it back, best-effort, and log it as `triage_results` so the run stats
 * can attribute each accept/reject to its review agent. A missing or malformed
 * file degrades to no event — it never changes the verdict or fails the phase.
 */
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import type { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import { RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "../session/phase";
import { parseTriageFile, type TriageRow } from "../stats/events";
import { mrPhaseOptions, phaseHandlerError, pipelineContext, toFixUnlessCapped } from "./runner";

/** Read and tolerantly parse the session's `triage.json`; never fails. */
const readTriageRows = (path: string): Effect.Effect<TriageRow[]> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.map(parseTriageFile),
    Effect.catchAll(() => Effect.succeed<TriageRow[]>([])),
  );

/** Evaluate Phase Module — implements the evaluate state's transition. */
export const evaluatePhase = (
  state: Extract<State, { kind: "evaluate" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const { fixCycles } = state;
    const artifacts = yield* RunArtifacts;
    const triageFile = artifacts.triagePath({
      issueIid: state.issue.iid,
      phase: "evaluate",
      iteration: fixCycles,
    });

    const options = mrPhaseOptions(state, "evaluate", fixCycles);
    const verdict = yield* runPhaseSession(
      { ...options, replacements: { ...options.replacements, triage_file: triageFile } },
      ["CONVERGED", "NEEDS_FIX"],
    ).pipe(Effect.mapError(phaseHandlerError(`evaluate[${fixCycles}]`)));

    const triages = yield* readTriageRows(triageFile);
    if (triages.length > 0) {
      yield* artifacts.logEvent({
        event: "triage_results",
        issueIid: state.issue.iid,
        iteration: fixCycles,
        triages,
      });
    }

    if (verdict === "CONVERGED") {
      return { kind: "qa", ...pipelineContext(state), fixCycles };
    }
    return yield* toFixUnlessCapped(state, "fix cycles without convergence");
  });
