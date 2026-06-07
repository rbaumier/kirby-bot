# ADR 0005 — Standalone review outside the orchestrator

**Status:** accepted
**Date:** 2026-06-07

## Context

The review fan-out (ADR 0001) only runs as the `review` Phase inside the
orchestrator loop: pick an Issue, claim it, create a branch worktree, plan,
implement, *then* review and post discussions on the MR. There was no way to
point that same engine at an arbitrary diff — "review this PR" or "review this
commit" — without filing an Issue and running the whole pipeline. The desire was
a quick, local, read-only review that reuses kirby's specific agents/router/
fan-out (not the generic upstream `code-review` skill) on demand.

The friction: the engine is opinionated about a *diff in a worktree*. The
agents read file content off the working tree and `git diff <base>...HEAD` is
computed from refs — so it cannot consume "a diff" as text, "a snippet", or "a
URL"; it needs a materialised git checkout positioned on the head. The scope was
deliberately narrowed (during a grilling session) from "review anything" to
**PR or commit only**, both of which reduce to `(worktree-at-head, base ref)`.

## Decision

Add a **Standalone Review**: `scripts/review.ts`, a thin `(worktree, base) →
findings JSON` wrapper (precedent: `scripts/mr-discussion.ts`), plus the
user-global `kirby-review` skill that owns all the git. See the **Review Engine**
and **Standalone Review** entries in `CONTEXT.md`.

The engine is reused **byte-identical** — no signature changes:

- The desired **base ref is passed as the engine's `defaultBranch` argument**.
  Every diff site already does `git diff <defaultBranch>...HEAD` and feeds it
  straight to `git` (`read-changed-files.ts`, `diff-slices.ts`), so passing
  `origin/main` or `<sha>^` through it is semantically exact.
- A **synthetic `issueIid` — the script's PID** — only seasons artifact slugs
  and tmux session names (never a Provider lookup), and the PID isolates
  concurrent invocations from colliding on session names.
- `RunArtifacts` is built from `buildRunArtifacts` + an explicit `mkdir` (the
  same seam the tests use; `buildRunArtifacts` computes the dir but does not
  create it).
- **No Provider, no state machine.** Output is local only — the
  `AggregatedReview` is written as JSON and presented in-conversation;
  `postReviewToMr` is not called, so no `KIRBY_*` config is required.

The skill resolves a PR (`git fetch origin refs/merge-requests/<iid>/head` on
GitLab / `refs/pull/<n>/head` on GitHub, then pins `FETCH_HEAD` to a SHA) or a
commit (`<sha>`, base `<sha>^`) into a **dedicated throwaway worktree** detached
on the head, runs the script, presents findings, and removes the worktree.

## Considered options

- **Generalise the engine to accept synthetic `ChangedFile[]` + a patch (no
  git).** Rejected: it would touch `writeFullDiff`, `writeDiffSlices`,
  delta-scope, and the `diffEmptyDespiteRoster` guard — many sites that assume a
  real worktree. The "materialise into a throwaway worktree" approach keeps the
  engine's invariant intact and pushes all input variability into the
  LLM-driven skill, where flexibility is cheap. `ChangedFile[]` remains the
  engine's test seam if this is ever needed.
- **TypeScript owns the git resolution (fetch/checkout/cleanup) from a PR-iid /
  commit-sha argument.** Rejected: the skill (LLM) is the right home for input
  interpretation (PR vs commit, GitLab vs GitHub, URL vs iid, where the remote
  is). The script stays a dumb `(worktree, base)` reviewer with no conditional
  branches on input type and no Provider dependency.
- **Post findings back to the PR** (reuse `postReviewToMr`). Rejected as a
  default: a read-only local review is the goal ("see a review without the
  loop"); mutating the PR is a surprising side effect and a commit has no MR to
  post to. Left as a possible future opt-in.
- **Refactor `issueIid: number` → a generic `RunRef` across fan-out / router /
  artifacts / `run.jsonl`.** Deferred: cosmetic naming for a single new caller.
  The deletion test says don't pay it until a second caller appears; a synthetic
  PID is inert and documented.

## Consequences

- **Zero engine churn.** The only new code is `scripts/review.ts` + the skill;
  the engine, Provider seam, and state machine are untouched, so existing tests
  can't regress.
- **A deliberately leaky-looking call.** `defaultBranch: <sha>^` and
  `issueIid: process.pid` read oddly out of context — this ADR exists so the
  next reader doesn't "fix" them. (`defaultBranch` is arguably misnamed as
  `baseRef` at the engine level, but that pre-existing choice is out of scope.)
- **Caller-owned validation.** The engine trusts its caller, so the wrapper
  validates `--budget-minutes` (a `NaN` deadline would silently degrade every
  agent to a timeout and surface as a misleading "all agents failed").
- **No test for the script.** Like the other `scripts/*.ts`, it is a thin CLI;
  the engine it drives is tested. An end-to-end run spawns tmux + `claude`
  sessions and is exercised through the skill, not a unit test.
- **Single-host concurrency caveat.** Two standalone reviews are isolated by PID
  (session names) and by a unique `RunArtifacts` dir; the throwaway worktree
  keeps the `.claude/` Stop-hook write off the live checkout.

## References

- `scripts/review.ts` — the Standalone Review entry point.
- `~/.claude/skills/kirby-review/SKILL.md` — the git-owning skill (user-global,
  not vendored in this repo).
- `CONTEXT.md` — "Review Engine" and "Standalone Review" glossary entries.
- ADR 0001 — the per-agent review engine this reuses.
