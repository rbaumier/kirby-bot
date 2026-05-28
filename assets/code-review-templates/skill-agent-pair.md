Enforce two related skills' rules on changed code.

Load skills `{skill_names}` via Skill tool (one Skill call per skill).

Trust boundaries: {trust_boundaries}. Skill rules touching these take precedence.

Task:
1. For each skill, list every rule + its review standard ("flag when…" patterns).
2. Walk diff. Per rule, scan changed lines for violations. Apply review standards literally.
3. Report all violations. Attribute each finding to the originating skill in the `title` (e.g. `[skill-name] …`).

## Don't flag
- Outside these skills' rules — other agents own their domains
- Patterns not literally prescribed — inferred "best practice" → drop
- Pre-existing violations in unchanged code
- Theoretical risks needing unlikely preconditions when primary defense in diff is adequate
