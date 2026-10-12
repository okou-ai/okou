import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();

describe("canonical Runner protocol execution", () => {
  it("rejects an incomplete whole-state heartbeat", async () => {
    const api = createRunsApi(context);
    const response = await api.requestRawHeartbeatRunner(true, [400], {
      runnerId: randomUUID(),
      group: api.configureRunnerGroup(),
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
      activeReuseProducers: [],
      mode: "running",
    });
    expect(response.status).toBe(400);
  });
  it("executes heartbeat, poll, claim and completion with explicit empty home state", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const group = api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Protocol matrix",
      description: "Queued job handoff",
      visibility: "private",
    });
    const run = await api.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Preserve ordinary execution",
    });
    const runnerId = randomUUID();
    await api.requestRawHeartbeatRunner(true, [200], {
      runnerId,
      group,
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
    });
    const polled = await api.requestPollRunner(
      true,
      {
        runnerId,
        group,
        supportedProfiles: ["vm0/default"],
      },
      [200],
    );
    if (polled.status !== 200) {
      throw new Error("Expected compatible poll");
    }
    expect(polled.body.job).toMatchObject({
      runId: run.runId,
      runnerPreference: { kind: "noPreference" },
    });
    const claimed = await api.requestClaimRunnerJob(true, run.runId, [200], {
      runnerIdentity: { runnerId, heartbeatGeneration: 7 },
    });
    if (claimed.status !== 200) {
      throw new Error("Expected compatible claim");
    }
    expect(claimed.body).toMatchObject({
      runId: run.runId,
      prompt: "Preserve ordinary execution",
    });
    expect(claimed.body).not.toHaveProperty("runnerPreference");
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId: run.runId, exitCode: 0 },
      { authorization: `Bearer ${claimed.body.sandboxToken}` },
      [200],
    );
  });
});
