import { describe, expect, it } from "vitest";

import { unreadThroughAt } from "../unread-through-at.ts";

describe("unread-through instant for an open thread", () => {
  it("keeps the Run terminal marker when it is the newer of the two", () => {
    expect(
      unreadThroughAt("2026-03-10T00:07:00Z", "2026-03-10T00:06:00Z"),
    ).toBe("2026-03-10T00:07:00Z");
  });

  it("reads through nothing when neither source reports an unread", () => {
    expect(unreadThroughAt(undefined, undefined)).toBeUndefined();
  });

  it("falls back to the local marker when the server reports no unread", () => {
    // A thread the server already considers read still has to clear its own
    // local marker, or reopening it would re-send a mark-read for a stale
    // instant.
    expect(unreadThroughAt("2026-03-10T00:04:00Z", undefined)).toBe(
      "2026-03-10T00:04:00Z",
    );
  });

  it("orders opaque cursors deterministically", () => {
    // Neither value parses as an instant; the comparison must still be total,
    // so the newer cursor is not silently dropped.
    expect(unreadThroughAt("cursor-a", "cursor-b")).toBe("cursor-b");
    expect(unreadThroughAt("cursor-b", "cursor-a")).toBe("cursor-b");
  });
});
