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
import { Console, Effect } from "effect";
import { HandlerError } from "../pipeline/errors";
import type { State } from "../pipeline/state";
import type { Environment } from "../preflight";
import { describeProviderError } from "../provider/types";
import type { RunArtifacts } from "../run-artifacts";
import { GitProvider } from "../provider/provider";
import { aggregateFindings } from "../review/aggregate";
import { postReviewToMr } from "../review/post";
import { readChangedFiles } from "../review/read-changed-files";
import { describePhaseError } from "../session/errors";
import { DEFAULT_TEMPLATES_DIR, runFanOutPhase } from "../session/fanout";
import { pipelineContext } from "./runner";

/** Review Phase Module — implements the review state's transition. */
export const reviewPhase = (
  state: Extract<State, { kind: "review" }>,
  env: Environment,
): Effect.Effect<State, HandlerError, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const { fixCycles, issue, worktree, deadline, pullRequestIid } = state;
    const tag = `review[${fixCycles}]`;

    const files = yield* readChangedFiles({ worktree, defaultBranch: env.defaultBranch }).pipe(
      Effect.mapError(
        (error) => new HandlerError({ reason: `${tag}: readChangedFiles ${error.operation} — ${error.reason}` }),
      ),
    );

    const fanOut = yield* runFanOutPhase({
      phase: "review",
      issueIid: issue.iid,
      worktree,
      iteration: fixCycles,
      deadline,
      defaultBranch: env.defaultBranch,
      files,
      templatesDir: DEFAULT_TEMPLATES_DIR,
    }).pipe(
      Effect.mapError(
        (error) => new HandlerError({ reason: `${tag}: ${describePhaseError(error)}` }),
      ),
    );

    const review = yield* aggregateFindings(fanOut).pipe(
      Effect.mapError(
        (error) => new HandlerError({ reason: `${tag}: aggregate ${error.agent} — ${error.reason}` }),
      ),
    );

    // Best-effort: posting failures get logged but don't fail the phase. The
    // evaluate phase reads from the MR — if posts dropped, evaluate will see
    // a thinner review, but the pipeline keeps moving instead of stalling.
    yield* postReviewToMr({ mrIid: pullRequestIid, review }).pipe(
      Effect.catchAll((error) =>
        Console.error(`  ⚠ ${tag}: post failed — ${describeProviderError(error)}`),
      ),
    );

    return { kind: "evaluate", ...pipelineContext(state), fixCycles };
  });
