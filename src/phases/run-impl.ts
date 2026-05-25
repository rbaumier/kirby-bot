/**
 * Run_impl Phase — start the budget, run the implementer Session.
 *
 * Mints the per-issue deadline (`Date.now() + ISSUE_BUDGET_MS`) so every later
 * Phase shares one wall-clock budget. Routes the verdict next:
 * `READY_FOR_REVIEW` → `open_draft_mr`; `BLOCKER_SUSPECTED` → `HandlerError`
 * (the seam reroutes to `failed`).
 */
import { Effect } from "effect";
import { ISSUE_BUDGET_MS } from "../config";
import { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "../session/phase";
import { phaseHandlerError } from "./runner";

/** Run_impl Phase Module — implements the run_impl state's transition. */
export const runImplPhase = (
  state: Extract<State, { kind: "run_impl" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const { issue, branch, worktree } = state;
    const deadline = Date.now() + ISSUE_BUDGET_MS;

    const verdict = yield* runPhaseSession(
      {
        phase: "run_impl",
        issueIid: issue.iid,
        worktree,
        deadline,
        iteration: 0,
        replacements: {
          iid: String(issue.iid),
          title: issue.title,
          branch,
          worktree,
          body: issue.body === "" ? "(no description)" : issue.body,
        },
      },
      ["READY_FOR_REVIEW", "BLOCKER_SUSPECTED"],
    ).pipe(Effect.mapError(phaseHandlerError("run_impl")));

    if (verdict === "READY_FOR_REVIEW") {
      return { kind: "open_draft_mr", issue, branch, worktree, deadline };
    }
    return yield* Effect.fail(
      new HandlerError({ reason: "run_impl: the implementer reported a blocker" }),
    );
  });
