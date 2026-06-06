/**
 * Stats/project.ts — the pure projection from a run's event log to statistics.
 *
 * `run.jsonl` is the source of truth (ADR 0002); this module folds its events
 * into per-issue / per-phase / per-agent stats. It is a pure function over the
 * log's lines so it can be tested without a run and replayed on any past run.
 *
 * The accept/reject join is `review_findings ⋈ triage_results` on
 * `discussionId`, scoped per `(issueIid, iteration)` — each review/fix cycle
 * re-posts fresh threads with new ids, so a re-flagged Finding is counted once
 * per iteration rather than conflated across the loop.
 */
import type { ReviewFindingsEvent, TriageResultsEvent, TriageValue } from "./events";

/** Per-agent tallies, aggregated across a single issue's iterations. */
export type AgentStats = {
  agent: string;
  /** Times the agent ran in a fan-out (ok + error outcomes). */
  ran: number;
  ok: number;
  error: number;
  /** Σ per-agent session wall-clock across iterations (ms). */
  totalMs: number;
  /** Findings raised (line-anchored + prose). */
  findings: number;
  accepted: number;
  rejected: number;
  punted: number;
  /** Findings with no matching triage row, or an unrecognized triage value. */
  untriaged: number;
};

/** One iteration's routing + detection snapshot. */
export type RoutingSnapshot = {
  iteration: number;
  routed: string[];
  skipped: string[];
  routerTruncated: boolean;
  trustBoundaries: string[];
  dogfoodRequired: boolean;
  dogfoodSurfaces: string[];
};

type TerminalStatus = "done" | "failed" | "incomplete";
type QaStatus = "pass" | "fail" | "none";

/** Everything the projection knows about one issue. */
export type IssueStats = {
  iid: number;
  title: string;
  totalMs: number;
  phaseDurations: { phase: string; ms: number }[];
  fixCycles: number;
  terminal: TerminalStatus;
  failureReason?: string;
  /**
   * The typed `_tag` of the last end-of-attempt failure cause (`SessionTimedOut`,
   * `ProviderHttpError`, `TmuxError`, …), captured for `failed` / `stalled` /
   * `interrupted` alike. Absent when no attempt failed, or the failure carried
   * no typed cause. Lets analytics group attempts by failure type without
   * regexing `failureReason`.
   */
  errorType?: string;
  /** The PR/MR iid this issue's branch opened, once known. */
  pullRequestIid?: number;
  qa: QaStatus;
  agents: AgentStats[];
  routing: RoutingSnapshot[];
};

export type RunStats = {
  repo?: string;
  defaultBranch?: string;
  issues: IssueStats[];
};

const asNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Which `AgentStats` tally a triage value increments (absent triage → untriaged). */
type TriageBucket = "accepted" | "rejected" | "punted" | "untriaged";

/** Exhaustive map: a new `TriageValue` is a compile error until it picks a bucket. */
const TRIAGE_BUCKET: Record<TriageValue, TriageBucket> = {
  real: "accepted",
  "real-but-bloated-remedy": "accepted",
  imagined: "rejected",
  punt: "punted",
  unknown: "untriaged",
};

/** Mutable accumulator, one per issue, finalized into IssueStats at the end. */
type IssueAcc = {
  iid: number;
  title: string;
  totalMs: number;
  phaseMs: Map<string, number>;
  fixCycles: number;
  terminal: TerminalStatus;
  failureReason: string | undefined;
  errorType: string | undefined;
  pullRequestIid: number | undefined;
  qa: QaStatus;
  agents: Map<string, AgentStats>;
  routing: RoutingSnapshot[];
  /** discussionId → triage, keyed by iteration, for the offline join. */
  triageByIteration: Map<number, Map<string, TriageValue>>;
  reviewFindings: ReviewFindingsEvent[];
};

const emptyAgent = (agent: string): AgentStats => ({
  agent,
  ran: 0,
  ok: 0,
  error: 0,
  totalMs: 0,
  findings: 0,
  accepted: 0,
  rejected: 0,
  punted: 0,
  untriaged: 0,
});

const issueAcc = (iid: number): IssueAcc => ({
  iid,
  title: "",
  totalMs: 0,
  phaseMs: new Map(),
  fixCycles: 0,
  terminal: "incomplete",
  failureReason: undefined,
  errorType: undefined,
  pullRequestIid: undefined,
  qa: "none",
  agents: new Map(),
  routing: [],
  triageByIteration: new Map(),
  reviewFindings: [],
});

const agentOf = (acc: IssueAcc, name: string): AgentStats => {
  const existing = acc.agents.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const fresh = emptyAgent(name);
  acc.agents.set(name, fresh);
  return fresh;
};

/** Classify one Finding against its thread's triage, mutating the agent row. */
const tally = (agent: AgentStats, count: number, triage: TriageValue | undefined): void => {
  agent.findings += count;
  agent[triage === undefined ? "untriaged" : TRIAGE_BUCKET[triage]] += count;
};

/** Fold every `review_findings` against the matching iteration's triage map. */
const resolveFindings = (acc: IssueAcc): void => {
  for (const event of acc.reviewFindings) {
    const triageMap = acc.triageByIteration.get(event.iteration) ?? new Map<string, TriageValue>();
    for (const finding of event.findings) {
      tally(agentOf(acc, finding.agent), 1, triageMap.get(finding.discussionId));
    }
    if (event.prose !== undefined) {
      const proseTriage = triageMap.get(event.prose.discussionId);
      for (const { agent, count } of event.prose.byAgent) {
        tally(agentOf(acc, agent), count, proseTriage);
      }
    }
  }
};

/** Fold a parsed event into the per-issue accumulators. */
const applyEvent = (event: Record<string, unknown>, issues: Map<number, IssueAcc>): void => {
  const kind = asStr(event.event);
  const get = (iid: number): IssueAcc => {
    const existing = issues.get(iid);
    if (existing !== undefined) {
      return existing;
    }
    const fresh = issueAcc(iid);
    issues.set(iid, fresh);
    return fresh;
  };

  if (kind === "transition") {
    const issue = event.issue as { iid?: unknown; title?: unknown } | null | undefined;
    const iid = asNum(issue?.iid);
    if (iid === undefined) {
      return;
    }
    const acc = get(iid);
    const title = asStr(issue?.title);
    if (title !== undefined && acc.title === "") {
      acc.title = title;
    }
    const from = asStr(event.from) ?? "?";
    const to = asStr(event.to);
    const ms = asNum(event.elapsedMs) ?? 0;
    const prIid = asNum(event.pullRequestIid);
    if (prIid !== undefined) {
      acc.pullRequestIid = prIid;
    }
    acc.totalMs += ms;
    acc.phaseMs.set(from, (acc.phaseMs.get(from) ?? 0) + ms);
    if (to === "fix") {
      acc.fixCycles += 1;
    }
    if (to === "done") {
      acc.terminal = "done";
      // A finished issue carries no failure cause: clear any errorType a prior
      // stalled/interrupted attempt left on the accumulator. Those fates
      // re-queue the issue, so `stalled → re-pick → done` is reachable in one
      // run, and a stale errorType would mislabel a success.
      acc.errorType = undefined;
    } else if (to === "failed") {
      acc.terminal = "failed";
      acc.failureReason = asStr(event.note);
    }
    // Capture the typed failure cause for every end-of-attempt fate, not just
    // `failed`: a `stalled` / `interrupted` attempt re-queues the issue but its
    // cause is exactly what these analytics need. Last writer wins across an
    // issue's re-picks within one run; a later `done` clears it (above).
    if (to === "failed" || to === "stalled" || to === "interrupted") {
      const errorType = asStr(event.errorType);
      if (errorType !== undefined) {
        acc.errorType = errorType;
      }
    }
    if (from === "qa") {
      acc.qa = to === "merge" ? "pass" : "fail";
    }
    return;
  }

  if (kind === "fanout_complete") {
    const iid = asNum(event.issueIid);
    if (iid === undefined) {
      return;
    }
    const acc = get(iid);
    const outcomes = Array.isArray(event.outcomes) ? event.outcomes : [];
    for (const raw of outcomes) {
      const outcome = raw as Record<string, unknown>;
      const name = asStr(outcome.agent);
      if (name === undefined) {
        continue;
      }
      const agent = agentOf(acc, name);
      agent.ran += 1;
      agent.totalMs += asNum(outcome.totalMs) ?? 0;
      if (asStr(outcome.kind) === "ok") {
        agent.ok += 1;
      } else {
        agent.error += 1;
      }
    }
    return;
  }

  if (kind === "fanout_plan") {
    const iid = asNum(event.issueIid);
    if (iid === undefined) {
      return;
    }
    const planAcc = get(iid);
    planAcc.routing = [
      ...planAcc.routing,
      {
        iteration: asNum(event.iteration) ?? 0,
        routed: asStrArr(event.agents),
        skipped: asStrArr(event.skippedAgents),
        routerTruncated: event.routerTruncated === true,
        trustBoundaries: asStrArr(event.trustBoundaries),
        dogfoodRequired: event.dogfoodRequired === true,
        dogfoodSurfaces: asStrArr(event.dogfoodSurfaces),
      },
    ];
    return;
  }

  if (kind === "review_findings") {
    const iid = asNum(event.issueIid);
    if (iid === undefined) {
      return;
    }
    const findingsAcc = get(iid);
    findingsAcc.reviewFindings = [...findingsAcc.reviewFindings, event as unknown as ReviewFindingsEvent];
    return;
  }

  if (kind === "triage_results") {
    const iid = asNum(event.issueIid);
    if (iid === undefined) {
      return;
    }
    const typed = event as unknown as TriageResultsEvent;
    const map = get(iid).triageByIteration.get(typed.iteration) ?? new Map<string, TriageValue>();
    for (const row of typed.triages) {
      map.set(row.discussionId, row.triage);
    }
    get(iid).triageByIteration.set(typed.iteration, map);
  }
};

const finalize = (acc: IssueAcc): IssueStats => ({
  iid: acc.iid,
  title: acc.title,
  totalMs: acc.totalMs,
  phaseDurations: Array.from(acc.phaseMs.entries(), ([phase, ms]) => ({ phase, ms }))
    .toSorted((a, b) => b.ms - a.ms),
  fixCycles: acc.fixCycles,
  terminal: acc.terminal,
  ...(acc.failureReason === undefined ? {} : { failureReason: acc.failureReason }),
  ...(acc.errorType === undefined ? {} : { errorType: acc.errorType }),
  ...(acc.pullRequestIid === undefined ? {} : { pullRequestIid: acc.pullRequestIid }),
  qa: acc.qa,
  agents: [...acc.agents.values()].toSorted((a, b) => b.findings - a.findings || a.agent.localeCompare(b.agent)),
  routing: acc.routing,
});

/**
 * Fold a run's `run.jsonl` lines into {@link RunStats}. Lines that do not parse
 * as JSON are skipped — a torn final line never aborts the projection.
 */
export const projectRunStats = (lines: readonly string[]): RunStats => {
  const issues = new Map<number, IssueAcc>();
  let repo: string | undefined = undefined;
  let defaultBranch: string | undefined = undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed === null) { continue; }
    if (parsed.event === "run_start") {
      repo = asStr(parsed.repo);
      defaultBranch = asStr(parsed.defaultBranch);
    }
    applyEvent(parsed, issues);
  }

  const ordered = [...issues.values()].toSorted((a, b) => a.iid - b.iid);
  for (const acc of ordered) {
    resolveFindings(acc);
  }
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    issues: ordered.map(finalize),
  };
};
