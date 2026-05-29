import { describe, expect, it } from "bun:test";
import { __test } from "./merge-request";

const { isMergeabilityPending } = __test;

// The merge endpoint 405s while GitLab is still (re)computing mergeability
// after an un-draft (issue #41); the poll must keep waiting on the in-flight
// values and stop on every settled verdict so a real block surfaces.
describe("isMergeabilityPending", () => {
  it("is pending while the check is in flight", () => {
    for (const status of ["unchecked", "checking", "preparing"]) {
      expect(isMergeabilityPending(status)).toBe(true);
    }
  });

  it("is settled on a final verdict (mergeable or blocked)", () => {
    for (const status of [
      "mergeable",
      "ci_still_running",
      "ci_must_pass",
      "conflict",
      "discussions_not_resolved",
      "draft_status",
      "not_open",
      "can_be_merged",
      "cannot_be_merged",
    ]) {
      expect(isMergeabilityPending(status)).toBe(false);
    }
  });

  it("treats a missing status field as settled, never looping forever", () => {
    expect(isMergeabilityPending(undefined)).toBe(false);
  });
});
