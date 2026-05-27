# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |

---

# kirby-bot — operating notes

## Auth & config: environment variables only

kirby-bot reaches GitLab through the `PRIVATE-TOKEN` header. The connection is
resolved entirely from environment variables — no `glab` config file, no
git-remote sniffing. All three are required, and a missing one fails fast at
startup with a clear `ProviderConfigError`:

- `KIRBY_GITLAB_TOKEN` — a personal access token (PAT) with the `api` scope.
- `GITLAB_HOST` — the instance base URL, e.g. `https://gitlab.com`.
- `GITLAB_PROJECT_PATH` — the `owner/repo` project path.

OAuth2 access tokens are **not** supported: they expire within hours and a
single AFK run (several issues × 4-hour budget) outlives them. Create a
long-lived PAT (e.g. `glab api -X POST user/personal_access_tokens` with the
`api` scope) and export it as `KIRBY_GITLAB_TOKEN` before launching.

## Diagnosing slow phases via Claude session transcripts

`run.jsonl` shows phase-level transitions but no per-tool / per-subagent
detail. When a phase looks unexpectedly slow, dig into the Claude session
transcript that backed it.

**Where the transcripts live**

Claude Code writes one JSONL per session under
`~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl`. The orchestrator
launches each phase inside the issue's worktree
(`~/.afk-worktrees/<repo>/<branch>`), so the sanitized path looks like:

    ~/.claude/projects/-Users-<you>--afk-worktrees-<repo>-<branch>/

Each phase = one JSONL file; pick the one whose mtime brackets the run.jsonl
transition you care about.

**What's in there**

Each line is a JSON object with `timestamp`, `type`
(`user` / `assistant` / `system` / …), and either a prompt string or a
`message.content[]` array of `tool_use` / `tool_result` blocks. Pairing a
`tool_use` (in an `assistant` line) with the matching `tool_result` (in the
next `user` line, keyed by `tool_use_id`) gives the wall-clock duration of
that single tool call.

**Recipe**

1. Dump every tool use to a flat file:

       jq -c 'select(.type=="assistant") | .timestamp as $ts
              | .message.content[]?
              | select(.type=="tool_use")
              | {id: .id, name: .name, sub: (.input.subagent_type // ""), ts: $ts}' \
         "$SESSION_FILE" > /tmp/uses.jsonl

2. Dump every tool result the same way:

       jq -c 'select(.type=="user") | .timestamp as $ts
              | .message.content[]?
              | select(.type=="tool_result")
              | {id: .tool_use_id, ts: $ts}' \
         "$SESSION_FILE" > /tmp/results.jsonl

3. Join in Python (or jq) on `id`, subtract timestamps. Sort by duration
   descending — the top of that list tells you where the wall-clock went.

**What the first dogfood revealed**

For a 15-min `review` phase, the breakdown was: **70s** for the slowest of
17 parallel `Agent` (subagent) calls, ~1 min for the sequential
`mr-discussion.ts post` storm, ~9 min of orchestrator thinking — and
**2 × 120s Bash timeouts** that turned out to be `find / -name
mr-discussion.ts` because the prompt referenced a dead `~/.claude/skills/afk/`
install path. The script path is now templated via `{scripts_dir}` instead
of hard-coded; investigate any new "Bash 120s" entry the same way before
suspecting a model regression.
