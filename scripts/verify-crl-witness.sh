#!/bin/bash
# verify-crl-witness.sh — verify a code-review-loop run by replaying the harness-level
# Agent invocation log (~/.claude/data/code-review-loop/agent-invocations.jsonl).
#
# Trust model:
#   - The orchestrator's own JSON report is forgeable (the orchestrator writes it).
#   - The PostToolUse Agent hook (~/.claude/hooks/code-review-loop-witness.sh) is
#     harness-level and fires for every Agent tool_use, including those nested inside
#     a runner subagent. The agent cannot disable it from its own prompt.
#   - We treat the hook log as the trustless witness.
#
# Inputs:
#   $1 = SESSION_ID    (the AFK session id; nested runner calls inherit this)
#   $2 = WINDOW_START  (ISO8601 UTC, ~timestamp when AFK invoked the runner)
#   $3 = WINDOW_END    (ISO8601 UTC, ~timestamp when AFK received the runner's reply)
#   $4 = MIN_AGENTS    (minimum distinct review-agent descriptions; AFK forces Full → 8)
#
# Outputs:
#   exit 0 = verified — the runner actually spawned >= MIN_AGENTS review agents
#   exit 1 = forged or absent — runner returned READY_FOR_MR but didn't do the fan-out
#   stdout: one-line summary suitable for AFK to splice into MR notes / failure logs
#   stderr: detailed breakdown for debugging
set -u

SESSION_ID="${1:?need SESSION_ID}"
WIN_START="${2:?need WINDOW_START ISO8601}"
WIN_END="${3:?need WINDOW_END ISO8601}"
MIN_AGENTS="${4:-8}"

LOG="$HOME/.claude/data/code-review-loop/agent-invocations.jsonl"

if [[ ! -f "$LOG" ]]; then
  echo "VERIFY_FAIL reason=no-witness-log path=$LOG"
  echo "Hook log missing — either the hook is not installed, or no Agent calls fired since install." >&2
  exit 1
fi

# Filter hook entries to this session + time window, then bucket by tool_input.description.
# Each Agent call in the runner emits one entry; the runner itself emits one too.
FILTERED=$(jq -c --arg sid "$SESSION_ID" --arg t0 "$WIN_START" --arg t1 "$WIN_END" '
  select(.raw.session_id == $sid)
  | select(.ts >= $t0 and .ts <= $t1)
  | {
      ts: .ts,
      desc: (.raw.tool_input.description // ""),
      subagent: (.raw.tool_input.subagent_type // ""),
      model: (.raw.tool_input.model // ""),
      duration_ms: (.raw.duration_ms // 0),
      usage: (.raw.tool_response.usage // {})
    }
' "$LOG")

if [[ -z "$FILTERED" ]]; then
  echo "VERIFY_FAIL reason=no-entries-in-window session=$SESSION_ID window=$WIN_START..$WIN_END"
  echo "No hook entries match session+window. Either the runner never spawned, or the window is wrong." >&2
  exit 1
fi

# Count distinct review-agent descriptions, excluding the runner itself.
# Review descriptions are e.g. "Funnel L1 — necessity", "Correctness — bug hunt",
# "Tests — coverage and quality", "Occam Razor — call graph", "matt-review …",
# skill agents like "coding-standards umbrella", "language-typescript", etc.
REVIEW_LINES=$(echo "$FILTERED" | jq -c 'select(.desc | test("code-review-loop runner") | not)')
REVIEW_COUNT=$(echo "$REVIEW_LINES" | grep -c '^' || true)
DISTINCT_DESCS=$(echo "$REVIEW_LINES" | jq -r '.desc' | sort -u)
DISTINCT_COUNT=$(echo "$DISTINCT_DESCS" | grep -c '^' || true)

RUNNER_PRESENT=$(echo "$FILTERED" | jq -c 'select(.desc | test("code-review-loop runner"))' | head -1)

# Pretty-print breakdown to stderr for debugging / AFK MR notes.
{
  echo "=== verify-crl-witness ==="
  echo "Session: $SESSION_ID"
  echo "Window:  $WIN_START .. $WIN_END"
  echo "Threshold: $MIN_AGENTS distinct review agents"
  echo ""
  echo "Runner invocation seen: $([[ -n "$RUNNER_PRESENT" ]] && echo YES || echo NO)"
  echo "Review agent invocations (raw): $REVIEW_COUNT"
  echo "Distinct review agent descriptions: $DISTINCT_COUNT"
  echo ""
  echo "Descriptions:"
  echo "$DISTINCT_DESCS" | sed 's/^/  - /'
} >&2

# Verdict.
if [[ -z "$RUNNER_PRESENT" ]]; then
  echo "VERIFY_FAIL reason=runner-not-seen session=$SESSION_ID review_agents=$DISTINCT_COUNT"
  exit 1
fi

if (( DISTINCT_COUNT < MIN_AGENTS )); then
  echo "VERIFY_FAIL reason=insufficient-fanout session=$SESSION_ID review_agents=$DISTINCT_COUNT min=$MIN_AGENTS"
  exit 1
fi

# Aggregate token cost as a bonus for MR notes (best-effort; some entries may lack usage).
TOTAL_INPUT=$(echo "$FILTERED" | jq -s '[.[] | .usage.input_tokens // 0] | add // 0')
TOTAL_OUTPUT=$(echo "$FILTERED" | jq -s '[.[] | .usage.output_tokens // 0] | add // 0')
TOTAL_MS=$(echo "$FILTERED" | jq -s '[.[] | .duration_ms // 0] | add // 0')

echo "VERIFY_OK session=$SESSION_ID review_agents=$DISTINCT_COUNT input_tokens=$TOTAL_INPUT output_tokens=$TOTAL_OUTPUT total_duration_ms=$TOTAL_MS"
exit 0
