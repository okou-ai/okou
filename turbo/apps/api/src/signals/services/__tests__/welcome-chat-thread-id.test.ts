import { describe, expect, it } from "vitest";

import { automaticWelcomeChatThreadId } from "../welcome-chat-thread.service";

/**
 * Expected ids were produced outside this repository, by Python's
 * `uuid.uuid5(uuid.UUID("92aa933e-a5fe-4b89-8d50-955b93b40459"), f"{userId}:{orgId}")`.
 * They are literals on purpose: an expectation recomputed with the same
 * library the implementation uses could not detect a changed namespace,
 * a changed input order, or a changed separator.
 */
const CONTRACT = [
  {
    userId: "user_welcome_fixed",
    orgId: "org_welcome_fixed",
    expected: "1df9ef02-cfe1-51c3-a827-c20f7f5600d0",
  },
  {
    userId: "user_a",
    orgId: "org_b",
    expected: "8b5823f6-2828-5529-80ec-c449166e8293",
  },
] as const;

describe("automatic welcome thread id", () => {
  it.each(CONTRACT)(
    "derives $expected from $userId in $orgId",
    ({ userId, orgId, expected }) => {
      expect(automaticWelcomeChatThreadId({ userId, orgId })).toBe(expected);
    },
  );

  it("separates recipients, workspaces and the two identity fields", () => {
    const id = automaticWelcomeChatThreadId({
      userId: "user_a",
      orgId: "org_b",
    });
    expect(
      automaticWelcomeChatThreadId({ userId: "user_a", orgId: "org_c" }),
    ).not.toBe(id);
    expect(
      automaticWelcomeChatThreadId({ userId: "user_b", orgId: "org_b" }),
    ).not.toBe(id);
    // A swapped pair must not collide with the original ordering.
    expect(
      automaticWelcomeChatThreadId({ userId: "org_b", orgId: "user_a" }),
    ).not.toBe(id);
  });
});
