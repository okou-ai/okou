import { describe, expect, it } from "vitest";
import {
  heartbeatBodySchema,
  heldHomeStateSchema,
  runnerClaimCapabilitiesSchema,
  runnerPreferenceSchema,
  runnersPollContract,
} from "../runners";
import { webhookTelemetryContract } from "../webhooks";

function outgoingHeartbeat() {
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
    heldWorkspaceStates: [],
    activeReuseProducers: [],
    mode: "running",
  };
}
const home = {
  reuseKey: "thread:thread-a",
  lastCompletedAt: "2026-10-09T08:00:00+08:00",
  homeCaches: [{ profile: "vm0/default", homeAffinityVersion: 1 }],
};

describe("additive home affinity contracts", () => {
  it("defaults absent observations to empty without manufacturing capability", () => {
    const old = heartbeatBodySchema.parse(outgoingHeartbeat());
    expect(old.heldHomeStates).toEqual([]);
    expect(old).not.toHaveProperty("homeAffinityVersion");
    const empty = heartbeatBodySchema.parse({
      ...outgoingHeartbeat(),
      homeAffinityVersion: 1,
    });
    expect(empty.homeAffinityVersion).toBe(1);
    expect(empty.heldHomeStates).toEqual([]);
    expect(
      heartbeatBodySchema.parse({
        ...outgoingHeartbeat(),
        homeAffinityVersion: 1,
        heldHomeStates: [home],
      }).heldHomeStates,
    ).toEqual([home]);
  });

  it("bounds each home key and the complete snapshot independently of outgoing state", () => {
    expect(
      heldHomeStateSchema.safeParse({ ...home, homeCaches: [] }).success,
    ).toBe(false);
    expect(
      heldHomeStateSchema.safeParse({
        ...home,
        homeCaches: Array.from({ length: 9 }, () => {return home.homeCaches[0]}),
      }).success,
    ).toBe(false);
    expect(
      heldHomeStateSchema.safeParse({
        ...home,
        homeCaches: [{ profile: "vm0/default", homeAffinityVersion: 2 }],
      }).success,
    ).toBe(false);
    expect(
      heldHomeStateSchema.safeParse({ ...home, lastCompletedAt: "not-a-date" })
        .success,
    ).toBe(false);
    const states = Array.from({ length: 128 }, () => {return {
      ...home,
      homeCaches: Array.from({ length: 8 }, () => {return {
        profile: "vm0/default",
        homeAffinityVersion: 1,
      }}),
    }});
    expect(
      heartbeatBodySchema.safeParse({
        ...outgoingHeartbeat(),
        homeAffinityVersion: 1,
        heldHomeStates: states,
      }).success,
    ).toBe(true);
    expect(
      heartbeatBodySchema.safeParse({
        ...outgoingHeartbeat(),
        heldHomeStates: [...states, home],
      }).success,
    ).toBe(false);
    expect(
      heartbeatBodySchema.safeParse({
        ...outgoingHeartbeat(),
        heldHomeStates: Array.from({ length: 1025 }, () => {return home}),
      }).success,
    ).toBe(false);
    expect(
      heartbeatBodySchema.safeParse({
        ...outgoingHeartbeat(),
        homeAffinityVersion: 2,
      }).success,
    ).toBe(false);
  });

  it("adds poll process identity without widening strict claim capabilities", () => {
    const poll = {
      runnerId: outgoingHeartbeat().runnerId,
      group: "vm0/test",
      supportedProfiles: ["vm0/default"],
    };
    expect(runnersPollContract.poll.body.parse(poll)).not.toHaveProperty(
      "heartbeatGeneration",
    );
    expect(
      runnersPollContract.poll.body.parse({ ...poll, heartbeatGeneration: 7 }),
    ).toMatchObject({ heartbeatGeneration: 7 });
    for (const generation of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        runnersPollContract.poll.body.safeParse({
          ...poll,
          heartbeatGeneration: generation,
        }).success,
      ).toBe(false);
    }
    const capabilities = { piModelConfigGenerations: [1, 2, 3, 5] };
    expect(runnerClaimCapabilitiesSchema.parse(capabilities)).toEqual(
      capabilities,
    );
    expect(
      runnerClaimCapabilitiesSchema.safeParse({
        ...capabilities,
        homeAffinityVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("prepares closed preference and history-source readers without aliasing workspace tokens", () => {
    for (const tier of ["homeCache", "workspaceCache"]) {
      expect(
        runnerPreferenceSchema.parse({
          kind: "preference",
          runnerIdentity: {
            runnerId: outgoingHeartbeat().runnerId,
            heartbeatGeneration: 7,
          },
          tier,
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      ).toMatchObject({ tier });
    }
    for (const source of ["home_cache", "workspace_cache"]) {
      const parsed = webhookTelemetryContract.send.body.parse({
        runId: outgoingHeartbeat().runnerId,
        sandboxOperations: [
          {
            ts: "2026-10-09T00:00:00Z",
            action_type: "session_history_transfer",
            success: true,
            duration_ms: 1,
            session_history_transfer_source: source,
          },
        ],
      });
      expect(parsed.sandboxOperations?.[0]).toMatchObject({
        session_history_transfer_source: source,
      });
    }
  });
});
