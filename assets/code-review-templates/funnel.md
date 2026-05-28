Review the diff for necessity AND scope. One pass, two lenses.

## Read budget — hard cap

Max **4 file reads**: CLAUDE.md, CONTEXT.md (if it exists), the diff, plus at most 1 source file needed to verify a wrapper has no other callers. Past 4 reads = wasted tokens — this pass is structural, not line-anchored.

Read CLAUDE.md for conventions. Read CONTEXT.md for domain terms, roles, invariants.

Read the diff from {diff_file}, filtered to {file_list}.

## Task — flag on either lens

1. **Necessity / completeness** — does each piece need to exist? Framework or dep already solves this? Simpler approach? What's missing?
2. **Scope** — smallest perimeter? Files inlinable? Queries mergeable? Wrapper types removable? Every abstraction must justify itself through concrete usage.

Per role/type/constant referenced in the diff, grep codebase (cheap, no Read) to verify existence before claiming "duplicate of X" — otherwise drop the finding.

## Don't flag
- Style/naming/formatting — other agents
- Specific bug claims with line numbers — Correctness
- Test coverage gaps — Tests
- "Extract X for reusability" / "Factor X out in case we need it later" — concrete current usage only
- File-level rewrites the user didn't ask for — propose smaller perimeter, not a module refactor
- New abstractions the diff doesn't introduce — only flag existing ones not paying rent

{previous_findings_block}

## Output

Each finding prefixed `[must]` (shouldn't ship — concrete necessity gap OR unused/wasted scope) or `[suggestion]` (worth considering, can ship without). Untagged = invalid.

Examples:
- `[must] New helpers in src/utils/fmt.ts duplicate formatting passes already in src/io/render.ts — consolidate into existing module.`
- `[must] BillingProvider wraps only useBilling() — inline the hook into its sole caller, delete the provider.`

Zero findings → exactly: "No findings."
