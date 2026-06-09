/**
 * Review Phase — fan a per-agent review out over the diff, aggregate every
 * agent's findings, post them as MR discussions, then advance to `evaluate`.
 *
 * Replaces the single-prompt review session (issue #29). The previous design
 * delegated everything to one `claude` session calling the upstream
 * `code-review` skill via the Task tool — Claude Code 2.1.150 broke that path
 * by giving up after ~4 consecutive `end_turn` waits during subagent fan-out.
 *
 * The new shape is: one top-level `claude` session per review agent, run in
 * parallel via {@link runFanOutPhase}; this Phase Module owns the
 * higher-level wiring (read changed files → fan out → aggregate → post →
 * advance) and keeps everything testable in isolation. Per-agent failures
 * are best-effort and surface as `error` outcomes in the review object.
 *
 * Posting failures DO NOT block the transition to `evaluate` — a stuck
 * GitLab API call shouldn't lose all the findings that *did* land on disk,
 * and `evaluate` reads from the MR itself anyway (so it'll naturally see
 * whatever was posted).
 */
import { readFile } from "node:fs/promises";
import { Console, Effect } from "effect";
import { buildIntentBlock, planFilePath } from "../intent";
import { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { Environment } from "../preflight";
import { describeProviderError } from "../provider/types";
import { RunArtifacts } from "../run-artifacts";
import type { GitProvider } from "../provider/provider";
import { aggregateFindings } from "../review/aggregate";
import { postReviewToMr } from "../review/post";
import { readChangedFiles } from "../review/read-changed-files";
import { DEFAULT_MCP_CONFIG_PATH, DEFAULT_TEMPLATES_DIR, runFanOutPhase } from "../session/fanout";
import { phaseHandlerError, pipelineContext } from "./runner";

/** Review Phase Module — implements the review state's transition. */
export const reviewPhase = (
  state: Extract<State, { kind: "review" }>,
  env: Environment,
): Effect.Effect<State, HandlerError, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    const { fixCycles, issue, worktree, deadline, pullRequestIid } = state;
    const tag = `review[${fixCycles}]`;

    const files = yield* readChangedFiles({ worktree, defaultBranch: env.defaultBranch }).pipe(
      Effect.mapError(
        (error) =>
          new HandlerError({
            reason: `${tag}: readChangedFiles ${error.operation} — ${error.reason}`,
            fate: "interruption",
          }),
      ),
    );

    // Author intent (issue + approved plan) so reviewers don't re-flag the
    // author's deliberate decisions as bugs (#84). Best-effort: the plan is
    // read back from where the `plan` phase persisted it; a missing file (e.g.
    // a resume into a fresh run dir) degrades to the issue-only intent, and an
    // empty issue body with no plan degrades to no intent block at all.
    const plan = yield* Effect.tryPromise(() =>
      readFile(planFilePath(artifacts.dir, issue.iid), "utf8"),
    ).pipe(Effect.catchAll(() => Effect.succeed("")));
    const intentBlock = buildIntentBlock(issue, plan);

    const fanOut = yield* runFanOutPhase({
      phase: "review",
      issueIid: issue.iid,
      worktree,
      iteration: fixCycles,
      deadline,
      defaultBranch: env.defaultBranch,
      files,
      templatesDir: DEFAULT_TEMPLATES_DIR,
      mcpConfigPath: DEFAULT_MCP_CONFIG_PATH,
      intentBlock,
    }).pipe(Effect.mapError(phaseHandlerError(tag)));

    // When every fan-out agent failed (timed out / verdict-reprompt loop / error),
    // this is an infrastructure failure of the iteration — not "no findings".
    // Advancing to evaluate would re-run another full fan-out against the same
    // diff. Abort and let a human inspect the run.
    if (fanOut.okCount === 0) {
      yield* artifacts.logEvent({
        event: "review_fanout_sterile",
        issueIid: issue.iid,
        iteration: fixCycles,
        okCount: fanOut.okCount,
        totalCount: fanOut.totalCount,
      });
      return yield* Effect.fail(
        new HandlerError({
          reason: `${tag}: review_fanout_sterile — 0/${fanOut.totalCount} agents reached AGENT_DONE`,
          fate: "stall",
        }),
      );
    }

    const review = yield* aggregateFindings(fanOut, { issueIid: issue.iid, iteration: fixCycles }).pipe(
      Effect.mapError(
        (error) =>
          new HandlerError({
            reason: `${tag}: aggregate ${error.agent} — ${error.reason}`,
            fate: "interruption",
          }),
      ),
    );

    // Best-effort: posting failures get logged but don't fail the phase. The
    // evaluate phase reads from the MR — if posts dropped, evaluate will see
    // a thinner review, but the pipeline keeps moving instead of stalling.
    yield* postReviewToMr({ mrIid: pullRequestIid, review, issueIid: issue.iid, iteration: fixCycles }).pipe(
      Effect.catchAll((error) =>
        Console.error(`  ⚠ ${tag}: post failed — ${describeProviderError(error)}`),
      ),
    );

    return { kind: "evaluate", ...pipelineContext(state), fixCycles };
  });
