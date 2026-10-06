import { randomUUID } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  type ChatRunSendBody,
  userMessages,
} from "./helpers/chat-events-fixture";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { coolDownBuiltInRoutesThroughReports } from "./helpers/public-built-in-model-cooldown";

// Public callback/cooldown contracts own a private real SQL database per case.
// Concurrent fixed-Auto readers must never observe this suite's provider reports.
const context = testContext();

const {
  api,
  chat,
  entitledChatActor,
  configureBuiltInPiModel,
  waitForThreadMessages,
  mockPiCheckpointObjectStore,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

async function preparePiResourceHandoff(
  actor: ApiTestUser,
  agentId: string,
): Promise<void> {
  await publishPendingPiInstructions(actor, agentId);
  mockPiResourceArchiveDownloads(true);
  mockPiCheckpointObjectStore();
}

async function builtInModelWithOpenRouterCoolingDown(
  actor: ApiTestUser,
  agentId: string,
  runnerGroup: string,
): Promise<"okou-1.0"> {
  await configureBuiltInPiModel(actor, "okou-1.0");
  await preparePiResourceHandoff(actor, agentId);
  await coolDownBuiltInRoutesThroughReports(context, {
    actor,
    agentId,
    runnerGroup,
    model: "okou-1.0",
    routes: [
      { providerType: "openrouter-codex", upstreamModel: "@preset/okou-1-0" },
    ],
  });
  return "okou-1.0";
}

async function waitForPickedInput(
  actor: ApiTestUser,
  threadId: string,
  clientEventId: string,
) {
  await flushWaitUntilForTest();
  const messages = await waitForThreadMessages(actor, threadId, (items) => {
    return userMessages(items).some((message) => {
      return (
        message.revokesEventId === clientEventId &&
        (message.eventType === "input.rejected" || message.runId !== undefined)
      );
    });
  });
  const picked = userMessages(messages.events).find((message) => {
    return message.revokesEventId === clientEventId;
  });
  if (!picked) {
    throw new Error("Expected the picked input replacement");
  }
  return { picked, events: messages.events };
}

async function sendUntilPicked(
  actor: ApiTestUser,
  body: Omit<ChatRunSendBody, "template" | "clientEventId">,
) {
  const clientEventId = randomUUID();
  const sent = await chat.requestSendEvent(
    actor,
    { ...body, clientEventId },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected the send to be accepted");
  }
  expect(sent.body.runId).toBeNull();
  const threadId = sent.body.threadId;
  return {
    threadId,
    ...(await waitForPickedInput(actor, threadId, clientEventId)),
  };
}

describe("CHAT-02: isolated Auto cooldown callbacks", () => {
  it.each(["okou-1.0"] as const)(
    "fails closed for built-in %s when its required OpenRouter route is unavailable",
    async () => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = await builtInModelWithOpenRouterCoolingDown(
        actor,
        agentId,
        runnerGroup,
      );
      await api.updateUserModelPreference(actor, model);
      const thread = await chat.createThread(actor, { agentId, model });
      // Own even an unexpectedly admitted input before checking the rejection.
      // The real thread deletion cancels its pending work before route cleanup.
      onTestFinished(async () => {
        await createChatFilesBddApi(context).deleteThread(actor, thread.id);
        await flushWaitUntilForTest();
      });
      const { picked } = await sendUntilPicked(actor, {
        agentId,
        threadId: thread.id,
        prompt: "require the managed OpenRouter DeepSeek route",
        model,
      });
      expect(picked).toMatchObject({
        eventType: "input.rejected",
        error: "model_provider_unavailable",
      });
    },
  );
});
