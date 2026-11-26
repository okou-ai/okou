import { randomUUID } from "node:crypto";

import { runnerRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { runnersRoutes } from "../runners";
import { nowDate } from "../../../lib/time";

const context = testContext();

function officialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function runnersClient() {
  return setupApp({ context, routes: runnersRoutes });
}

describe("RUN-01..04 and CHAIN-RUN: run admission, runner, and visible reads", () => {
  it("run-cron.bdd-002 accepts an official runner heartbeat that reports a held reusable sandbox", async () => {
    const group = `vm0/cron-${randomUUID().slice(0, 8)}`;

    const response = await accept(
      runnersClient()(runnersHeartbeatContract).heartbeat({
        headers: officialRunnerHeaders(),
        body: {
          runnerId: randomUUID(),
          runnerHostname: "runner-held.okou.app",
          group,
          snapshotGeneration: 1,
          snapshotSequence: 1,
          totalVcpu: 8,
          totalMemoryMb: 16_384,
          maxConcurrent: 2,
          allocatedVcpu: 0,
          allocatedMemoryMb: 0,
          runningCount: 0,
          admittableProfiles: ["vm0/default"],
          heldSandboxStates: [
            {
              reuseKey: `thread:${randomUUID()}`,
              lastCompletedAt: nowDate().toISOString(),
              reusableSandbox: {
                profile: "vm0/default",
                sourceRunId: randomUUID(),
              },
            },
          ],
          heldHomeStates: [],
          activeReuseProducers: [],
          ingressServiceActive: true,
          mode: "running",
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
  });

  it("run-cron.bdd-005 issues runner realtime tokens only to authenticated runners for vm0 groups", async () => {
    const issued = {
      keyName: "app.key",
      ttl: 3_600_000,
      timestamp: 1_700_000_000_000,
      capability: '{"runner-group:vm0/test":["subscribe"]}',
      nonce: "nonce",
      mac: "mac",
    };
    context.mocks.ably.createTokenRequest.mockResolvedValue(issued);
    const client = runnersClient()(runnerRealtimeTokenContract);

    const anonymous = await accept(
      client.create({ headers: {}, body: { group: "vm0/test" } }),
      [401],
    );
    const otherGroup = await accept(
      client.create({
        headers: officialRunnerHeaders(),
        body: { group: "other/test" },
      }),
      [403],
    );
    const official = await accept(
      client.create({
        headers: officialRunnerHeaders(),
        body: { group: "vm0/test" },
      }),
      [200],
    );

    expect(anonymous.body.error.code).toBe("UNAUTHORIZED");
    expect(otherGroup.body.error.code).toBe("FORBIDDEN");
    expect(official.body).toStrictEqual(issued);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: { "runner-group:vm0/test": ["subscribe"] },
      ttl: 3_600_000,
    });
  });
});
