import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();

// Also execute this unchanged driver against outgoing API source
// 803ede641fb73f38a56c8d799d25bbe14d4def6a. Omitting optional fields on THIS
// implementation is not evidence that the actual outgoing API was exercised.
describe("outgoing/prepared Runner protocol execution", () => {
  it.each(["outgoing", "prepared"] as const)(
    "accepts the %s heartbeat, poll and queued claim",
    async (sender) => {
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
      // Prepared capable-empty is a distinct capability observation, not a
      // workspace image translated into home state. Current production writer
      // remains outgoing-shaped until the coherent cutover.
      const capability =
        sender === "prepared"
          ? { homeAffinityVersion: 1, heldHomeStates: [] }
          : {};
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
        heldWorkspaceStates: [],
        activeReuseProducers: [],
        mode: "running",
        ...capability,
      });
      const polled = await api.requestPollRunner(
        true,
        {
          runnerId,
          group,
          supportedProfiles: ["vm0/default"],
          ...(sender === "prepared" ? { heartbeatGeneration: 7 } : {}),
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
    },
  );
});
