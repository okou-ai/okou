import { describe, expect, it } from "vitest";

import { scheduleExpired, SCHEDULE_GRACE_MS } from "../schedule-expiry-policy";

describe("unclaimed recurring schedule grace", () => {
  const anchor = new Date("2026-09-24T08:49:42.577Z");

  it("allows the exact thirty-minute boundary and skips one millisecond after", () => {
    expect(
      scheduleExpired(anchor, new Date(anchor.getTime() + SCHEDULE_GRACE_MS)),
    ).toBe(false);
    expect(
      scheduleExpired(
        anchor,
        new Date(anchor.getTime() + SCHEDULE_GRACE_MS + 1),
      ),
    ).toBe(true);
  });
});
