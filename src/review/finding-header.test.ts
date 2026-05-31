/**
 * Finding-header.test.ts — the isolated round-trip the integration tests never
 * gave us: `decode(encode(header)) === header`, for both a line-anchored
 * finding and the synthetic prose-summary location. Before this Module the
 * format's only safety net was a full integration test that traversed a real
 * Discussion; here a one-line change to the format is caught directly.
 */
import { describe, expect, test } from "bun:test";
import {
  decodeFindingHeader,
  encodeFindingHeader,
  type FindingHeader,
  REVIEW_SUMMARY_LOCATION,
} from "./finding-header";

describe("encode/decode round-trip", () => {
  const cases: ReadonlyArray<readonly [string, FindingHeader]> = [
    ["line-anchored", { severity: "bug", file: "src/foo.ts", line: 42 }],
    ["summary synthetic", REVIEW_SUMMARY_LOCATION],
  ];

  for (const [name, header] of cases) {
    test(`decode(encode(${name})) === header`, () => {
      expect(decodeFindingHeader(encodeFindingHeader(header))).toEqual(header);
    });
  }

  test("encodes the canonical first-line shape", () => {
    expect(encodeFindingHeader({ severity: "security", file: "src/bar.ts", line: 10 })).toBe(
      "severity: security | src/bar.ts:10",
    );
  });

  test("summary location renders as review-summary:0", () => {
    expect(encodeFindingHeader(REVIEW_SUMMARY_LOCATION)).toBe(
      "severity: suggestion | review-summary:0",
    );
  });
});

describe("decode rejects non-headers", () => {
  for (const line of ["", "random prose", "## Heading", "severity: bug | no-line-number"]) {
    test(`returns null for ${JSON.stringify(line)}`, () => {
      expect(decodeFindingHeader(line)).toBeNull();
    });
  }
});
