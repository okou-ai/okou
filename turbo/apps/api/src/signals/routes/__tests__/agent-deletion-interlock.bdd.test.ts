import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);

async function createAgent(
  actor: ApiTestUser,
  displayName: string,
): Promise<{ readonly agentId: string }> {
  bdd.acceptAgentStorageWrites();
  return await bdd.createAgent(actor, { displayName });
}

async function prepareRunCreation(...actors: readonly ApiTestUser[]) {
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const group = api.configureRunnerGroup();
  for (const actor of actors) {
    await api.grantProEntitlement(actor);
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
  }
  return group;
}

describe("DELETE /api/agents/:id lifecycle cleanup", () => {
  it.each(["pending", "running"] as const)(
    "blocks Agent deletion while its Run is %s",
    async (status) => {
      const actor = bdd.user();
      const group = await prepareRunCreation(actor);
      const target = await createAgent(actor, "Active Session Target");
      const targetRun = await api.createThreadRun(actor, {
        agentId: target.agentId,
        prompt: "block target deletion",
      });
      if (status === "running") {
        await api.heartbeatRunner(group);
        await api.claimRunnerJob(targetRun.runId);
      }
      const response = await bdd.requestDeleteAgent(
        actor,
        target.agentId,
        [409],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: "Cannot delete agent: agent is currently running",
          code: "CONFLICT",
        },
      });
      const targetRunRead = await api.readRun(actor, targetRun.runId);
      expect(targetRunRead).toMatchObject({
        runId: targetRun.runId,
        status,
      });
      await expect(bdd.readAgent(actor, target.agentId)).resolves.toMatchObject(
        {
          agentId: target.agentId,
        },
      );
      await api.requestCancelRun(actor, targetRun.runId, [200]);
    },
  );
});
