# ADR 0002 — Run stats as a projection over the event log

**Status:** accepted
**Date:** 2026-05-27

## Context

We want per-run statistics: total duration per Issue, duration per Phase and
per Agent, which Agents emitted Findings and how many, how many Findings were
accepted vs rejected, plus issue-lifecycle and routing breakdowns.

Most of this is already in `run.jsonl` — the run's machine-readable event log.
`transition` events carry `elapsedMs` + `issue.iid` (Phase durations);
`fanout_plan` / `fanout_complete` carry per-Agent `totalMs`, outcomes, routing,
and detection. The one gap is the **Triage** — the `evaluate` Phase's
per-Finding judgment (`real` / `real-but-bloated-remedy` / `imagined` / punt).
That judgment is made inside the `evaluate` claude session and lands only as a
free-text reply plus the GitLab `resolved` flag — which conflates `imagined`
(rejected) with `suggestion` (punted), and is further erased once `fix`
resolves the accepted threads.

## Decision

Treat `run.jsonl` as the single source of truth. Statistics are a **pure
projection** over it, read on demand by a standalone CLI
(`bun src/stats.ts [run-dir]`, default = latest run). Scope is single-run; a
cross-run fold over the same projection is left for later. No separate stats
store is written, so there is no second artifact to keep in sync.

Two new events close the Triage gap, joined offline by the projection on
`discussionId`:

- **`review_findings`** (logged from `post.ts`): one row per posted Finding,
  keyed by `discussionId`, carrying `agent`, `file`, `line`, `severity`, plus
  the `issueIid` + `iteration` of the review that posted it. kirby-bot owns
  the Agent attribution from its in-memory `AggregatedReview` — it is never
  re-derived from the model. This requires `postDiscussion` to return the
  `DiscussionId` instead of `void`, propagated through
  `api → gitlab → provider → post`. Two other callers touch the changed
  signature: `scripts/mr-discussion.ts` (CLI, ignores the value) and the
  `step.test.ts` provider fake (return shape updated).
- **`triage_results`** (logged from `evaluatePhase`): the `evaluate` session
  writes a `triage.json` keyed by `discussionId` (the id it already holds from
  `mr-discussion.ts list`), carrying the raw Triage value, tagged with the same
  `issueIid` + `iteration`. The evaluator only triages `resolved: false`
  threads (`evaluate.md`), so stale resolved threads from prior iterations
  never enter the file. kirby-bot reads it with tolerant parsing (mirrors
  `aggregate.ts`) and logs the event.

The projection joins `review_findings ⋈ triage_results` on `discussionId`,
**scoped per `(issueIid, iteration)`**. Because each review/evaluate/fix cycle
re-posts fresh threads with new ids, a Finding re-flagged across cycles is
counted once per iteration — the projection groups per iteration so accept/
reject counts are not conflated across the loop.

## Considered Options

- **Separate stats store written during the run** — rejected: a second write
  path to keep consistent with the event log, for no gain over a projection.
- **Reconstruct Triage from GitLab after `evaluate`** — rejected: the
  `resolved` flag conflates `imagined` with `suggestion`, and reply text is
  unstructured LLM prose. Brittle, and it would defeat the full-taxonomy goal.
- **Join key `file:line`** — viable without the `postDiscussion` plumbing, but
  ambiguous when two Agents flag the same line. Rejected for `discussionId`,
  which is exact and 1:1 with a thread.
- **LLM self-reported Agent in `triage.json`** — rejected: the headline stat
  (per-Agent accept/reject) would then rest on the model transcribing Agent
  names correctly. kirby-bot already knows the attribution authoritatively.

## Consequences

- `postDiscussion`'s return type changes from `void` to `DiscussionId` across
  the Provider seam — the cost that buys the exact join.
- The `evaluate` prompt gains a contract: write a machine-readable
  `triage.json`. Like the fan-out `findings-*.json`, parsing is tolerant — a
  missing or malformed file degrades stats, never fails the Phase.
- Per-Agent breakdowns exist only for the `review` Phase (the only fan-out).
  Single-session Phases report a Phase duration but no per-Agent split; the
  `evaluate` per-file subagents stay invisible (transcript-only).
- Prose Findings share the single `review-summary:0` discussion; their Triage
  is always a punt. That one `review_findings` row is one-to-many (it lists
  every contributing Agent), so the projection fans it out per Agent when
  tallying — the only row in the model that is not 1:1 with an Agent.
- Token / cost per Phase or Agent is out of scope — it lives only in Claude
  session transcripts (see CLAUDE.md), a separate mining effort.

## References

- `src/run-artifacts.ts` — the event log + `logEvent`.
- `src/review/post.ts` — will log `review_findings`, needs the returned id.
- `src/phases/evaluate.ts` + `assets/prompts/evaluate.md` — will produce and
  log `triage_results`.
- `CONTEXT.md` — **Finding**, **Triage** (distinct from phase-level **Verdict**).
