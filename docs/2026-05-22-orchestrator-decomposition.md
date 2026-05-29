# AFK orchestrator — `run_claude_code` decomposition

Date 2026-05-22. Status: design approved. Scope: replace the monolithic `run_claude_code` state with a script-orchestrated decomposed pipeline. blocker-verifier / ci-fix / conflict states deferred.

## Problem

`run_claude_code` = one Claude session doing everything: implement + `/code-review-loop` (12-agent fan-out, N iterations, triage+fix+dogfood) + emit a token. Compacts on real issues (#590 aborted). The loop is unbounded — can't be bounded inside one LLM context.

Fix: the orchestrator **script** holds the loop. Each phase = a fresh single-job tmux `claude` session. Review state between sessions lives on the **GitLab MR** (discussions), not in files.

## Prereq (done)

`code-review-loop` split → `code-review` (pure read-only pass — fans ~12 agents out, returns a structured findings object) + `code-review-loop`. AFK uses `code-review` directly. `code-review` is **unchanged** by this work — stays standalone-usable; AFK never makes it depend on an MR.

## Hard constraints

1. Subagents can't spawn agents → any fan-out session is L1 (own tmux session).
2. Skill tool runs in-context → composing skills doesn't bound context; only separate sessions do.
3. Orchestrator env doesn't reach a tmux pane's shell.

## State machine

Replaces `run_claude_code` + `open_mr`. `merge` now un-drafts the MR (`--ready`) before merging. Unchanged: `fetch_queue`, `claim_issue`, `branch_worktree`, `done`, `failed`, `end`.

```
branch_worktree
  → run_impl ──BLOCKER_SUSPECTED / timeout──→ failed
  → open_draft_mr            script: glab mr create --draft
  → review ◄─────────────────────────────┐
  → evaluate                             │ FIX_DONE (fixCycles < 3)
       ├─ CONVERGED → run_dogfood         │
       └─ NEEDS_FIX → fix ───────────────┘
                        fixCycles == 3 → failed
  run_dogfood            always spawned; self-skips if no surface touched
       ├─ DOGFOOD_PASS → merge
       └─ DOGFOOD_FAIL / timeout → failed
  merge                      script: glab mr update --ready; glab mr merge
  → done
```

The MR is created **Draft** right after `run_impl`; the whole review loop runs on it; `merge` un-drafts then merges at the end.

## The GitLab MR is the review medium

No `/tmp/` files for cross-session review state. The Draft MR's discussions hold everything:

- `review` posts each `code-review` finding as a **general resolvable MR discussion** — `file:line` in the body text, no diff anchoring.
- `evaluate` replies on each thread, resolves the non-real ones.
- `fix` resolves a thread when it fixes it.
- **Convergence = no unresolved blocking discussion.** Resolved/unresolved is GitLab-native — no `disposition` field invented.
- Crash-safe: state on GitLab, not a dead process's `/tmp`. Visible: the user watches the review trail on the MR.

**General discussions, not positioned diff comments** — positioned needs a `glab api` position object (base/head/start SHA, path, line mapping) that breaks on every `fix` rebase. General discussions still thread + resolve; they just don't render inline on the diff. `scripts/mr-discussion.ts` (`post` / `list` / `resolve`) is then trivial — one `glab api` call with a `body`.

**No dedup — clean-slate each iteration.** `review` resolves any lingering open thread, then posts `code-review`'s full finding set fresh. A fixed finding simply isn't re-flagged (code-review runs on the fixed code); an imagined finding is re-posted and re-dropped by `evaluate` each pass — wasteful but budget-bounded, and it removes all dedup / anti-resurgence machinery.

## Phase sessions

Each = a fresh `claude` tmux session in the worktree. Each ends its final assistant message with a strict `VERDICT: <token>` last line (see Completion mechanism). Each mutating session pushes after every commit.

### run_impl
Prompt `run-impl.md` (new — written fresh; mine old `implementer.md` from git history for `forbidden_blockers` / worktree preflight / anti-hedging; no dependency-stacking refs). Implement, test, commit, push. Verdict: `READY_FOR_REVIEW` / `BLOCKER_SUSPECTED`.

### open_draft_mr
Script, no session. `glab mr create --draft …`. Records the MR IID — carried in state for all later phases.

### review
Prompt `review.md` (new). Resolves any lingering open MR thread (`mr-discussion.ts resolve`); invokes `/code-review`; posts its full finding set fresh as general MR discussions (`file:line` in the body). No dedup. `VERDICT: REVIEW_DONE`. `code-review`'s own `/tmp/` object is consumed in-context within this session — never read across sessions. → evaluate.

### evaluate
Prompt `evaluate.md` (new). The skeptical gate — **read-only, never edits code.** Reads unresolved MR discussions; fans out per-file evaluator subagents (read the cited code, judge `real` / `imagined` / `real-but-bloated-remedy` against the context-verification protocol, embedded verbatim in the prompt). Parent, per thread: `imagined` → reply why + resolve; `suggestion` → reply "left for human" + resolve; `real`/`bloated` → reply with a **verified fix instruction** (the reviewer's fix confirmed against the code, or rewritten to the smallest correct fix), leave unresolved. Verdict: `CONVERGED` (no unresolved blocking thread) / `NEEDS_FIX`. Parent never reads source — thread bodies + subagent verdicts only. Bounded.

### fix
Prompt `fix.md` (new). **Single session, no fan-out** — `evaluate` already verified the (small, post-filter) real set. Reads the unresolved MR threads (each carries `evaluate`'s verified fix instruction); applies them directly, TDD for `bug`/`security`/`performance`/`error_handling`; runs the full suite + linter, fixes failures; commit + push; resolves each fixed thread (reply "fixed in <sha>"). Bounded: a handful of findings across a handful of files. Verdict: `FIX_DONE`. → review.

### run_dogfood
Prompt `run-dogfood.md` (new). Always spawned by the orchestrator — it self-determines whether to do real work: `git diff --name-only` the branch; no user-facing surface touched → `VERDICT: DOGFOOD_PASS` at once, no personas. Otherwise **pure gate — never edits code**: 3 personas (happy-path / adversarial / regression). Out-of-scope bug → `glab issue create`. In-scope bug → `VERDICT: DOGFOOD_FAIL`. Clean → `VERDICT: DOGFOOD_PASS`.

### merge
Script, no session. `glab mr update <iid> --ready` (un-draft), then `glab mr merge`. → done.

## Completion mechanism — Stop hook

A session declares it finished by **ending its final assistant message with a strict verdict line** — the last non-empty line, exactly `VERDICT: <TOKEN>`, with `<TOKEN>` ∈ {`READY_FOR_REVIEW`, `BLOCKER_SUSPECTED`, `REVIEW_DONE`, `CONVERGED`, `NEEDS_FIX`, `FIX_DONE`, `DOGFOOD_PASS`, `DOGFOOD_FAIL`}.

A Claude Code **Stop hook** captures it: harness-fired once per turn when the session yields — the agent cannot forget it. Non-blocking and trivial — its stdin payload carries `last_assistant_message`, so it writes that text to the per-phase sentinel (no transcript parsing, no `jq`).

The orchestrator: `rm -f` the sentinel before spawn; poll every 5s; sentinel appears → match the **last non-empty line** against `^VERDICT: (<known token>)$`:
- exactly one known token → proceed on it.
- no match, or several `VERDICT:` lines → `failed` immediately (premature stop, or the agent didn't end cleanly) — not a 90-min hang.
- sentinel never written (Claude never stops — runaway loop) → per-phase timeout → `failed`.

Strict (`^VERDICT: TOKEN$`, last line), not a substring scan — a loose grep false-matches prose ("not yet `READY_FOR_REVIEW`"), and a false *proceed* is worse than a false *fail*.

**The charpente is the per-phase timeout, not the hook.** The hook is only the clean *early-exit* optimisation. If a hook ever fails to fire (API-error stop, a Claude Code regression), the per-phase cap still ends the phase → `failed`. A `StopFailure` hook is configured too (same handler, fires on an API-error stop) — optional belt-and-suspenders, nothing depends on it. `writeStopHookConfig` drops the worktree `.claude/settings.local.json`.

## Per-issue budget

Single wall-clock budget **90 min**, whole pipeline (`run_impl` → loop → `run_dogfood`). Clock starts at `run_impl`. Replaces `ISSUE_TIMEOUT_MS` (was 60).

Each session is spawned with `timeout = min(phase cap, remaining budget)` — a per-phase cap so one stuck session can't silently eat the whole budget. Caps: `run_impl` 45 min · `review` 25 · `evaluate` 30 · `fix` 30 · `run_dogfood` 25. Timeout → kill → `failed` (reason = phase + elapsed).

The caps sum to 155 min > the 90-min budget **on purpose** — each cap is a per-phase ceiling against one hung session; the 90-min deadline is the real bound and trips first on a normal run.

## Convergence & loop

`review → evaluate → fix → review …`. `evaluate` is the **sole convergence authority** (`CONVERGED` → `run_dogfood`; `NEEDS_FIX` → `fix`).

Two guards, different failure modes:
- **`fixCycles` cap = 3** — a counter in the state, +1 on each entry to `fix`; the 3rd `NEEDS_FIX` without convergence → `failed` (reason `fix_cycle_cap`). 3 cycles without converging = a structural disagreement (evaluator insists, fixer "resolves" it differently, re-flagged…), not a slow fix — bail early so the morning MR is clean, not 90 min of thread pile-up.
- **90-min budget** — catches a single phase that drags. A different failure mode than the cycle cap.

`code-review` run bare has no internal loop.

## Error handling

- `run_impl` `BLOCKER_SUSPECTED` / timeout → `failed`. blocker-verifier deferred → a suspected blocker is trusted; `run-impl.md`'s `forbidden_blockers` is the only guard.
- A session stops with no parseable verdict → `failed` immediately.
- 3rd `fix` cycle without convergence → `failed` (reason `fix_cycle_cap`).
- Per-phase timeout or 90-min budget exhausted → kill → `failed`. Reason = phase + elapsed. Draft MR + worktree left for inspection.
- `code-review` roster may carry `error` agents → proceed on partial findings, no retry.

## Crash recovery — standalone sweep

> **Superseded 2026-05-29 (#35).** The standalone cron sweep relied on external
> scheduling that was never reliably deployed, so crashed-run claims kept
> stranding the queue. Recovery now runs **in-process at startup** before the
> first queue read (`src/recovery/sweep.ts`, wired in `runMachine`), needs no
> cron, and returns each stale issue to the queue (`+ready-for-agent` /
> `-picked-by-agent`). `scripts/sweep-stale-claims.ts` was removed. The original
> design below is kept for history.

`scripts/sweep-stale-claims.ts`, scheduled separately (cron/launchd ~3h). Lists `picked-by-agent` issues idle >2h → unlabel + force-remove orphan worktree → re-picked from scratch by the next run. Not part of the orchestrator process. A crash is not a `failed` verdict.

## Not Doing

- `only_agents`, per-finding `attempts` counter, per-issue state file — cut for simplicity (`run.jsonl` logs transitions). The loop is bounded by the 90-min budget + a `fixCycles` cap of 3.
- Revalidation pass, separate verify agent — the next `review` re-reviews everything; `fix` runs tests itself.
- Dogfood-driven fixes / dogfood→review re-entry — `run_dogfood` is a pure gate.
- blocker-verifier / ci-fix / conflict states.
- Mid-loop crash resume — the sweep re-does the issue from scratch.
- Positioned diff discussions, finding dedup, anti-resurgence — general discussions + clean-slate re-post each iteration instead.

## Artifacts

- `orchestrator.ts` — replace `run_claude_code` + `open_mr` with `run_impl` / `open_draft_mr` / `review` / `evaluate` / `fix` / `run_dogfood`; `merge` un-drafts then merges; 90-min budget + per-phase caps + `fixCycles` cap 3; `writeStopHookConfig` (non-blocking `Stop` + `StopFailure`, writing `last_assistant_message` to the sentinel); sentinel polling + strict `^VERDICT: TOKEN$` last-line scan; `onOpenDraftMr` idempotent (reuse an existing MR for the branch); per-phase sentinels + tmux logs.
- `scripts/mr-discussion.ts` — new; `glab api` MR-discussion helper: `post` (general discussion), `list` (→ `[{id, resolved, notes: [{author, body}]}]`), `resolve`. Retry + backoff on transient errors.
- `scripts/sweep-stale-claims.ts` — new; standalone crash recovery.
- `assets/prompts/run-impl.md`, `review.md`, `evaluate.md`, `fix.md`, `run-dogfood.md` — new.
- Delete `assets/prompts/session.md`.
