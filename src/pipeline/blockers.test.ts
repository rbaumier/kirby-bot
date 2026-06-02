/**
 * Blockers.test.ts — the "Blocked by #N" parser.
 *
 * The regex is the fragile part of the dependency gate, so it is pinned here
 * in isolation; the gate's provider wiring is covered in handlers/queue.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { parseBlockers } from "./blockers";

describe("parseBlockers", () => {
  it("reads a single blocker", () => {
    expect(parseBlockers("Blocked by #867")).toEqual([867]);
  });

  it("reads the transitive chain an author writes inline", () => {
    expect(
      parseBlockers("Blocked by #867 (filtered list endpoint), itself blocked by #855 (model)"),
    ).toEqual([867, 855]);
  });

  it("reads a comma- or and-separated run after one marker", () => {
    expect(parseBlockers("blocked by #1, #2 and #3")).toEqual([1, 2, 3]);
  });

  // Pins the documented greedy over-capture: every #N introduced by the marker
  // counts, even when prose continues. Fail-safe direction (over-waits).
  it("captures every #N in the run, even when prose follows", () => {
    expect(parseBlockers("blocked by #1 and #99 are done")).toEqual([1, 99]);
  });

  it("drops out-of-range ids (non-positive, overflow)", () => {
    expect(parseBlockers("blocked by #0 and #999999999999999999999")).toEqual([]);
  });

  it("is case-insensitive and reads the French marker", () => {
    expect(parseBlockers("Bloqué par #42")).toEqual([42]);
  });

  it("deduplicates repeated references", () => {
    expect(parseBlockers("Blocked by #5. Also blocked by #5")).toEqual([5]);
  });

  it("ignores #refs that are not introduced by a blocker marker", () => {
    expect(parseBlockers("See #5 and #6 for context")).toEqual([]);
  });

  it("returns empty when a marker has no number", () => {
    expect(parseBlockers("Blocked by the upstream model")).toEqual([]);
  });

  it("returns empty for text without a marker", () => {
    expect(parseBlockers("Just a normal issue body")).toEqual([]);
  });
});
