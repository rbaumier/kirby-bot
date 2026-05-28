/**
 * Stats/findings-files.ts — read the per-agent findings dump files kirby-bot
 * writes during the `review` phase (`findings-<iid>-<phase>-<iter>-<agent>.json`).
 *
 * `run.jsonl`'s `review_findings` event only carries the *line-anchored*
 * findings (those that successfully matched a diff line and got posted as a
 * GitLab discussion). Pure-prose agents (thermo-nuclear, matt-review, …)
 * emit a `prose`/`summary` field that gets collapsed into a single thread;
 * the original prose body lives only in the dump file.
 *
 * Reading the dump files lets analytics see what each reviewer *actually*
 * produced — including the prose-only agents that the run.jsonl projection
 * collapses to a single per-issue thread.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

/** One line-anchored finding row, as the agents write it. */
export type LineFinding = {
  readonly file?: string;
  readonly line?: number;
  readonly severity?: string;
  readonly confidence?: string;
  readonly title?: string;
};

/** What a single `findings-*.json` parses to. */
export type FindingsDump = {
  readonly issueIid: number;
  readonly phase: string;
  readonly iteration: number;
  readonly agent: string;
  readonly path: string;
  /** Number of line-anchored findings (objects in `findings` array). */
  readonly lineFindingCount: number;
  /** Count by severity (`bug`, `must`, `suggestion`, `error_handling`, …). */
  readonly severityCounts: Readonly<Record<string, number>>;
  /** Total length of prose/summary text, characters. 0 if none. */
  readonly proseChars: number;
};

const FNAME_RE = /^findings-(\d+)-([a-z]+)-(\d+)-(.+)\.json$/;

const parseDumpContent = (
  meta: { issueIid: number; phase: string; iteration: number; agent: string; path: string },
  content: string,
): FindingsDump => {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ...meta, lineFindingCount: 0, severityCounts: {}, proseChars: 0 };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...meta, lineFindingCount: 0, severityCounts: {}, proseChars: 0 };
  }
  const obj = parsed as Record<string, unknown>;
  const severityCounts: Record<string, number> = {};
  let lineFindingCount = 0;
  const fs = obj.findings;
  if (Array.isArray(fs)) {
    for (const f of fs) {
      if (typeof f === "object" && f !== null) {
        lineFindingCount += 1;
        const sev = (f as Record<string, unknown>).severity;
        if (typeof sev === "string" && sev !== "") {
          severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;
        }
      }
    }
  }
  const prose = typeof obj.prose === "string" ? obj.prose : typeof obj.summary === "string" ? obj.summary : "";
  return { ...meta, lineFindingCount, severityCounts, proseChars: prose.length };
};

/** Walk one run directory and parse every findings dump it contains. */
export const readRunFindings = async (runDir: string): Promise<FindingsDump[]> => {
  let entries: string[];
  try {
    entries = await readdir(runDir);
  } catch {
    return [];
  }
  const dumps: FindingsDump[] = [];
  for (const name of entries) {
    const m = FNAME_RE.exec(name);
    if (m === null) { continue; }
    const path = join(runDir, name);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    dumps.push(
      parseDumpContent(
        {
          issueIid: Number(m[1]),
          phase: m[2]!,
          iteration: Number(m[3]),
          agent: m[4]!,
          path,
        },
        content,
      ),
    );
  }
  return dumps;
};

/** Convenience: filename parser for tests. */
export const parseFindingsFilename = (
  name: string,
): { issueIid: number; phase: string; iteration: number; agent: string } | null => {
  const m = FNAME_RE.exec(basename(name));
  if (m === null) { return null; }
  return {
    issueIid: Number(m[1]),
    phase: m[2]!,
    iteration: Number(m[3]),
    agent: m[4]!,
  };
};
