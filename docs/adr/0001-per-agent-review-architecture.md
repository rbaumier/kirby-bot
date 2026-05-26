# ADR 0001 — Per-agent review architecture

**Status:** accepted
**Date:** 2026-05-26
**Issue:** [#29](https://gitlab.com/.../issues/29) — review phase hangs after fan-out

## Context

The orchestrator's `review` phase originally ran as a single `claude` tmux
session that loaded the upstream `code-review` skill. The skill spawned its
~12-agent fan-out via the Task tool inside that one parent session. The
parent session emitted `REVIEW_DONE` once every subagent had returned.

Claude Code 2.1.150 broke this path. The Stop-hook's `decision: "block"`
return stopped being honored after roughly 4 consecutive `end_turn` waits
during subagent fan-out — the parent session gave up and tore down its
shell while subagents were still running. Sessions emitted `REVIEW_DONE`
late or not at all, the orchestrator hit `BudgetExhausted` mid-fan-out,
the phase failed, and the issue rolled to `failed-by-agent` despite no
actual review work going wrong.

The single-session shape had three other costs that compounded the bug:

1. **One model, many roles.** Every agent inherited the parent session's
   model (typically Opus). Measured leak: 5× the prescribed Sonnet/Haiku
   cost for ~70% of the panel. Templates exist that pin per-agent models
   but the in-Task spawn discarded them.
2. **No per-agent isolation.** A hung agent blocked the whole session
   (one `end_turn` wait counts against every other agent's budget).
3. **Coupling to a skill repo.** The orchestrator's review fidelity was a
   moving target because the `code-review` skill in `~/.claude/skills/`
   could drift from what the orchestrator was tested against. There was no
   commit pinning the skill version the orchestrator depended on.

## Decision

Replace the single-session fan-out with **N parallel top-level `claude`
sessions**, one per review agent, orchestrated in TypeScript via
`Effect.forEach` with `concurrency: MAX_CONCURRENT_AGENTS`. The Phase
Module owns the wiring; per-agent prompts are rendered from vendored
templates checked into `assets/code-review-templates/`.

Concretely:

- **`src/review/agents.ts`** — the **single CRUD surface** for the agent
  registry. Each row carries `model`, `description`, `prompt`. The
  `description` is the routing rule — it goes verbatim to the routing
  haiku. Adding / removing / re-tiering an agent is a one-row edit;
  `AgentName = keyof typeof AGENTS_DATA` means the compiler flags every
  stale reference elsewhere.
- **`src/review/detect-tables.ts`** — the two tables that are NOT
  per-agent: trust-boundary signals (substituted into every line-anchored
  prompt) and dogfood-gate categories (drives the runtime 3-persona
  gate). Tier/path heuristics are gone — the router decides spawn.
- **`src/review/detect.ts`** — `analyzeReviewInputs(files)` returns the
  trust boundaries + dogfood categories + totals. Pure on `ChangedFile[]`,
  no agent selection.
- **`src/review/router.ts`** — `routeAgents()`: one haiku tmux session
  that reads the diff (head-truncated to ~100KB) + the agent catalog
  (name + description) and returns the subset of agents to spawn, plus
  each agent's scoped file list. Replaces every previous spawn heuristic
  (path substring, extension list, import substring, subsystem trigger).
  Failure modes (malformed JSON, unknown agent name, empty list) abort
  the phase by design — there is no heuristic fallback.
- **`src/review/render-prompt.ts`** — per-agent prompt rendering. Wraps
  the line-anchored scaffold around role bodies, injects `{diff_file}`,
  `{file_list}`, `{trust_boundaries}`, `{previous_findings_block}`,
  `{findings_file}`. Forbids the Task tool. Ends with `VERDICT: AGENT_DONE`.
- **`src/review/diff-slices.ts`** — per-agent diff slices written
  atomically to disk so each agent sees only the files the router scoped
  it to. Full-diff agents (`files: []` in the router output) share the
  single `fullDiffPath` — no extra `git diff` per agent.
- **`src/session/fanout.ts`** — `runFanOutPhase`. Writes the Stop-hook
  config, writes the full diff once (reused as both router input and
  full-diff `{diff_file}`), routes via haiku, analyzes trust boundaries,
  writes per-agent slices, spawns one session per agent via
  `Effect.forEach` capped at 6 concurrent, returns `AgentOutcome[]`.
  Per-agent failures degrade to `error` outcomes; they do not bubble.
  Routing failures, by contrast, DO bubble — by design.
- **`src/review/aggregate.ts`** — reads each agent's `findings-*.json`
  off disk and merges them into one `AggregatedReview`. Tolerant: missing
  or malformed files surface as `no-findings`, never abort the phase.
- **`src/review/post.ts`** — translates the aggregated review into MR
  discussions through the `GitProvider` tag. Preserves the existing body
  header contract (`severity: <severity> | <file>:<line>`) that the
  evaluate phase parses. Prose findings collapse into one summary thread.
- **`src/phases/review.ts`** — the Phase Module. Reads changed files,
  fans out, aggregates, posts (best-effort), advances to `evaluate`.

Per-session isolation rides on the existing tmux session boundary plus a
new `$AGENT_SENTINEL` env var; the shared Stop-hook script reads the env
var to know which sentinel to write into.

## Consequences

### Wins

- **Bug fixed.** Each session is its own top-level `claude` process, so
  the Stop-hook `decision: "block"` regression in Claude Code 2.1.150
  doesn't apply — no in-process Task tool fan-out is happening.
- **Per-agent models.** `AGENTS` (in `src/review/agents.ts`) is the
  single source of truth — one row per agent, carrying `model`,
  `description`, and `prompt`. `AgentName = keyof typeof AGENTS_DATA`
  forces every consumer to use a known name (compile error otherwise).
  No more silent Opus inheritance.
- **Spawn decisions are semantic, not heuristic.** A haiku reads the
  diff and the agent catalog and picks who fires — no more path-fragment
  guesses (`/auth/`, `/billing/`, `/api/`) or extension-list bookkeeping.
  Adding a new specialist agent is a one-row edit to `AGENTS` with a
  description; the router learns from the description verbatim.
- **Failure isolation.** One hung agent costs that agent's outcome, not
  the whole phase. The aggregate result still includes findings from the
  N-1 healthy agents.
- **Vendored templates.** The review fidelity is now pinned to a commit
  in this repo (`assets/code-review-templates/`). The orchestrator is no
  longer at the mercy of the user's `~/.claude/skills/` snapshot.
- **Concurrency cap.** `MAX_CONCURRENT_AGENTS = 6` keeps API pressure
  bounded; the queue absorbs the rest. The previous single-session
  shape had no such cap — fan-outs of 12+ agents hit rate limits.

### Costs

- **`PHASE_CAP_MINUTES.review` bumped from 25 → 35.** Per-agent sessions
  carry their own bootstrap and shutdown overhead; the cap is now the
  per-agent wall-clock, not the aggregate one. 35 min gives a Full-tier
  panel (12–15 agents) at 6 concurrent comfortable headroom on slow days.
- **One extra haiku call per phase.** The router runs a one-shot haiku
  tmux session before the fan-out. Measured overhead: ~10–30 s wall-clock
  and a haiku-tier API call on a ~100KB diff (≤ 30 k tokens). Negligible
  next to the ~30 min fan-out itself.
- **Routing failures fail the phase.** A malformed router output, an
  unknown agent name, or an empty agent list aborts the review by
  design. Any fallback heuristic would re-introduce the brittleness the
  router was meant to replace. The aggregate cost is rare review re-runs
  versus permanent fragile path-fragment matching across the codebase.
- **More moving parts.** Detection tables, the analyzer, the router,
  the renderer, the slicer, the fan-out runner, the aggregator, and the
  poster are all separate modules. Each has its own tests. The
  TypeScript side now carries the weight that the skill previously
  carried.
- **No more `assets/prompts/review.md`.** Deleted as part of Step 14 —
  the file is orphaned by the new shape. The remaining four phase
  prompts (`run_impl`, `evaluate`, `fix`, `run_dogfood`) still use
  `renderPrompt`, whose accepted phase type is now narrowed to
  `PromptablePhase = Exclude<Phase, "review">`.

### Out of scope (not addressed by this ADR)

- Re-running the dogfood gate in TypeScript. The current `run_dogfood`
  phase still uses the single-session shape. Issue #29 only affected the
  review fan-out, so dogfood was left alone.
- Cross-iteration previous-findings handoff. The fan-out passes an empty
  `previous_findings_block` for now; re-review on iteration 2+ does not
  yet receive its prior findings. This is a known follow-up.
- Dynamic concurrency. `MAX_CONCURRENT_AGENTS` is a static config knob,
  not adaptive to local CPU / API quota.

## Routing: heuristic → haiku

The first cut of this architecture mirrored the upstream `code-review`
skill's spawn rules verbatim: tier classification (`Lite` / `Full`
gated on line count + file count + a `HIGH_STAKES_PATH_FRAGMENTS` list),
per-agent `triggers` (one of `extensions` / `pathFragments` / `imports` /
`codePatterns` matched against `ChangedFile[]`), an `alwaysIn` field on
each agent saying which tiers it fires in by default. Three problems
surfaced in dogfooding:

1. **Path fragments are brittle.** `/auth/`, `/billing/`, `/cron/` are
   conventions, not contracts. A repo that puts billing flow in
   `services/payments/` silently routed around `billing-subsystem`.
   Maintaining the fragment list per repo would defeat the abstraction.
2. **Surface heuristics are coarse.** `ui-ux` triggered on any `.tsx`
   under `/app/`; `api-design` on any `.ts` under `/api/`. False
   positives were frequent (utility files in those trees), false
   negatives were silent (UI components living elsewhere).
3. **The CRUD surface multiplied.** Adding a new specialist agent
   required: a row in `AGENTS`, a row in `AGENT_MODELS`, a `triggers`
   block on the row, and sometimes an `alwaysIn` flag and a path
   fragment in `HIGH_STAKES_PATH_FRAGMENTS`. Four files for one agent.

The router refactor collapses every spawn rule into one
`description: string` per row, fed verbatim to a haiku that reads the
diff. Trade-offs we made deliberately:

- **One extra haiku call per phase.** Cheap (~10–30 s, haiku-tier
  pricing). Buys semantic routing instead of substring routing.
- **The diff is head-truncated to ~100KB.** Per-file equitable budget
  split — every file in the roster reaches the router with at least a
  prefix, so the router always sees every path. On a 50-file diff that's
  ~2KB per file head — enough for the haiku to identify what each file
  does. Bigger diffs would have overflowed our static heuristics anyway.
- **No heuristic fallback.** A failed router fails the phase. Any
  fallback would re-introduce the brittleness the router was meant to
  eliminate; we'd rather investigate one failure than silently degrade
  to the brittle path on every run.
- **The router uses `runOneClaudeSession`, not `claude -p`.** The
  non-interactive `claude -p` mode is not currently available to
  kirby-bot; the tmux-session-with-Stop-hook pattern is the only path
  with a typed verdict contract. The router emits `VERDICT: ROUTING_DONE`
  and writes a `findings.json` shaped `{ agents: [{name, files}] }`
  exactly like a fan-out agent would.

## References

- `src/review/agents.ts` — agent registry (the single CRUD surface).
- `src/review/router.ts` — routing haiku.
- `src/review/` — implementation modules (detect, render-prompt,
  diff-slices, aggregate, post).
- `src/session/fanout.ts` — the fan-out runner.
- `src/phases/review.ts` — the Phase Module entry point.
- `assets/code-review-templates/` — vendored prompt templates.
- Upstream skill source — `~/.claude/skills/code-review/` (the templates
  in this repo are derived from this tree, pinned at the commit when
  vendored).
