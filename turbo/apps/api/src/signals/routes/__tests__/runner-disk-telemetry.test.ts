import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();

describe("Runner disk telemetry HTTP compatibility", () => {
  it("accepts legacy, independent, missing and malformed optional snapshots on an authenticated claimed run", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const group = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Disk telemetry",
      visibility: "private",
    });
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Observe disk independently",
    });
    const runnerId = randomUUID();
    await runs.requestRawHeartbeatRunner(true, [200], {
      runnerId,
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
      heldSandboxStates: [],
      heldHomeStates: [],
      activeReuseProducers: [],
      mode: "running",
    });
    const polled = await runs.requestPollRunner(
      true,
      {
        runnerId,
        group,
        supportedProfiles: ["vm0/default"],
      },
      [200],
    );
    expect(polled.body).toMatchObject({ job: { runId: run.runId } });
    const claimed = await runs.requestClaimRunnerJob(true, run.runId, [200], {
      runnerIdentity: { runnerId, heartbeatGeneration: 1 },
    });
    if (claimed.status !== 200) {
      throw new Error("Expected claim");
    }
    const headers = { authorization: `Bearer ${claimed.body.sandboxToken}` };
    const metric = {
      ts: "2026-10-10T00:00:00Z",
      cpu: 1,
      mem_used: 10,
      mem_total: 100,
      disk_used: 20,
      disk_total: 100,
    };
    const rootfs = {
      used_bytes: 20,
      total_bytes: 100,
      available_bytes: 70,
      used_inodes: 4,
      total_inodes: 10,
      available_inodes: 5,
    };
    const home = {
      used_bytes: 200,
      total_bytes: 200,
      available_bytes: 0,
      used_inodes: 20,
      total_inodes: 20,
      available_inodes: 0,
    };
    for (const snapshot of [
      metric,
      { ...metric, rootfs, home },
      { ...metric, rootfs },
      { ...metric, home },
      { ...metric, rootfs, home: { used_bytes: -1 } },
    ]) {
      const response = await webhooks.requestAgentTelemetryUnchecked(
        { runId: run.runId, systemLog: "ordinary log", metrics: [snapshot] },
        headers,
        [200],
      );
      expect(response.body).toMatchObject({ success: true, id: run.runId });
    }
    const mismatched = await webhooks.requestAgentTelemetry(
      { runId: randomUUID(), metrics: [metric] },
      headers,
      [401],
    );
    expect(mismatched.status).toBe(401);
    const completed = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "disk full",
        failureReason: "guest_home_filesystem_full",
      },
      headers,
      [200],
    );
    expect(completed.status).toBe(200);
    const readback = await runs.requestReadRun(actor, run.runId, [200]);
    expect(readback.body).toMatchObject({ status: "failed" });
    // Queued/claimed identity and persisted terminal state are observed through
    // production endpoints, not private DB fixtures.
  });
});
