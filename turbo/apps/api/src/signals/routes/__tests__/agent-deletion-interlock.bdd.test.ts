import { testContext } from "../../../__tests__/test-context";
import { randomUUID } from "node:crypto";
import { holdCurrentSecretKms } from "./helpers/hold-secret-kms";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

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
  const group = await api.configureRunnerGroup();
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
      await prepareRunCreation(actor);
      const target = await createAgent(actor, "Active Session Target");
      const kms =
        status === "pending" ? holdCurrentSecretKms(context.signal) : null;
      const chat = createChatFilesBddApi(context);
      const clientEventId = randomUUID();
      const sent = await chat.requestSendEvent(
        actor,
        {
          agentId: target.agentId,
          prompt: "block target deletion",
          clientEventId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the deletion-blocking input");
      }
      if (kms) {
        await kms.entered;
      } else {
        await flushWaitUntilForTest();
      }
      const runId = (
        await chat.listThreadEvents(actor, sent.body.threadId)
      ).events.find((event) => {
        return event.revokesEventId === clientEventId;
      })?.runId;
      if (!runId) {
        throw new Error("Expected the admitted deletion-blocking Run");
      }
      const targetRun = { runId };
      const input =
        status === "running" ? await api.executionInput(runId) : null;
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
      if (input) {
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId, exitCode: 137, error: "Run cancelled" },
          { authorization: `Bearer ${input.sandboxToken}` },
          [200],
        );
      }
      kms?.release();
      await flushWaitUntilForTest();
    },
  );
});
