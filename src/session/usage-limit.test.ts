/**
 * Session/usage-limit.test.ts — exhaustive unit tests for the reset parser.
 *
 * The parser is the fragile part of #78: it reads the locale-dependent,
 * timezone-named reset clause off a captured usage-limit dialog. Pure, so we
 * pin every phrasing and every failure mode with a fixed `now`. Expected
 * instants are written as `Date.UTC(...)` (UTC) so the timezone math is
 * self-checking rather than a magic number.
 */
import { describe, expect, it } from "bun:test";
import { parseUsageLimitReset } from "./usage-limit";

// A reference "now" in May 2026, well before a Jun 1 reset.
const MAY_31_2026 = Date.UTC(2026, 4, 31, 12, 0, 0);

describe("parseUsageLimitReset — happy path", () => {
  it("parses a Sonnet-limit string to the reset instant (Europe/Paris, CEST = UTC+2)", () => {
    const captured = "You've hit your Sonnet limit · resets Jun 1 at 2am (Europe/Paris)";
    // Jun 1 2026 02:00 Paris (CEST) == Jun 1 2026 00:00 UTC.
    expect(parseUsageLimitReset(captured, MAY_31_2026)).toBe(Date.UTC(2026, 5, 1, 0, 0, 0));
  });

  it("parses a session/5h-limit string the same way (alternate header phrasing)", () => {
    const captured = "You've hit your session limit · resets Jun 1 at 2am (Europe/Paris)";
    expect(parseUsageLimitReset(captured, MAY_31_2026)).toBe(Date.UTC(2026, 5, 1, 0, 0, 0));
  });

  it("accepts a bare reset clause without the dialog header", () => {
    expect(parseUsageLimitReset("resets Jun 1 at 2am (Europe/Paris)", MAY_31_2026)).toBe(
      Date.UTC(2026, 5, 1, 0, 0, 0),
    );
  });

  it("accepts the full month name", () => {
    expect(parseUsageLimitReset("resets June 1 at 2am (Europe/Paris)", MAY_31_2026)).toBe(
      Date.UTC(2026, 5, 1, 0, 0, 0),
    );
  });

  it("accepts a 24-hour clock (no am/pm)", () => {
    // Jun 1 14:00 Paris (CEST) == 12:00 UTC.
    expect(parseUsageLimitReset("resets Jun 1 at 14:00 (Europe/Paris)", MAY_31_2026)).toBe(
      Date.UTC(2026, 5, 1, 12, 0, 0),
    );
  });

  it("accepts minutes and a pm meridiem", () => {
    // Jun 1 2:30pm Paris (CEST) == 12:30 UTC.
    expect(parseUsageLimitReset("resets Jun 1 at 2:30pm (Europe/Paris)", MAY_31_2026)).toBe(
      Date.UTC(2026, 5, 1, 12, 30, 0),
    );
  });

  it("accepts a spaced, dotted meridiem (2 a.m.)", () => {
    expect(parseUsageLimitReset("resets Jun 1 at 2 a.m. (Europe/Paris)", MAY_31_2026)).toBe(
      Date.UTC(2026, 5, 1, 0, 0, 0),
    );
  });

  it("maps 12am to midnight and 12pm to noon", () => {
    // Jun 1 12am Paris (CEST) == May 31 22:00 UTC.
    expect(parseUsageLimitReset("resets Jun 1 at 12am (Europe/Paris)", MAY_31_2026)).toBe(
      Date.UTC(2026, 4, 31, 22, 0, 0),
    );
    // Jun 1 12pm Paris (CEST) == 10:00 UTC.
    expect(parseUsageLimitReset("resets Jun 1 at 12pm (Europe/Paris)", MAY_31_2026)).toBe(
      Date.UTC(2026, 5, 1, 10, 0, 0),
    );
  });

  it("resolves a different timezone (America/New_York, EST = UTC-5)", () => {
    const now = Date.UTC(2026, 0, 14, 12, 0, 0); // Jan 14 2026
    // Jan 15 2026 02:00 New York (EST) == Jan 15 2026 07:00 UTC.
    expect(parseUsageLimitReset("resets Jan 15 at 2am (America/New_York)", now)).toBe(
      Date.UTC(2026, 0, 15, 7, 0, 0),
    );
  });

  it("resolves a UTC reset", () => {
    expect(parseUsageLimitReset("resets Jun 1 at 11pm (UTC)", MAY_31_2026)).toBe(
      Date.UTC(2026, 5, 1, 23, 0, 0),
    );
  });
});

describe("parseUsageLimitReset — year inference", () => {
  it("rolls to next year across the Dec→Jan boundary", () => {
    // now: Dec 31 2026 23:00 Paris (CET, UTC+1) == Dec 31 2026 22:00 UTC.
    const now = Date.UTC(2026, 11, 31, 22, 0, 0);
    // "Jan 1 at 2am" must resolve to 2027, not the ~year-past 2026.
    // Jan 1 2027 02:00 Paris (CET) == Jan 1 2027 01:00 UTC.
    expect(parseUsageLimitReset("resets Jan 1 at 2am (Europe/Paris)", now)).toBe(
      Date.UTC(2027, 0, 1, 1, 0, 0),
    );
  });
});

describe("parseUsageLimitReset — clock skew (reset just passed)", () => {
  it("returns a slightly-past instant as-is (the back-off clamps, the parser does not hide it)", () => {
    // now: Jun 1 2026 03:00 Paris (CEST) == Jun 1 2026 01:00 UTC.
    const now = Date.UTC(2026, 5, 1, 1, 0, 0);
    const result = parseUsageLimitReset("resets Jun 1 at 2am (Europe/Paris)", now);
    // Reset is Jun 1 00:00 UTC — one hour before `now`. Returned, not rolled forward.
    expect(result).toBe(Date.UTC(2026, 5, 1, 0, 0, 0));
    expect(result).toBeLessThan(now);
  });
});

describe("parseUsageLimitReset — unrecognized formats return null", () => {
  it.each([
    ["empty string", ""],
    ["no reset clause", "You've hit your limit. Try again later."],
    ["no timezone parentheses", "resets Jun 1 at 2am"],
    ["no date, vague time", "resets soon (Europe/Paris)"],
    ["unknown month", "resets Funday 1 at 2am (Europe/Paris)"],
    ["out-of-range 24h time", "resets Jun 1 at 25:00 (Europe/Paris)"],
    ["out-of-range minutes", "resets Jun 1 at 2:75pm (Europe/Paris)"],
    ["unknown timezone", "resets Jun 1 at 2am (Not/AZone)"],
  ])("returns null for %s", (_label, captured) => {
    expect(parseUsageLimitReset(captured, MAY_31_2026)).toBeNull();
  });
});
