/**
 * Sidecar-policy.test.ts — the pure re-queue counting logic (ADR 0004).
 *
 * No filesystem here; just the counts-in → counts-out + park decision. Pins the
 * two caps' edges and the consecutive-Stall reset on an Interruption.
 */
import { describe, expect, test } from "bun:test";
import { EMPTY_COUNTS, recordInterruption, recordStall } from "./sidecar-policy";

const STALL_CAP = 3;
const REPICK_CAP = 10;

describe("recordStall", () => {
  test("bumps both counters and does not park below the cap", () => {
    const { counts, park } = recordStall(EMPTY_COUNTS, STALL_CAP, REPICK_CAP);
    expect(counts).toEqual({ consecutiveStalls: 1, totalRepicks: 1 });
    expect(park).toBe(false);
  });

  test("parks exactly at the consecutive-Stall cap", () => {
    const prior = { consecutiveStalls: STALL_CAP - 1, totalRepicks: STALL_CAP - 1 };
    const { counts, park } = recordStall(prior, STALL_CAP, REPICK_CAP);
    expect(counts.consecutiveStalls).toBe(STALL_CAP);
    expect(park).toBe(true);
  });

  test("parks when the absolute re-pick backstop fires before the Stall cap", () => {
    const prior = { consecutiveStalls: 0, totalRepicks: REPICK_CAP - 1 };
    const { park } = recordStall(prior, STALL_CAP, REPICK_CAP);
    expect(park).toBe(true);
  });
});

describe("recordInterruption", () => {
  test("resets the consecutive-Stall run to zero but still bumps the total", () => {
    const prior = { consecutiveStalls: 2, totalRepicks: 5 };
    const { counts, park } = recordInterruption(prior, REPICK_CAP);
    expect(counts).toEqual({ consecutiveStalls: 0, totalRepicks: 6 });
    expect(park).toBe(false);
  });

  test("parks only when the absolute re-pick backstop is reached", () => {
    const prior = { consecutiveStalls: 0, totalRepicks: REPICK_CAP - 1 };
    const { park } = recordInterruption(prior, REPICK_CAP);
    expect(park).toBe(true);
  });

  test("an interruption never parks on the Stall cap alone", () => {
    const prior = { consecutiveStalls: 99, totalRepicks: 1 };
    const { counts, park } = recordInterruption(prior, REPICK_CAP);
    expect(counts.consecutiveStalls).toBe(0);
    expect(park).toBe(false);
  });
});
