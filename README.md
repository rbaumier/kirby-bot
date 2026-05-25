# afk-orchestrator

A deterministic state machine that drives Claude Code through GitLab issues — pick an issue, spawn a `claude` tmux session per phase, post the result as an MR.

## What it does

The orchestrator runs five interactive phases on each issue: `run_impl` → `review` → `evaluate` → `fix` (looping if the reviewer disagrees) → `run_dogfood` → merge. Each phase is a fresh `claude` tmux session driven by a phase-specific prompt; the verdict is parsed from the session's last assistant message via a Stop hook.

Vocabulary (Phase / Verdict / Session / Provider / RunArtifacts) lives in [`CONTEXT.md`](CONTEXT.md). Architecture-level terminology (Module / Interface / Depth / Seam) is shared across all the architecture docs.

## Requirements

- Bun ≥ 1.3.0
- `tmux`
- `claude` CLI on `$PATH`
- A GitLab project with the `picked-by-agent`, `code-review`, etc. labels configured
- A GitLab token — either `$GITLAB_TOKEN` or a `glab-cli` config at the conventional path

## Run

```bash
bun install
bun run src/main.ts
```

The orchestrator reads its config from environment + `glab` config, picks the first issue labelled `agent`, and drives it through the pipeline. Per-run artifacts (sentinel files, tmux logs, prompt files, `run.jsonl`) go under `.afk-runs/<run-id>/`.

## Layout

- `src/pipeline/` — the state machine + handlers + the `step` seam that catches `HandlerError` and rebuilds `failed`
- `src/phases/` — the five interactive Phase Modules
- `src/session/` — the tmux + Stop-hook + sentinel + Verdict-parsing mechanics
- `src/gitlab/` — REST adapter + Discussion API
- `src/provider/` — the seam between orchestrator and forge (GitLab today; GitHub deferred)
- `scripts/sweep-stale-claims.ts` — releases issues whose claim is stale

## Scripts

```bash
bun test src/           # run the bun:test suite
bun run typecheck       # tsc --noEmit
bunx comply             # the project linter
```
