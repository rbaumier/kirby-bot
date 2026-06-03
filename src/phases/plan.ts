/**
 * Plan Phase — vet the *approach* before any code is written (#75).
 *
 * A cheap gate between `branch_push` and `implementation`. The session produces
 * a lightweight plan (approach + architecture, not line-level detail), spawns an
 * independent reviewer subagent that did NOT write the plan to vet it against the
 * issue and the real codebase, and loops until the approach is sound or it can
 * name a concrete blocker:
 *   - `PLAN_DONE` → `implementation`, carrying the approved plan the session
 *     wrote so the implementer follows the vetted approach instead of
 *     re-planning from scratch.
 *   - `BLOCKER_SUSPECTED` → `HandlerError` with the `failure` fate (a wrong
 *     approach the reviewer could not approve is for a human, not a retry).
 *
 * Structurally a clone of `implementation` minus the timeout-salvage: a plan
 * session produces a plan file, not commits, so there is nothing to salvage.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { freshDeadline } from "../deadline";
import { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import { RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "../session/phase";
import { phaseHandlerError } from "./runner";

/**
 * Read back the approved plan the session wrote, best-effort. A `PLAN_DONE`
 * with no readable plan file is a session glitch, not a reason to fail the
 * attempt: thread a clear placeholder so the implementation prompt still
 * renders, and the gap is visible to whoever reads the run.
 */
const readApprovedPlan = (path: string): Effect.Effect<string> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.map((text) => text.trim()),
    Effect.catchAll(() => Effect.succeed("")),
    Effect.map((text) =>
      text === "" ? "(the plan session emitted PLAN_DONE but wrote no plan file)" : text,
    ),
  );

/** Plan Phase Module — implements the plan state's transition. */
export const planPhase = (
  state: Extract<State, { kind: "plan" }>,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const { issue, branch, worktree } = state;
    const deadline = yield* freshDeadline;
    const artifacts = yield* RunArtifacts;
    // The session writes the approved plan here — in the run dir, NOT the
    // worktree, so the implementer's `git add -A` never commits it.
    const planFile = join(artifacts.dir, `plan-${issue.iid}.md`);

    const verdict = yield* runPhaseSession(
      {
        phase: "plan",
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
          plan_file: planFile,
        },
      },
      ["PLAN_DONE", "BLOCKER_SUSPECTED"],
    ).pipe(Effect.mapError(phaseHandlerError("plan")));

    if (verdict === "PLAN_DONE") {
      const plan = yield* readApprovedPlan(planFile);
      return { kind: "implementation", issue, branch, worktree, plan };
    }
    return yield* Effect.fail(
      new HandlerError({
        reason: "plan: the reviewer could not approve the approach",
        fate: "failure",
      }),
    );
  });
