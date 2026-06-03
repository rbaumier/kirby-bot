/**
 * Phases/runner.test.ts — `phaseHandlerError` at the Session→pipeline seam.
 *
 * The seam is where a `PhaseError` becomes a `HandlerError` carrying the fate
 * the pipeline routes on. The must-fix invariant for #77 is that a
 * `UsageLimitHit` routes to `interruption` (NOT `stall`) and threads its raw
 * reset substring through, so the orchestrator backs off (#78) instead of
 * burning a good issue's `STALL_CAP`.
 */
import { describe, expect, it } from "bun:test";
import { REPICK_CAP, STALL_CAP } from "../config";
import { recordInterruption, recordStall } from "../recovery/sidecar-policy";
import { SessionTimedOut, UsageLimitHit } from "../session/errors";
import { phaseHandlerError } from "./runner";

describe("phaseHandlerError on UsageLimitHit", () => {
  it("routes to the interruption fate and carries the reset substring", () => {
    const error = phaseHandlerError("implementation")(
      new UsageLimitHit({ phase: "implementation", resetText: "resets Jun 1 at 2am (Europe/Paris)" }),
    );
    expect(error.fate).toBe("interruption");
    expect(error.usageLimitResetText).toBe("resets Jun 1 at 2am (Europe/Paris)");
    expect(error.reason).toContain("Claude usage limit hit");
  });

  it("omits the reset substring when the header had scrolled out", () => {
    const error = phaseHandlerError("review")(new UsageLimitHit({ phase: "review" }));
    expect(error.fate).toBe("interruption");
    expect(error.usageLimitResetText).toBeUndefined();
  });

  it("still routes a genuine timeout to the stall fate (no over-broad mapping)", () => {
    const error = phaseHandlerError("review")(new SessionTimedOut({ phase: "review", elapsedMs: 1 }));
    expect(error.fate).toBe("stall");
    expect(error.usageLimitResetText).toBeUndefined();
  });
});

describe("UsageLimitHit accounting → recordInterruption, never recordStall", () => {
  // The seam routes an `interruption` fate to `recordInterruption`; this pins
  // the consequence on the counters so a usage-limit hit can never push a good
  // issue toward STALL_CAP.
  it("resets the consecutive-stall run instead of incrementing it", () => {
    const error = phaseHandlerError("implementation")(
      new UsageLimitHit({ phase: "implementation" }),
    );
    // Precondition: the interruption fate is what the seam dispatches on.
    expect(error.fate).toBe("interruption");

    const prior = { consecutiveStalls: 2, totalRepicks: 5 };
    const interruption = recordInterruption(prior, REPICK_CAP);
    expect(interruption.counts.consecutiveStalls).toBe(0);

    // Contrast: had it been mis-classified as a stall, the run would have grown.
    const asStall = recordStall(prior, STALL_CAP, REPICK_CAP);
    expect(asStall.counts.consecutiveStalls).toBe(3);
  });
});
