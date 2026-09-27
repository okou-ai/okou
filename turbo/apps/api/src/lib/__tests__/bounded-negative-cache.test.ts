import { describe, expect, it } from "vitest";

import { createBoundedNegativeCache } from "../bounded-negative-cache";

describe("bounded negative cache", () => {
  it("evicts the oldest missing key only after reaching 512 entries", () => {
    const capacity = 512;
    const cache = createBoundedNegativeCache(capacity, 60_000);
    const at = 1000;
    for (let index = 0; index < capacity; index += 1) {
      cache.record(`owner-${index}`, at);
    }
    expect(cache.has("owner-0", at)).toBeTruthy();
    expect(cache.has("owner-511", at)).toBeTruthy();

    cache.record(`owner-${capacity}`, at);
    expect(cache.has("owner-0", at)).toBeFalsy();
    expect(cache.has("owner-1", at)).toBeTruthy();
    expect(cache.has(`owner-${capacity}`, at)).toBeTruthy();
  });

  it("expires missing keys after sixty seconds", () => {
    const cache = createBoundedNegativeCache(512, 60_000);
    cache.record("owner", 1000);
    expect(cache.has("owner", 60_999)).toBeTruthy();
    expect(cache.has("owner", 61_000)).toBeFalsy();
  });
});
