import { describe, expect, it } from "vitest";

import { unreadThroughAt } from "../unread-through-at.ts";

describe("unread-through instant for an open thread", () => {
  it("keeps the Run terminal marker when it is the newer of the two", () => {
    expect(
      unreadThroughAt("2026-03-10T00:07:00Z", "2026-03-10T00:06:00Z"),
    ).toBe("2026-03-10T00:07:00Z");
  });
});
