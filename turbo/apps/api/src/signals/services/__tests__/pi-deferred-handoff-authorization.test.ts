import { describe, expect, it } from "vitest";

import { hasDeferredPiHandoffAuthority } from "../pi-deferred-handoff-authorization";

const auth = {
  runId: "00000000-0000-4000-8000-000000000001",
  userId: "user-1",
  orgId: "org-1",
  piSandbox: { ownerEpoch: 7, generation: 3 },
} as const;

const owner = {
  runId: auth.runId,
  userId: auth.userId,
  orgId: auth.orgId,
  runStatus: "running",
  phase: "sandbox_running",
  ownerEpoch: 7,
  generation: 3,
  leaseState: "claimed",
} as const;

const insufficientAuth = {
  runId: auth.runId,
  userId: auth.userId,
  orgId: auth.orgId,
} as const;

describe("deferred Pi handoff authority", () => {
  it("accepts only the exact claimed Guest control identity", () => {
    expect(hasDeferredPiHandoffAuthority(auth, owner)).toBe(true);
  });

  it.each([
    ["insufficient authority", insufficientAuth, owner],
    ["wrong run", { ...auth, runId: "other-run" }, owner],
    ["wrong user", { ...auth, userId: "other-user" }, owner],
    ["wrong org", { ...auth, orgId: "other-org" }, owner],
    [
      "stale epoch",
      { ...auth, piSandbox: { ownerEpoch: 6, generation: 3 } },
      owner,
    ],
    [
      "stale generation",
      { ...auth, piSandbox: { ownerEpoch: 7, generation: 2 } },
      owner,
    ],
    ["unclaimed lease", auth, { ...owner, leaseState: "preparing" }],
    ["terminal run", auth, { ...owner, runStatus: "failed" }],
    ["wrong phase", auth, { ...owner, phase: "sandbox_ready" }],
  ] as const)("rejects %s", (_label, candidateAuth, candidateOwner) => {
    expect(hasDeferredPiHandoffAuthority(candidateAuth, candidateOwner)).toBe(
      false,
    );
  });
});
