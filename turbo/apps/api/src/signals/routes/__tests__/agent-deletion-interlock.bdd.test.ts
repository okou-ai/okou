import { testContext } from "../../../__tests__/test-context";
import { randomUUID } from "node:crypto";
import { holdDownloadSigning } from "./helpers/hold-download-signing";
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
    "deletes a legacy Agent and preserves the member Run while it is %s",
    async (status) => {
      const actor = bdd.user();
      await prepareRunCreation(actor);
      const target = await createAgent(actor, "Active Session Target");
      await bdd.updatePersonalInstructions(actor, `Active ${randomUUID()}`);
      const signing =
        status === "pending" ? holdDownloadSigning(context) : null;
      const chat = createChatFilesBddApi(context);
      const clientEventId = randomUUID();
      const sent = await chat.requestSendEvent(
        actor,
        {
          agentId: target.agentId,
          prompt: "continue through legacy Agent deletion",
          clientEventId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the member-owned input");
      }
      if (signing) {
        await signing.entered;
      } else {
        await flushWaitUntilForTest();
      }
      const runId = (
        await chat.listThreadEvents(actor, sent.body.threadId)
      ).events.find((event) => {
        return event.revokesEventId === clientEventId;
      })?.runId;
      if (!runId) {
        throw new Error("Expected the admitted member-owned Run");
      }
      const targetRun = { runId };
      const input =
        status === "running" ? await api.executionInput(runId) : null;
      await bdd.requestDeleteAgent(actor, target.agentId, [204]);
      const targetRunRead = await api.readRun(actor, targetRun.runId);
      expect(targetRunRead).toMatchObject({
        runId: targetRun.runId,
        status,
      });
      await api.requestCancelRun(actor, targetRun.runId, [200]);
      if (input) {
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId, exitCode: 137, error: "Run cancelled" },
          { authorization: `Bearer ${input.sandboxToken}` },
          [200],
        );
      }
      signing?.release();
      await flushWaitUntilForTest();
    },
  );
});
