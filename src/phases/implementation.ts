/**
 * Run_impl Phase — start the budget, run the implementer Session.
 *
 * Mints the per-issue deadline (`Clock.currentTimeMillis + ISSUE_BUDGET_MS`) so every later
 * Phase shares one wall-clock budget. Routes the verdict next:
 * `READY_FOR_REVIEW` → `open_draft_mr`; `BLOCKER_SUSPECTED` → `HandlerError`
 * (the seam reroutes to `failed`).
 *
 * On a timeout, salvages the run if the branch is ahead of the default branch
 * (the implementer pushed commits before the cap), advancing to `open_draft_mr`
 * instead of discarding the work (#51).
 */
import { Clock, Console, Effect } from "effect";
import { ISSUE_BUDGET_MS } from "../config";
import { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { Environment } from "../preflight";
import type { RunArtifacts } from "../run-artifacts";
import { runPhaseSession } from "../session/phase";
import { runShellGit } from "../shell";
import { phaseHandlerError } from "./runner";

const MS_PER_SECOND = 1000;

/** Run_impl Phase Module — implements the implementation state's transition. */
export const implementationPhase = (
  state: Extract<State, { kind: "implementation" }>,
  env: Environment,
): Effect.Effect<State, HandlerError, RunArtifacts> =>
  Effect.gen(function* () {
    const { issue, branch, worktree } = state;
    const deadline = (yield* Clock.currentTimeMillis) + ISSUE_BUDGET_MS;

    const verdict = yield* runPhaseSession(
      {
        phase: "implementation",
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
    ).pipe(
      Effect.catchTag("SessionTimedOut", (error) =>
        Console.log(
          `  ↳ implementation timed out after ${Math.round(error.elapsedMs / MS_PER_SECOND)}s` +
            ` — checking for committed work to salvage (#51)`,
        ).pipe(Effect.as("TIMED_OUT" as const)),
      ),
      Effect.mapError(phaseHandlerError("implementation")),
    );

    if (verdict === "TIMED_OUT") {
      const revList = yield* runShellGit(worktree, [
        "rev-list",
        "--count",
        `origin/${env.defaultBranch}..${branch}`,
      ]).pipe(Effect.catchAll(() => Effect.succeed({ stdout: "0", stderr: "" })));
      const commitCount = parseInt(revList.stdout.trim(), 10);
      if (!Number.isNaN(commitCount) && commitCount > 0) {
        yield* Console.log(
          `  ↳ ${commitCount} commit(s) ahead of origin/${env.defaultBranch}` +
            ` — salvaging timed-out implementation to open_draft_mr`,
        );
        return { kind: "open_draft_mr", issue, branch, worktree, deadline } satisfies State;
      }
      return yield* Effect.fail(
        new HandlerError({
          reason: "implementation: timed out with no commits ahead of base",
          fate: "stall",
        }),
      );
    }

    if (verdict === "READY_FOR_REVIEW") {
      return { kind: "open_draft_mr", issue, branch, worktree, deadline };
    }
    return yield* Effect.fail(
      new HandlerError({
        reason: "implementation: the implementer reported a blocker",
        fate: "failure",
      }),
    );
  });
