import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
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

describe("Runner ingress service heartbeat contract", () => {
  beforeEach(() => {
    mockEnv("OFFICIAL_RUNNER_SECRET", "c".repeat(64));
  });

  it("accepts old, unavailable, recovered and omitted service observations without blocking heartbeats", async () => {
    const runnerId = randomUUID();
    const legacy = await accept(
      api().heartbeat({ headers, body: heartbeat(runnerId, 1) }),
      [200],
    );
    expect(legacy.body).toStrictEqual({ ok: true });
    for (const [index, ingressServiceActive] of [
      false,
      true,
      false,
    ].entries()) {
      await accept(
        api().heartbeat({
          headers,
          body: { ...heartbeat(runnerId, index + 2), ingressServiceActive },
        }),
        [200],
      );
    }
    await accept(
      api().heartbeat({ headers, body: heartbeat(runnerId, 5) }),
      [200],
    );
    await accept(
      api().heartbeat({
        headers,
        body: { ...heartbeat(runnerId, 2), ingressServiceActive: true },
      }),
      [200],
    );
  });

  it("rejects nonboolean service activity at the HTTP boundary", async () => {
    const request = setupRawAppRequest({ context, routes: runnersRoutes });
    for (const ingressServiceActive of ["true", 1, null]) {
      await expect(
        request("/api/runners/heartbeat", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ ...heartbeat(), ingressServiceActive }),
        }),
      ).resolves.toMatchObject({ status: 400 });
    }
  });

  it("does not let claimed service activity bypass heartbeat authentication", async () => {
    await expect(
      api().heartbeat({
        headers: {},
        body: { ...heartbeat(), ingressServiceActive: true },
      }),
    ).resolves.toMatchObject({ status: 401 });
  });
});
