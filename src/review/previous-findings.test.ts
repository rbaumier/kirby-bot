import { describe, expect, test } from "bun:test";
import type { DiscussionSummary } from "../provider/types";
import { DiscussionId } from "../provider/types";
import { buildPreviousFindingsBlock } from "./previous-findings";

type DiscussionOverrides = {
  id: string;
  isResolved?: boolean;
  firstNote: string;
  extraNotes?: readonly string[];
};

const discussion = (overrides: DiscussionOverrides): DiscussionSummary => ({
  id: DiscussionId(overrides.id),
  isResolved: overrides.isResolved ?? false,
  notes: [
    { author: "kirby-bot", body: overrides.firstNote },
    ...(overrides.extraNotes ?? []).map((body) => ({ author: "kirby-bot", body })),
  ],
});

describe("buildPreviousFindingsBlock", () => {
  test("returns empty string on empty input", () => {
    expect(buildPreviousFindingsBlock([])).toBe("");
  });

  test("returns empty string when no discussion has a parseable header", () => {
    const block = buildPreviousFindingsBlock([
      discussion({ id: "1", firstNote: "random text without header" }),
    ]);
    expect(block).toBe("");
  });

  test("skips the synthetic prose-summary thread", () => {
    const block = buildPreviousFindingsBlock([
      discussion({
        id: "1",
        firstNote: "severity: suggestion | review-summary:0\n\nprose…",
      }),
    ]);
    expect(block).toBe("");
  });

  test("renders one line per line-anchored discussion with its status", () => {
    const block = buildPreviousFindingsBlock([
      discussion({
        id: "1",
        isResolved: true,
        firstNote: "severity: bug | src/foo.ts:42\n\nUnwrap on user input",
      }),
      discussion({
        id: "2",
        isResolved: false,
        firstNote:
          "severity: security | src/bar.ts:10\n\nMissing tenant filter",
      }),
    ]);
    expect(block).toContain("- src/foo.ts:42 [resolved] (severity: bug)");
    expect(block).toContain("- src/bar.ts:10 [unresolved] (severity: security)");
    expect(block.startsWith("## Previously raised")).toBe(true);
  });

  test("ignores discussions with malformed headers", () => {
    const block = buildPreviousFindingsBlock([
      discussion({ id: "1", firstNote: "no header here" }),
      discussion({
        id: "2",
        isResolved: true,
        firstNote: "severity: bug | src/ok.ts:1\n\nfoo",
      }),
    ]);
    expect(block).toContain("- src/ok.ts:1 [resolved] (severity: bug)");
    expect(block).not.toContain("no header here");
  });

  test("handles a discussion with no notes (edge case)", () => {
    const block = buildPreviousFindingsBlock([
      { id: DiscussionId("empty"), isResolved: false, notes: [] },
    ]);
    expect(block).toBe("");
  });
});
