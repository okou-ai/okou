import { describe, expect, it } from "vitest";
import {
  heartbeatBodySchema,
  heldHomeStateSchema,
  runnerClaimCapabilitiesSchema,
  runnerPreferenceSchema,
} from "../runners";

function canonicalHeartbeat() {
  return {
    runnerId: "550e8400-e29b-41d4-a716-446655440000",
    group: "vm0/test",
    snapshotGeneration: 7,
    snapshotSequence: 42,
    totalVcpu: 8,
    totalMemoryMb: 16_384,
    maxConcurrent: 2,
    allocatedVcpu: 0,
    allocatedMemoryMb: 0,
    runningCount: 0,
    admittableProfiles: ["vm0/default"],
    heldSandboxStates: [],
    heldHomeStates: [],
    activeReuseProducers: [],
    mode: "running",
  };
}
const home = {
  reuseKey: "thread:thread-a",
  lastCompletedAt: "2026-10-09T08:00:00+08:00",
  homeCaches: [
    {
      sourceRunId: "33333333-3333-4333-8333-333333333333",
      profile: "vm0/default",
      homeAffinityVersion: 1,
    },
  ],
};

describe("canonical home affinity contracts", () => {
  it("preserves heartbeat resource producers", () => {
    const source = { sourceRunId: "33333333-3333-4333-8333-333333333333" };
    const heldSandboxStates = [
      {
        reuseKey: home.reuseKey,
        lastCompletedAt: home.lastCompletedAt,
        reusableSandbox: { profile: "vm0/default", ...source },
      },
    ];
    const heldHomeStates = [
      {
        ...home,
        homeCaches: [
          { profile: "vm0/default", homeAffinityVersion: 1, ...source },
          { profile: "vm0/large", homeAffinityVersion: 1, ...source },
        ],
      },
    ];
    const parsed = heartbeatBodySchema.parse({
      ...canonicalHeartbeat(),
      heldSandboxStates,
      heldHomeStates,
    });
    expect(parsed.heldSandboxStates).toEqual(heldSandboxStates);
    expect(parsed.heldHomeStates).toEqual(heldHomeStates);
  });

  it.each(["exactSandbox", "sourceHomeCache"])(
    "preserves the previous Run on %s",
    (tier) => {
      const preference = {
        kind: "preference",
        runnerIdentity: {
          runnerId: canonicalHeartbeat().runnerId,
          heartbeatGeneration: 7,
        },
        tier,
        expiresAt: "2099-01-01T00:00:00Z",
        finalizingSourceRunId: "33333333-3333-4333-8333-333333333333",
      };
      expect(runnerPreferenceSchema.parse(preference)).toEqual(preference);
    },
  );

  it("requires whole home inventory, including explicit empty state", () => {
    const { heldHomeStates, ...missingInventory } = canonicalHeartbeat();
    expect(heartbeatBodySchema.safeParse(missingInventory).success).toBe(false);
    expect(heldHomeStates).toEqual([]);
    const empty = heartbeatBodySchema.parse(canonicalHeartbeat());
    expect(empty.heldHomeStates).toEqual([]);
    expect(
      heartbeatBodySchema.parse({
        ...canonicalHeartbeat(),
        heldHomeStates: [home],
      }).heldHomeStates,
    ).toEqual([home]);
  });

  it("bounds each home key and the complete snapshot in the whole snapshot", () => {
    expect(
      heldHomeStateSchema.safeParse({ ...home, homeCaches: [] }).success,
    ).toBe(false);
    expect(
      heldHomeStateSchema.safeParse({
        ...home,
        homeCaches: Array.from({ length: 9 }, () => {
          return home.homeCaches[0];
        }),
      }).success,
    ).toBe(false);
    expect(
      heldHomeStateSchema.safeParse({
        ...home,
        homeCaches: [
          {
            sourceRunId: "33333333-3333-4333-8333-333333333333",
            profile: "vm0/default",
            homeAffinityVersion: 2,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      heldHomeStateSchema.safeParse({ ...home, lastCompletedAt: "not-a-date" })
        .success,
    ).toBe(false);
    const states = Array.from({ length: 128 }, () => {
      return {
        ...home,
        homeCaches: Array.from({ length: 8 }, () => {
          return {
            sourceRunId: "33333333-3333-4333-8333-333333333333",
            profile: "vm0/default",
            homeAffinityVersion: 1,
          };
        }),
      };
    });
    expect(
      heartbeatBodySchema.safeParse({
        ...canonicalHeartbeat(),
        heldHomeStates: states,
      }).success,
    ).toBe(true);
    expect(
      heartbeatBodySchema.safeParse({
        ...canonicalHeartbeat(),
        heldHomeStates: [...states, home],
      }).success,
    ).toBe(false);
    expect(
      heartbeatBodySchema.safeParse({
        ...canonicalHeartbeat(),
        heldHomeStates: Array.from({ length: 1025 }, () => {
          return home;
        }),
      }).success,
    ).toBe(false);
    expect(
      heartbeatBodySchema.safeParse({
        ...canonicalHeartbeat(),
        heldHomeStates: [
          {
            ...home,
            homeCaches: [
              {
                sourceRunId: "33333333-3333-4333-8333-333333333333",
                profile: "vm0/default",
                homeAffinityVersion: 2,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps claim capabilities closed", () => {
    const capabilities = { piModelConfigGenerations: [1, 2, 3, 5] };
    expect(runnerClaimCapabilitiesSchema.parse(capabilities)).toEqual(
      capabilities,
    );
    expect(
      runnerClaimCapabilitiesSchema.safeParse({
        ...capabilities,
        unknownCapability: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts canonical runner preferences and rejects unknown tiers", () => {
    expect(
      runnerPreferenceSchema.parse({
        kind: "preference",
        runnerIdentity: {
          runnerId: canonicalHeartbeat().runnerId,
          heartbeatGeneration: 7,
        },
        tier: "homeCache",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    ).toMatchObject({ tier: "homeCache" });
    expect(
      runnerPreferenceSchema.safeParse({
        kind: "preference",
        runnerIdentity: {
          runnerId: canonicalHeartbeat().runnerId,
          heartbeatGeneration: 7,
        },
        tier: "unknownCache",
        expiresAt: "2099-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});
