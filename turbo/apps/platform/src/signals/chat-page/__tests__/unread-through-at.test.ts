import { describe, expect, it } from "vitest";

import { unreadThroughAt } from "../unread-through-at.ts";

/**
 * The instant an open thread has to be read through.
 *
 * A native Morning Brief delivery has no Run and therefore no terminal event
 * in the local projection, so the server watermark is the only place its
 * unread state exists. These cases are the ones that decide whether such a
 * thread can ever clear.
 */
describe("unread-through instant for an open thread", () => {
  it("uses the server watermark for a thread whose only unread is native", () => {
    // No Run has ever finished here, so without the server signal the thread
    // would never be marked read and its indicator would stick.
    expect(unreadThroughAt(undefined, "2026-03-10T00:05:00Z")).toBe(
      "2026-03-10T00:05:00Z",
    );
  });

  it("advances to a second native delivery arriving while the thread is open", () => {
    // The local projection still has only the older Run terminal marker.
    expect(
      unreadThroughAt("2026-03-10T00:04:00Z", "2026-03-10T00:06:00Z"),
    ).toBe("2026-03-10T00:06:00Z");
  });

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
    // so the newer delivery is not silently dropped.
    expect(unreadThroughAt("cursor-a", "cursor-b")).toBe("cursor-b");
    expect(unreadThroughAt("cursor-b", "cursor-a")).toBe("cursor-b");
  });
});
