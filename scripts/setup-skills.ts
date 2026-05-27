#!/usr/bin/env bun
/**
 * Setup-skills.ts — populate `.claude/skills/` with every skill the phase
 * prompts (and `code-review`'s subagent fan-out) invoke via the `Skill` tool.
 *
 * Per skill: skip if already present, symlink it if it exists under
 * `~/.claude/skills/` (live edits show up immediately), else fall back to
 * the copy fetched from `rbaumier/skills` via a one-shot shallow clone.
 *
 * Idempotent — safe to re-run; only acts on missing entries.
 *
 * Usage: `bun run scripts/setup-skills.ts`
 */
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SKILLS_REPO = "https://github.com/rbaumier/skills.git";

/**
 * Every skill kirby-bot's phase prompts invoke, directly or transitively via
 * `code-review`'s subagent fan-out. Keep in sync with the table in README.md.
 */
const REQUIRED_SKILLS = [
  // Directly invoked by the phase prompts
  "code-review",
  "dogfood",
  // Always-spawn by code-review (Full tier)
  "matt-improve-codebase-architecture",
  "matt-review",
  "thermo-nuclear-code-quality-review",
  "security-defensive",
  "coding-standards",
  "coding-standards:design",
  "coding-standards:errors",
  "coding-standards:hygiene",
  "coding-standards:style",
  "testing",
  "matt-tdd",
  // By language extension
  "language-typescript",
  "language-rust",
  "language-swift",
  "vue",
  // By detected import
  "better-result-adopt",
  "database",
  "docker",
  "drizzle-orm",
  "i18n",
  "kubernetes",
  "react",
  "shadcn",
  "tailwind",
  "tanstack-query",
  "tanstack-start-best-practices",
  "ui-animations",
  "zod",
  // By surface touched (path globs)
  "ui-ux",
  "frontend",
  "make-interfaces-feel-better",
  "web-performance",
  "api-design",
] as const;

const PROJECT_SKILLS_DIR = join(import.meta.dirname, "..", ".claude", "skills");
const USER_SKILLS_DIR = join(homedir(), ".claude", "skills");

mkdirSync(PROJECT_SKILLS_DIR, { recursive: true });

let cachedClone: string | null = null;
const ensureClone = (): string => {
  if (cachedClone) { return cachedClone; }
  cachedClone = mkdtempSync(join(tmpdir(), "kirby-bot-skills-"));
  console.log(`Cloning ${SKILLS_REPO} (shallow) into ${cachedClone}…`);
  execSync(`git clone --depth 1 --quiet ${SKILLS_REPO} "${cachedClone}"`, {
    stdio: "inherit",
  });
  return cachedClone;
};

let linked = 0;
let copied = 0;
let skipped = 0;
const MISSING: string[] = [];

try {
  for (const name of REQUIRED_SKILLS) {
    const target = join(PROJECT_SKILLS_DIR, name);
    if (existsSync(target)) {
      skipped++;
      continue;
    }

    const userPath = join(USER_SKILLS_DIR, name);
    if (existsSync(userPath)) {
      symlinkSync(userPath, target, "dir");
      linked++;
      continue;
    }

    const cachePath = join(ensureClone(), name);
    if (existsSync(cachePath)) {
      cpSync(cachePath, target, { recursive: true });
      copied++;
    } else {
      MISSING.push(name);
    }
  }
} finally {
  if (cachedClone) { rmSync(cachedClone, { recursive: true, force: true }); }
}

console.log(
  `Skills: ${linked} symlinked from ~/.claude/skills/, ` +
    `${copied} copied from ${SKILLS_REPO}, ${skipped} already in place.`,
);

if (MISSING.length > 0) {
  console.error(
    `\nMissing in both ~/.claude/skills/ AND ${SKILLS_REPO}: ${MISSING.join(", ")}\n` +
      `Update REQUIRED_SKILLS in scripts/setup-skills.ts.`,
  );
  process.exit(1);
}
