#!/usr/bin/env bun
/**
 * Main.ts — the AFK orchestrator entry point.
 *
 * The orchestrator is a deterministic state machine. It drives
 * Claude Code through a project's GitLab issue queue, one
 * issue at a time. Each phase runs as a fresh `claude`
 * session in its own tmux window.
 *
 * `BunRuntime.runMain` is the signal-aware runtime. On Ctrl-C
 * it interrupts the fiber so every finalizer runs before exit.
 *
 * Usage: `bun ~/.claude/skills/afk/src/main.ts`.
 */
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Console, Effect } from "effect";
import { runMachine } from "./pipeline/machine";
import { preflight } from "./preflight";
import { selectProvider } from "./provider/select";
import { RunArtifacts, RunArtifactsLive } from "./run-artifacts";

/**
 * Dump the data fields of every tagged failure in `cause`. Effect's default
 * formatter prints only the static `message` of a {@link Data.TaggedError},
 * dropping `status` / `body` / `path` — exactly the fields needed to triage
 * a 4xx. Falls back to `Cause.pretty` for non-tagged or empty causes.
 */
const hasStringTag = (err: object): err is { readonly _tag: string } =>
  "_tag" in err && typeof err._tag === "string";

const describeFailure = (err: unknown): string => {
  if (typeof err !== "object" || err === null) {
    return String(err);
  }
  const label = hasStringTag(err) ? err._tag : "Error";
  return `${label} ${JSON.stringify(err, null, 2)}`;
};

const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
  const failures = [...Cause.failures(cause)];
  if (failures.length === 0) {
    return Cause.pretty(cause);
  }
  return failures.map(describeFailure).join("\n\n");
};

/** Append a `run_error` to the JSONL and mirror a structured dump to stderr. */
const reportRunFailure = (
  cause: Cause.Cause<unknown>,
): Effect.Effect<void, never, RunArtifacts> =>
  Effect.gen(function* () {
    const detail = formatFailureDetail(cause);
    const artifacts = yield* RunArtifacts;
    yield* artifacts.logEvent({ event: "run_error", error: detail });
    yield* Console.error(`\nRun failed — structured detail:\n${detail}`);
  });

const program = preflight.pipe(
  Effect.flatMap((env) => runMachine(env)),
  Effect.tapErrorCause(reportRunFailure),
  Effect.provide(selectProvider()),
  Effect.provide(RunArtifactsLive),
);

BunRuntime.runMain(program);
