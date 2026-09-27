import { describe, expect, it } from "vitest";

import {
  createWorkflowOwnerProfileNegativeCache,
  WORKFLOW_OWNER_PROFILE_CACHE_LIMIT,
} from "../workflow-owner-profile-negative-cache";

describe("workflow owner profile negative cache", () => {
  it("evicts the oldest missing owner only after reaching 512 entries", () => {
    expect(WORKFLOW_OWNER_PROFILE_CACHE_LIMIT).toBe(512);
    const capacity = WORKFLOW_OWNER_PROFILE_CACHE_LIMIT;
    const cache = createWorkflowOwnerProfileNegativeCache();
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

  it("expires missing owners after sixty seconds", () => {
    const cache = createWorkflowOwnerProfileNegativeCache();
    cache.record("owner", 1000);
    expect(cache.has("owner", 60_999)).toBeTruthy();
    expect(cache.has("owner", 61_000)).toBeFalsy();
  });
});
