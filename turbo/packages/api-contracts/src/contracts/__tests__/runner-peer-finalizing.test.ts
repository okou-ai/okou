import { describe, expect, it } from "vitest";
import { heartbeatBodySchema, runnerPreferenceSchema } from "../runners";

const heartbeat = {
  runnerId: "22222222-2222-4222-8222-222222222222",
  group: "vm0/production",
  snapshotGeneration: 7,
  snapshotSequence: 1,
  totalVcpu: 8,
  totalMemoryMb: 16384,
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

describe("peer finalizing reader and hostname preparation", () => {
  it("preserves configured hostname with empty initial inventory and accepts old omission", () => {
    expect(heartbeatBodySchema.parse(heartbeat)).not.toHaveProperty(
      "runnerHostname",
    );
    const current = {
      ...heartbeat,
      runnerHostname: "prod-11.aws.example.test",
    };
    expect(heartbeatBodySchema.parse(current)).toStrictEqual(current);
  });

  it.each(["", "x".repeat(256), null])(
    "rejects invalid hostname %s",
    (runnerHostname) => {
      expect(
        heartbeatBodySchema.safeParse({ ...heartbeat, runnerHostname }).success,
      ).toBe(false);
    },
  );

  it.each([
    "exactSandbox",
    "finalizingPredecessor",
    "peerFinalizingPredecessor",
    "reusableSandbox",
    "homeCache",
  ])("reads %s with the canonical identity and immutable expiry", (tier) => {
    const preference = {
      kind: "preference",
      runnerIdentity: { runnerId: heartbeat.runnerId, heartbeatGeneration: 7 },
      tier,
      expiresAt: "2026-10-20T00:00:49.000Z",
    };
    expect(runnerPreferenceSchema.parse(preference)).toStrictEqual(preference);
    expect(
      runnerPreferenceSchema.safeParse({ ...preference, tier: "unknown" })
        .success,
    ).toBe(false);
  });
});
