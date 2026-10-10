import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);

async function actorWithAgent() {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Model identity writer",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId };
}

describe("model identity new writes", () => {
  it.each([null, "auto"])(
    "creates canonical Auto from intent %s",
    async (model) => {
      const { actor, agentId } = await actorWithAgent();
      const thread = await chat.createThread(actor, { agentId, model });
      await expect(
        chat.readThreadMetadata(actor, thread.id),
      ).resolves.toMatchObject({
        selectedModel: "auto",
        modelSettings: {},
        serviceTier: null,
      });
      const events = await chat.requestThreadEvents(actor, {}, [200]);
      expect(events.body).toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({
            kind: "created",
            chatThreadId: thread.id,
            selectedModel: "auto",
          }),
        ]),
      });
    },
  );

  it("resolves an omitted creation model from the member's personal preference", async () => {
    const { actor, agentId } = await actorWithAgent();
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-sonnet-5-5",
    });
    const client = setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    );
    const created = await accept(
      client.create({
        headers: { authorization: "Bearer clerk-session" },
        body: { agentId },
      }),
      [201],
    );
    expect(created.body.selectedModel).toBe("claude-sonnet-5-5");
    await expect(
      chat.readThreadMetadata(actor, created.body.id),
    ).resolves.toMatchObject({ selectedModel: "claude-sonnet-5-5" });
  });

  it("preserves a personal selection and effort when rename and send omit the model", async () => {
    const { actor, agentId } = await actorWithAgent();
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-sonnet-5-5",
    });
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-5-5",
    });
    await chat.updateThreadModelSelection(
      actor,
      thread.id,
      "claude-sonnet-5-5",
      { reasoningEffort: "extra" },
    );
    await chat.renameThread(actor, thread.id, "Keep my selection");
    const run = await runs.createThreadRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Continue my personal model",
    });
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      title: "Keep my selection",
      selectedModel: "claude-sonnet-5-5",
      modelSettings: { "claude-sonnet-5-5": { effort: "extra" } },
    });
    const history = await chat.listThreadEvents(actor, thread.id);
    expect(history.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        runId: run.runId,
        userMessage: {
          version: 1,
          parts: expect.arrayContaining([
            expect.objectContaining({
              type: "model",
              selectedModel: "claude-sonnet-5-5",
            }),
          ]),
        },
      }),
    );
    const reads = createRunReadsApi(context);
    const captured = await reads.requestReadLogById(actor, run.runId, [200]);
    expect(captured.body).toMatchObject({
      selectedModel: "claude-sonnet-5-5",
      modelRuntimeProvider: "claude-code-oauth-token",
      modelRuntimeModel: expect.any(String),
    });
    expect(captured.body.modelRuntimeModel).not.toBe("");
    await chat.updateThreadModelSelection(actor, thread.id, "auto");
    await runs.requestCancelRun(actor, run.runId, [200]);
    const retained = await reads.requestReadLogById(actor, run.runId, [200]);
    expect(retained.body).toMatchObject({
      selectedModel: captured.body.selectedModel,
      modelRuntimeProvider: captured.body.modelRuntimeProvider,
      modelRuntimeModel: captured.body.modelRuntimeModel,
    });
  });

  it("keeps personal effort when switching to Auto and rejects Auto effort and Fast", async () => {
    const { actor, agentId } = await actorWithAgent();
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-sonnet-5-5",
    });
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-5-5",
    });
    await chat.updateThreadModelSelection(
      actor,
      thread.id,
      "claude-sonnet-5-5",
      { reasoningEffort: "extra" },
    );
    await chat.updateThreadModelSelection(actor, thread.id, null);
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "auto",
      modelSettings: { "claude-sonnet-5-5": { effort: "extra" } },
      serviceTier: null,
    });
    await chat.requestUpdateThreadModelSelection(
      actor,
      thread.id,
      "auto",
      [400],
      { reasoningEffort: "high" },
    );
    await chat.requestUpdateThreadModelSelection(
      actor,
      thread.id,
      "auto",
      [400],
      { codexServiceTier: "fast" },
    );
    await chat.requestUpdateThreadModelSelection(
      actor,
      thread.id,
      "okou-1.0",
      [400],
    );
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "auto",
      modelSettings: { "claude-sonnet-5-5": { effort: "extra" } },
    });
  });

  it("writes canonical Auto on a send and rejects unavailable platform execution", async () => {
    const { actor, agentId } = await actorWithAgent();
    await runs.grantProEntitlement(actor);
    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        clientEventId,
        prompt: "Use the platform model",
        model: null,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected accepted input");
    }
    expect(sent.body.runId).toBeNull();
    await flushWaitUntilForTest();
    const history = await chat.listThreadEvents(actor, sent.body.threadId);
    expect(history.events).toContainEqual(
      expect.objectContaining({
        id: clientEventId,
        eventType: "input.prompt",
        userMessage: {
          version: 1,
          parts: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: "Use the platform model",
            }),
          ]),
        },
      }),
    );
    expect(history.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
      }),
    );
    expect(history.events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        error: "model_provider_unavailable",
      }),
    );
    await expect(
      chat.readThreadMetadata(actor, sent.body.threadId),
    ).resolves.toMatchObject({ selectedModel: "auto" });
  });
});
