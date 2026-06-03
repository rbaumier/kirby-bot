/**
 * Session/usage-limit.ts — parse the Claude usage-limit dialog's reset clause.
 *
 * When a phase session hits the Claude usage limit, the dialog states when the
 * limit resets, verbatim — e.g.
 *
 *   You've hit your Sonnet limit · resets Jun 1 at 2am (Europe/Paris)
 *   You've hit your session limit · resets Jun 1 at 2am (Europe/Paris)
 *
 * #77's fail-fast detection captures that substring and carries it on the
 * interruption; this module (#78) turns it into the absolute instant the
 * orchestrator backs off until before launching the next session.
 *
 * Pure — no I/O, no Effect, no `Date.now()`. The caller passes `now` (epoch ms)
 * so the year inference (the dialog omits the year) and the result are
 * deterministic and exhaustively unit-testable, mirroring `verdict.ts`.
 *
 * Returns `null` for any phrasing it does not recognize. The caller MUST treat
 * `null` as "unknown reset" and fall back to a fixed conservative back-off —
 * never assume "now". A new dialog phrasing surfaces here as a `null`, which the
 * call site logs loudly so a case can be added.
 */

/** Month name → 0-based index. Accepts the abbreviated and full English forms. */
const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * How far in the past a candidate instant may sit before it is read as a
 * stale-this-year reading and the next year is preferred instead. The dialog
 * pins month + day, so the only ambiguity is the year — relevant solely at the
 * Dec→Jan boundary. A real reset is always near-future; a few-minutes-stale
 * capture (clock skew + processing delay) must NOT roll forward a whole year,
 * hence a generous window well above any plausible skew yet far below the
 * ~year gap that distinguishes this-year from next-year.
 */
const PAST_YEAR_TOLERANCE_MS = 12 * 60 * 60 * 1000;

/** `resets <date> at <time> (<tz>)` — the clause, found anywhere in the capture. */
const RESET_CLAUSE = /resets\s+(.+?)\s*\(([^)]+)\)/i;

/**
 * Pull the raw `resets … (tz)` clause out of a captured pane, or `undefined`
 * when the header carrying it has scrolled out of the capture — which happens
 * in ~15% of frozen dialogs (#77, the 82-vs-97 gap). The detection in
 * {@link paneShowsUsageLimit} anchors on the always-visible option block, so a
 * dialog can fire without the clause being present; this extractor is therefore
 * best-effort. The substring is carried verbatim on `UsageLimitHit` and later
 * fed back to {@link parseUsageLimitReset} by the #78 back-off.
 */
export const extractUsageLimitResetText = (pane: string): string | undefined => {
  const match = RESET_CLAUSE.exec(pane);
  return match === null ? undefined : match[0].trim();
};

/** `<Month>[.] <day> at <time>` — splits the date/time part the clause captured. */
const DATE_TIME = /^([A-Za-z]+)\.?\s+(\d{1,2})\s+at\s+(.+?)\s*$/;

/** A clock time: `2`, `2:30`, `2am`, `2:30 pm`, `14:00`, `2 a.m.`. */
const CLOCK_TIME = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

/**
 * Parse a clock time into 24h `{hour, minute}`, or `null` if malformed.
 * 12h (with am/pm) and 24h (bare) are both accepted — the dialog is
 * locale-dependent. `12am` → 0, `12pm` → 12.
 */
const parseClockTime = (raw: string): { hour: number; minute: number } | null => {
  const normalized = raw.trim().toLowerCase().replace(/\./g, "");
  const match = CLOCK_TIME.exec(normalized);
  if (match === null) {
    return null;
  }
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (minute > 59) {
    return null;
  }
  let hour = Number(match[1]);
  const meridiem = match[3];
  if (meridiem === undefined) {
    return hour > 23 ? null : { hour, minute };
  }
  if (hour < 1 || hour > 12) {
    return null;
  }
  if (meridiem === "am") {
    hour = hour === 12 ? 0 : hour;
  } else {
    hour = hour === 12 ? 12 : hour + 12;
  }
  return { hour, minute };
};

/**
 * The offset (ms) to add to UTC to reach `tz`'s wall clock at `epoch`.
 * Returns `null` for an unknown timezone (`Intl` throws on construction) — the
 * dialog carries IANA names like `Europe/Paris`, not numeric offsets.
 */
const tzOffsetMs = (epoch: number, tz: string): number | null => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(epoch));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const wallAsUTC = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return wallAsUTC - epoch;
  } catch {
    return null;
  }
};

/**
 * Convert a wall-clock time *in `tz`* to an absolute epoch-ms instant, or `null`
 * for an unknown timezone. Two passes settle the offset across a DST boundary:
 * the first guess uses the offset at the naive-UTC instant, the second
 * re-evaluates the offset at the corrected instant.
 */
const wallToEpoch = (
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number | null => {
  const naiveUTC = Date.UTC(year, monthIndex, day, hour, minute, 0);
  const firstOffset = tzOffsetMs(naiveUTC, tz);
  if (firstOffset === null) {
    return null;
  }
  let epoch = naiveUTC - firstOffset;
  const secondOffset = tzOffsetMs(epoch, tz);
  if (secondOffset !== null && secondOffset !== firstOffset) {
    epoch = naiveUTC - secondOffset;
  }
  return epoch;
};

/** The year `now` falls in within `tz`, or `null` for an unknown timezone. */
const yearInTz = (epoch: number, tz: string): number | null => {
  try {
    const year = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(new Date(epoch)),
    );
    return Number.isNaN(year) ? null : year;
  } catch {
    return null;
  }
};

/**
 * Parse a captured usage-limit reset substring into an absolute epoch-ms
 * instant, or `null` if the format is unrecognized.
 *
 * `captured` may be just the reset clause or the whole dialog/pane text — the
 * clause is matched wherever it appears. `now` (epoch ms) disambiguates the
 * omitted year.
 */
export const parseUsageLimitReset = (captured: string, now: number): number | null => {
  const clause = RESET_CLAUSE.exec(captured);
  if (clause === null) {
    return null;
  }
  const [, dateTimePart, tzPart] = clause;
  if (dateTimePart === undefined || tzPart === undefined) {
    return null;
  }
  const tz = tzPart.trim();
  const dateTime = DATE_TIME.exec(dateTimePart.trim());
  if (dateTime === null) {
    return null;
  }
  const [, monthName, dayText, timeText] = dateTime;
  if (monthName === undefined || dayText === undefined || timeText === undefined) {
    return null;
  }
  const monthIndex = MONTHS[monthName.toLowerCase()];
  if (monthIndex === undefined) {
    return null;
  }
  const day = Number(dayText);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }
  const time = parseClockTime(timeText);
  if (time === null) {
    return null;
  }

  // The dialog omits the year. Pin month/day/time and pick the year whose
  // instant is the soonest that is not already long past — this resolves the
  // Dec→Jan boundary without rolling a few-minutes-stale capture forward a
  // whole year. A slightly-past reading (clock skew) is returned as-is; the
  // back-off clamps it to its minimum rather than the parser hiding it.
  const nowYear = yearInTz(now, tz);
  if (nowYear === null) {
    return null;
  }
  const candidates: number[] = [];
  for (const year of [nowYear - 1, nowYear, nowYear + 1]) {
    const epoch = wallToEpoch(year, monthIndex, day, time.hour, time.minute, tz);
    if (epoch !== null) {
      candidates.push(epoch);
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  const soonest = candidates
    .filter((epoch) => epoch >= now - PAST_YEAR_TOLERANCE_MS)
    .sort((a, b) => a - b)[0];
  return soonest === undefined ? Math.max(...candidates) : soonest;
};
