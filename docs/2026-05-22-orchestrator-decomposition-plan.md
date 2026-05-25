# AFK decomposition — implementation plan

Spec: `2026-05-22-orchestrator-decomposition.md`. Each step = one commit unless noted. **S1 first** — it proves the load-bearing mechanism. S2/S3 independent. S4 needs S2. S5 needs S4.

## S1 — Stop-hook POC (`v0-test.ts`)

Prove the completion mechanism **before** building on it. Rewrite/extend `afk/v0-test.ts`:
- spawn a throwaway `claude` tmux session, configure the non-blocking `Stop` hook;
- the session ends with `VERDICT: <TOKEN>` as its last line;
- assert: the hook fired, wrote `last_assistant_message` to the sentinel, and a strict `^VERDICT: (TOKEN)$` last-line scan extracts the token;
- assert the negative: a session ending with no verdict line → scan returns none.

If the `Stop` payload turns out NOT to carry `last_assistant_message` → stop and rethink (fallback: the hook parses `transcript_path`). This is the gate for the whole plan.

Verify: `bun afk/v0-test.ts` green.
Commit: `Prove the Stop-hook completion mechanism (v0-test)`.

## S2 — `scripts/mr-discussion.ts`

Bun helper wrapping `glab api`:
- `post --mr <iid> --body B` — create a general resolvable discussion (one `glab api POST …/discussions`, body only).
- `list --mr <iid>` — `[{id, resolved, notes: [{author, body}]}]`.
- `resolve --mr <iid> --discussion <id>`.
- Retry + backoff on transient/network errors. `--dry-run` on `post`.

Verify: against a throwaway MR — `post`, `list` shows it, `resolve` flips state.
Commit: `Add mr-discussion.ts — glab MR-discussion helper`.

## S3 — `scripts/sweep-stale-claims.ts`

Standalone, **run by cron/launchd ~3h** (not by the orchestrator). `glab issue list --label picked-by-agent` → idle >2h → unlabel + force-remove orphan worktree. `--dry-run` = list only.

Verify: `--dry-run` lists candidates, zero mutation.
Commit: `Add sweep-stale-claims.ts — standalone AFK crash recovery`.

## S4 — Five phase prompts

New under `assets/prompts/`. Each ends its final assistant message with a strict last line `VERDICT: <TOKEN>` — the Stop hook captures it, the agent writes no file.

- `run-impl.md` — implement+test+commit+push. `VERDICT: READY_FOR_REVIEW` | `BLOCKER_SUSPECTED`. Mine old `implementer.md` (git history) for `forbidden_blockers` / preflight / anti-hedging. No stacking refs.
- `review.md` — `mr-discussion.ts list` → resolve any lingering thread; invoke `/code-review`; `mr-discussion.ts post` its full finding set fresh (`file:line` in body), no dedup. `VERDICT: REVIEW_DONE`.
- `evaluate.md` — read-only skeptical gate. `list` unresolved threads; fan out per-file evaluator subagents (real/imagined/bloated; context-verification protocol embedded verbatim from `code-review/SKILL.md`); reply + resolve imagined/suggestion, reply verified-fix-instruction on real (leave unresolved). `VERDICT: CONVERGED` | `NEEDS_FIX`.
- `fix.md` — single session, no fan-out. Read unresolved threads; apply verified instructions, TDD for bugs; full suite+linter; commit+push; `resolve` fixed threads. `VERDICT: FIX_DONE`.
- `run-dogfood.md` — self-check applicability (`git diff --name-only`; no user-facing surface → `VERDICT: DOGFOOD_PASS` at once). Else 3 personas, pure gate, never edits. Out-of-scope → `glab issue create`; in-scope → `DOGFOOD_FAIL`; clean → `DOGFOOD_PASS`.

Verify: **smoke each prompt standalone** — worktree + substituted prompt + one `claude` session → expected verdict + MR effect. Real work — budget ~5 sessions. `code-review` skill: untouched.
Commit: `Add AFK decomposed-pipeline phase prompts`.

## S5 — orchestrator.ts rewrite (one commit)

- `writeStopHookConfig` — drop a worktree `.claude/settings.local.json` with a **non-blocking** `Stop` + `StopFailure` hook writing `last_assistant_message` to the per-phase sentinel (no jq, no transcript parsing). Sentinel-poll helper: `rm -f` before spawn; poll 5s; strict `^VERDICT: TOKEN$` last-line scan; none / multiple → `failed`; timeout → kill → `failed`.
- Types: drop `run_claude_code` + `open_mr` State variants; add `run_impl` / `open_draft_mr` / `review` / `evaluate` / `fix` / `run_dogfood`. Payload carries `mrIid`, `fixCycles`.
- `ISSUE_TIMEOUT_MS` 60→90 min; per-issue deadline at `run_impl`; each spawn `timeout = min(phase cap, deadline − now)` — caps run_impl 45 / review 25 / evaluate 30 / fix 30 / dogfood 25.
- Handlers: `onRunImpl`, `onOpenDraftMr` (`glab mr create --draft`, **idempotent** — reuse an existing MR for the branch), `onReview`, `onEvaluate`, `onFix`, `onRunDogfood`. `onMerge` does `glab mr update --ready` then merge.
- Loop: `evaluate` verdict routes converge/fix; `fixCycles` +1 on each `fix` entry; 3rd → `failed` (`fix_cycle_cap`). 90-min budget independent.
- Dispatcher + exhaustiveness. Delete `assets/prompts/session.md`, `PROMPT_TEMPLATE_PATH`.

Verify: `bun build afk/orchestrator.ts` typechecks; exhaustiveness passes; grep no `run_claude_code` / `session.md` residue.
Commit: `Rewrite AFK orchestrator as the decomposed MR-driven pipeline`.

## S6 — Incremental smoke (validation, no commit)

`bun v1a-smoke.ts` (glab probes — extend for `glab api` discussions). `bun v1b-sandbox-setup.ts --confirm` (test issue). Then validate **by stages**, each with a measurable gate:

1. `run_impl` — pass ⇔ branch ≥1 commit ∧ sentinel = recognised verdict ∧ tmux session exited clean.
2. one `review → evaluate → fix` turn — pass ⇔ MR threads posted, triaged, ≥1 resolved.
3. `run_dogfood` — pass ⇔ a `DOGFOOD_*` verdict produced.
4. full run end-to-end — pass ⇔ issue → MR merged ∧ no session compacted ∧ ≤90 min ∧ `run.jsonl` coherent.

## Notes

- `code-review` skill: untouched. Its `/tmp/` object is consumed in-context within the `review` session that produced it — never read across sessions.
- Per-phase caps sum to 155 min > the 90-min budget — intentional (per-phase ceilings vs the real global deadline).
- `glab api` general-discussion calls only — no diff-position objects.
- Out of scope: blocker-verifier / ci-fix / conflict states; dogfood→review re-entry; mid-loop crash resume. Per spec §Not Doing.
