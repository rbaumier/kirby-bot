/**
 * QA Phase — TEMPORARILY DISABLED.
 *
 * The runtime dogfood gate is currently bypassed: the phase no-ops to
 * `merge` without spawning a `claude` session. Tracked by #37 — the
 * orchestrator + dogfood-skill rework landed in `4c705c9`, but until
 * we have a green run end-to-end with the new flow, we route around it
 * rather than risk a regression on the merge path.
 *
 * To re-enable: `git revert` this file (or restore from the prior
 * commit `c324d17`) and the session-driven QA returns unchanged.
 */
import { Effect } from "effect";
import type { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import { RunArtifacts } from "../run-artifacts";
import { pipelineContext } from "./runner";

/** QA Phase Module — currently a pass-through; see file header. */
export const qaPhase = (
  state: Extract<State, { kind: "qa" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    yield* artifacts.logEvent({
      event: "qa_skipped",
      issueIid: state.issue.iid,
      iteration: state.fixCycles,
      reason: "qa phase temporarily disabled — see src/phases/qa.ts header",
    });
    return { kind: "merge", ...pipelineContext(state) };
  });
