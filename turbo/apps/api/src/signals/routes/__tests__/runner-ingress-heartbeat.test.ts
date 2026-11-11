import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { runnersRoutes } from "../runners";

const context = testContext();
const headers = Object.freeze({
  authorization: `Bearer vm0_official_${"c".repeat(64)}`,
});
function api() {
  return setupApp({ context, routes: runnersRoutes })(runnersHeartbeatContract);
}

function heartbeat(runnerId = randomUUID(), snapshotSequence = 1) {
  return {
    runnerId,
    group: "vm0/test",
    snapshotGeneration: 7,
    snapshotSequence,
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
    mode: "running" as const,
  };
}

function observation() {
  return {
    processNonce: randomUUID(),
    caddyServiceActive: false,
    listenerReady: true,
    protocolVersion: 1 as const,
    dispatchProtocolVersion: 0,
  };
}

describe("optional Runner ingress heartbeat contract", () => {
  beforeEach(() => {
    mockEnv("OFFICIAL_RUNNER_SECRET", "c".repeat(64));
  });

  it("accepts old, Caddy-unavailable, recovered and omitted observations without blocking heartbeats", async () => {
    const runnerId = randomUUID();
    const legacy = await accept(
      api().heartbeat({ headers, body: heartbeat(runnerId, 1) }),
      [200],
    );
    expect(legacy.body).toStrictEqual({ ok: true });
    const ingress = observation();
    await accept(
      api().heartbeat({
        headers,
        body: { ...heartbeat(runnerId, 2), ingress },
      }),
      [200],
    );
    await accept(
      api().heartbeat({
        headers,
        body: {
          ...heartbeat(runnerId, 3),
          ingress: { ...ingress, caddyServiceActive: true },
        },
      }),
      [200],
    );
    await accept(
      api().heartbeat({
        headers,
        body: {
          ...heartbeat(runnerId, 4),
          ingress: { ...ingress, listenerReady: false },
        },
      }),
      [200],
    );
    await accept(
      api().heartbeat({ headers, body: heartbeat(runnerId, 5) }),
      [200],
    );
    // The accepted snapshot order remains tolerant of late/duplicate writers.
    await accept(
      api().heartbeat({
        headers,
        body: { ...heartbeat(runnerId, 2), ingress },
      }),
      [200],
    );
  });

  it("rejects malformed process identity and negative protocol support at the HTTP boundary", async () => {
    await expect(
      api().heartbeat({
        headers,
        body: {
          ...heartbeat(),
          ingress: { ...observation(), processNonce: "not-a-uuid" },
        },
      }),
    ).resolves.toMatchObject({ status: 400 });
    await accept(
      api().heartbeat({
        headers,
        body: {
          ...heartbeat(),
          ingress: { ...observation(), dispatchProtocolVersion: -1 },
        },
      }),
      [400],
    );
  });

  it("does not let a claimed observation bypass heartbeat authentication", async () => {
    await expect(
      api().heartbeat({
        headers: {},
        body: {
          ...heartbeat(),
          ingress: { ...observation(), caddyServiceActive: true },
        },
      }),
    ).resolves.toMatchObject({ status: 401 });
  });
});
