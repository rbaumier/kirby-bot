/**
 * Review/aggregate.ts — read every fan-out agent's findings file off disk and
 * merge them into one structured `AggregatedReview`.
 *
 * Agents write their output to a per-session findings file (path is injected
 * into their prompt by {@link renderAgentPrompt}). The output shape depends on
 * the agent kind:
 *  - **Line-anchored** (Correctness, Tests, Skill, Subsystem, Occam Razor,
 *    CLAUDE.md Compliance) — JSON envelope `{ findings: [...] }` or the
 *    literal text `No findings.`.
 *  - **Self-contained** (Funnel L1/L2, Materiality, Matt Review, Thermo-nuclear)
 *    — prose with each finding prefixed `[must]` or `[suggestion]`, or
 *    `No findings.`.
 *
 * This module is tolerant to malformed output: a missing or unparseable
 * findings file degrades the agent to a `no-findings` row rather than
 * crashing the whole phase. Per-agent failures from the fan-out itself are
 * already surfaced as `{ kind: "error" }` outcomes — we propagate them
 * verbatim into the agent roster.
 */
import { readFile } from "node:fs/promises";
import { Console, Data, Effect } from "effect";
import { RunArtifacts } from "../run-artifacts";
import type { FanOutResult } from "../session/fanout";
import type { AgentName } from "./detect-tables";
import { applyResolutions } from "./resolve-line";

/** Failure when an agent's findings file cannot be read AND we couldn't tolerate it. */
export class AggregateError extends Data.TaggedError("AggregateError")<{
  readonly agent: AgentName;
  readonly reason: string;
}> {}

/** One JSON-envelope finding emitted by a line-anchored agent. */
export type LineAnchoredFinding = {
  readonly agent: AgentName;
  readonly file: string;
  readonly line: number;
  readonly severity: "bug" | "security" | "performance" | "error_handling" | "suggestion";
  readonly confidence: "high" | "medium" | "low";
  readonly signature: string;
  readonly title: string;
  readonly analysisChain: readonly string[];
  readonly fixPrompt: string;
  /**
   * Whether the finding should be posted as a line-anchored discussion. Set by
   * {@link applyResolutions}: `true` when the snippet resolved (or no snippet was
   * available to verify against), `false` when the snippet matched nothing in
   * the diff — those are degraded to a consolidated note rather than dropped.
   */
  readonly anchored: boolean;
};

/**
 * A line-anchored finding straight out of the parser, before line resolution.
 * The `anchored` flag is the one thing the parser can't decide — only
 * {@link applyResolutions}, which matches the snippet against the diff, can.
 */
export type ParsedLineFinding = Omit<LineAnchoredFinding, "anchored">;

type Severity = "must" | "suggestion";

/** One prose finding emitted by a self-contained agent. */
export type ProseFinding = {
  readonly agent: AgentName;
  readonly tag: Severity;
  readonly text: string;
};

/**
 * One row in the agent roster.
 *
 * Discriminates three execution states a downstream caller may need to act on
 * differently:
 *  - `findings` — agent ran, wrote a parseable file with ≥1 finding.
 *  - `no-findings` — agent ran, wrote a parseable file with zero findings
 *    (textual `No findings.` or `{ findings: [] }`). A real clean signal.
 *  - `wrote-nothing` — agent emitted AGENT_DONE but the findings file is
 *    missing or unreadable. Surfaced separately from `no-findings` so the
 *    evaluator can distinguish "ran clean" from "agent never persisted output"
 *    (lost network, file-write race, bug in the role prompt).
 *  - `error` — the fan-out itself failed for this agent (render, write,
 *    session timeout).
 */
export type AgentResult =
  | { readonly agent: AgentName; readonly result: "findings" }
  | { readonly agent: AgentName; readonly result: "no-findings" }
  | { readonly agent: AgentName; readonly result: "wrote-nothing"; readonly reason: string }
  | { readonly agent: AgentName; readonly result: "error"; readonly reason: string };

/** Aggregated review object — the contract `postReviewToMr` consumes. */
export type AggregatedReview = {
  readonly agents: readonly AgentResult[];
  readonly lineAnchoredFindings: readonly LineAnchoredFinding[];
  readonly proseFindings: readonly ProseFinding[];
};

const PROSE_TAG_RE = /^\[(must|suggestion)\]\s+(.+)$/;

const VALID_SEVERITY = new Set([
  "bug",
  "security",
  "performance",
  "error_handling",
  "suggestion",
]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

const asSeverity = (value: unknown): LineAnchoredFinding["severity"] =>
  typeof value === "string" && VALID_SEVERITY.has(value)
    ? (value as LineAnchoredFinding["severity"])
    : "suggestion";

const asConfidence = (value: unknown): LineAnchoredFinding["confidence"] =>
  typeof value === "string" && VALID_CONFIDENCE.has(value)
    ? (value as LineAnchoredFinding["confidence"])
    : "medium";

/**
 * Parse one agent's findings file content into structured findings.
 * Tolerant: malformed JSON → empty result + log line. Unrecognized shapes
 * default to prose parsing.
 */
const parseAgentOutput = (
  agent: AgentName,
  content: string,
): { readonly lineAnchored: readonly ParsedLineFinding[]; readonly prose: readonly ProseFinding[] } => {
  const trimmed = content.trim();
  if (trimmed === "" || trimmed === "No findings.") {
    return { lineAnchored: [], prose: [] };
  }

  // JSON envelope (line-anchored agent). Must start with `{` per the scaffold.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { readonly findings?: readonly unknown[] };
      const raw = Array.isArray(parsed.findings) ? parsed.findings : [];
      const lineAnchored = raw
        .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
        .map((f): ParsedLineFinding => ({
          agent,
          file: typeof f.file === "string" ? f.file : "",
          line: typeof f.line === "number" ? f.line : Number(f.line ?? 0),
          severity: asSeverity(f.severity),
          confidence: asConfidence(f.confidence),
          signature: typeof f.signature === "string" ? f.signature : "",
          title: typeof f.title === "string" ? f.title : "",
          analysisChain: Array.isArray(f.analysis_chain)
            ? f.analysis_chain.filter((line): line is string => typeof line === "string")
            : [],
          fixPrompt: typeof f.fix_prompt === "string" ? f.fix_prompt : "",
        }))
        .filter((f) => f.file !== "" && f.title !== "");
      return { lineAnchored, prose: [] };
    } catch {
      // Fall through — treat malformed JSON as no-findings rather than crashing.
      return { lineAnchored: [], prose: [] };
    }
  }

  // Prose with `[must]` / `[suggestion]` tags (self-contained agent).
  const prose = trimmed
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line): ProseFinding[] => {
      const match = PROSE_TAG_RE.exec(line);
      if (match === null) { return []; }
      const tag = match[1] as Severity;
      const text = match[2] ?? "";
      return text === "" ? [] : [{ agent, tag, text }];
    });
  return { lineAnchored: [], prose };
};

/**
 * `aggregateFindings` — assemble the per-agent outputs of one fan-out into
 * one structured review object.
 *
 * Errors from the fan-out itself (per-agent timeouts, render failures) are
 * preserved verbatim as `result: "error"` rows in the roster so the caller
 * can distinguish "agent ran and was clean" from "agent never finished".
 */
export const aggregateFindings = (
  fanOut: FanOutResult,
  ctx: { readonly issueIid: number; readonly iteration: number },
): Effect.Effect<AggregatedReview, AggregateError, RunArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    const lineAnchored: ParsedLineFinding[] = [];
    const prose: ProseFinding[] = [];
    const agents: AgentResult[] = [];

    for (const outcome of fanOut.outcomes) {
      if (outcome.kind === "error") {
        agents.push({ agent: outcome.agent, result: "error", reason: outcome.reason });
        continue;
      }
      // outcome.kind === "ok" — read findings file off disk. Missing/unreadable
      // file is tolerated (the agent emitted AGENT_DONE but never wrote
      // findings) but surfaced as a distinct `wrote-nothing` roster row so the
      // evaluator can distinguish it from a genuine clean run.
      const readResult = yield* Effect.either(
        Effect.tryPromise({
          try: () => readFile(outcome.findingsPath, "utf8"),
          catch: (cause) => String(cause),
        }),
      );
      if (readResult._tag === "Left") {
        yield* Console.warn(
          `[aggregate] ${outcome.agent} emitted AGENT_DONE but findings file ` +
            `${outcome.findingsPath} is unreadable: ${readResult.left}`,
        );
        agents.push({
          agent: outcome.agent,
          result: "wrote-nothing",
          reason: readResult.left,
        });
        continue;
      }

      const parsed = parseAgentOutput(outcome.agent, readResult.right);
      lineAnchored.push(...parsed.lineAnchored);
      prose.push(...parsed.prose);
      agents.push({
        agent: outcome.agent,
        result: parsed.lineAnchored.length + parsed.prose.length > 0 ? "findings" : "no-findings",
      });
    }

    // Deterministic line resolution — match each finding's verbatim snippet
    // (`analysis_chain[0]`) against its Agent's diff slice and recompute the
    // real line, so the `{ file, line }` posted to the MR is anchored to the
    // diff rather than to the Agent's (often off) count. Findings whose snippet
    // matches nothing in the diff are flagged `anchored: false` and degraded
    // downstream to a consolidated note instead of being dropped.
    const diffByAgent = yield* readDiffSlices(lineAnchored, fanOut.perAgentDiffPath);
    const { findings: resolved, stats } = applyResolutions(lineAnchored, diffByAgent);

    if (stats.total > 0) {
      yield* Console.log(
        `[resolve-line] ${stats.total} line-anchored: ${stats.resolved} resolved ` +
          `(${stats.drifted} drifted), ${stats.unmatched} unmatched→note`,
      );
      yield* artifacts.logEvent({
        event: "review_line_resolution",
        issueIid: ctx.issueIid,
        iteration: ctx.iteration,
        total: stats.total,
        resolved: stats.resolved,
        drifted: stats.drifted,
        unmatched: stats.unmatched,
        drifts: stats.drifts.map((d) => ({
          agent: d.agent,
          file: d.file,
          reported: d.reportedLine,
          resolved: d.resolvedLine,
        })),
      });
    }

    return { agents, lineAnchoredFindings: resolved, proseFindings: prose };
  });

/**
 * Read each emitting Agent's diff slice off disk into a content map for
 * {@link applyResolutions}. Only Agents that produced findings are read, and
 * each unique path is read once (full-diff Agents share `fullDiffPath`). A
 * missing path or read error degrades to `""` — the resolver treats that as
 * "file absent from the slice" and keeps the reported line, never degrading a
 * finding just because its slice couldn't be loaded.
 */
const readDiffSlices = (
  findings: readonly ParsedLineFinding[],
  perAgentDiffPath: ReadonlyMap<AgentName, string>,
): Effect.Effect<ReadonlyMap<AgentName, string>> =>
  Effect.gen(function* () {
    const diffByAgent = new Map<AgentName, string>();
    const cache = new Map<string, string>();
    for (const agent of new Set(findings.map((f) => f.agent))) {
      const path = perAgentDiffPath.get(agent);
      if (path === undefined) {
        diffByAgent.set(agent, "");
        continue;
      }
      if (!cache.has(path)) {
        const read = yield* Effect.either(
          Effect.tryPromise({
            try: () => readFile(path, "utf8"),
            catch: (cause) => String(cause),
          }),
        );
        cache.set(path, read._tag === "Right" ? read.right : "");
      }
      diffByAgent.set(agent, cache.get(path) ?? "");
    }
    return diffByAgent;
  });
