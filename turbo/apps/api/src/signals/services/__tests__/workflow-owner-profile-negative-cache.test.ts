import { describe, expect, it } from "vitest";

import {
  createWorkflowOwnerProfileNegativeCache,
  MAX_WORKFLOW_OWNER_PROFILES,
} from "../workflow-owner-profile-negative-cache";

describe("workflow owner profile negative cache", () => {
  it("evicts the oldest missing owner only after reaching 512 owners", () => {
    expect(MAX_WORKFLOW_OWNER_PROFILES).toBe(512);
    const cache = createWorkflowOwnerProfileNegativeCache();
    const at = 1000;
    for (let index = 0; index < MAX_WORKFLOW_OWNER_PROFILES; index += 1) {
      cache.record(`owner-${index}`, at);
    }
    expect(cache.has("owner-0", at)).toBeTruthy();
    expect(cache.has("owner-511", at)).toBeTruthy();

    cache.record(`owner-${MAX_WORKFLOW_OWNER_PROFILES}`, at);
    expect(cache.has("owner-0", at)).toBeFalsy();
    expect(cache.has("owner-1", at)).toBeTruthy();
    expect(cache.has(`owner-${MAX_WORKFLOW_OWNER_PROFILES}`, at)).toBeTruthy();
  });

  it("expires missing owners after sixty seconds", () => {
    const cache = createWorkflowOwnerProfileNegativeCache();
    cache.record("owner", 1000);
    expect(cache.has("owner", 60_999)).toBeTruthy();
    expect(cache.has("owner", 61_000)).toBeFalsy();
  });
});
