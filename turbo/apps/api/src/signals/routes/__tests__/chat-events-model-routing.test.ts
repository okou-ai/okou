import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";

import {
  createChatEventsFixture,
  CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
  type PromptMessage,
  claimEnvironment,
  userMessages,
} from "./helpers/chat-events-fixture";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  misc,
  entitledChatActor,

  seedBuiltInModelKey,
  configureBuiltInPiModel,
  configureBuiltInPiModelOnOpenRouter,
  configureSubscriptionPiModel,
  sendChatRun,
  requestSendEventRaw,
  expectThreadCreatedModelEvent,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  cancelChatRun,

  readThreadProjection,
  mockPiCheckpointObjectStore,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${base64UrlEncode(JSON.stringify(payload))}.bdd-signature`;
}

function codexAuthJson(): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: unsignedJwt({ exp: accessExp }),
      refresh_token: "rt_bdd_chat_fast_mode",
      account_id: "ws_acct_bdd_fast_mode",
      id_token: unsignedJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "ws_acct_bdd_fast_mode_id_token",
          chatgpt_plan_type: "plus",
          organization: { title: "BDD Chat Fast Mode" },
        },
        exp: accessExp,
      }),
    },
  });
}

// Keep Pi's sandbox launch resource handoff deterministic for tests that
// inspect the frozen Sandbox claim.
async function preparePiResourceHandoff(
  actor: ApiTestUser,
  agentId: string,
): Promise<void> {
  await publishPendingPiInstructions(actor, agentId);
  mockPiResourceArchiveDownloads(true);
  mockPiCheckpointObjectStore();
}

/**
 * Wait for the background pick to consume a sent input: its replacement is
 * the launched `input.prompt` carrying the run, or its `input.rejected`.
 */
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

describe("CHAT-02: model-first routing", () => {
  it("adds Codex image upload guidance for web chat Codex sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const prompt =
      "generate an image in web chat using the aurora-21210 color palette";

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson() },
      },
      [200, 201],
    );
    await api.updateUserModelPreference(actor, "gpt-6-astra");

    const run = await sendChatRun(actor, {
      agentId,
      prompt,
      model: "gpt-6-astra",
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    expect(claim.cliAgentType).toBe("codex");
    expect(appendSystemPrompt).toContain(
      "You are currently running inside: Web",
    );
    expect(appendSystemPrompt).toContain("okou web upload-file -h");
    expect(appendSystemPrompt).toContain("okou mail link <gmail-draft-id>");
    expect(appendSystemPrompt).toContain(
      "GET /gmail/v1/users/me/settings/sendAs",
    );
    expect(appendSystemPrompt).toContain(
      "Include a `multipart/alternative` body",
    );
    expect(appendSystemPrompt).toContain(
      "Keep each plain-text paragraph on one logical line",
    );
    expect(appendSystemPrompt).toContain(
      "use HTML paragraph elements so Gmail wraps the message naturally",
    );
    expect(appendSystemPrompt).toContain("append that signature exactly once");
    expect(appendSystemPrompt).toContain(
      "return the link from the command to the user",
    );
    expect(appendSystemPrompt).toContain("Do not add a mail callback prompt");
    expect(appendSystemPrompt).toContain(
      "confirm the send against Gmail before reporting it",
    );
    expect(appendSystemPrompt).toContain(
      "`okou workflow automation list <workflow>` shows one workflow's triggers",
    );
    expect(appendSystemPrompt).toContain(
      "Never send a reply automatically; the user always sends",
    );
    expect(appendSystemPrompt).toContain(CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET);
    expect(appendSystemPrompt).not.toContain("When running in Codex");
    let previousSectionIndex = -1;
    for (const section of [
      "# Agent Identity",
      "# Execution Time Limit",
      "# Agent Tools",
      "# Current User Info",
      "# Current Integration",
      CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
    ]) {
      const sectionIndex = appendSystemPrompt.indexOf(section);
      expect(sectionIndex).toBeGreaterThan(previousSectionIndex);
      previousSectionIndex = sectionIndex;
    }
    await cancelChatRun(actor, run.runId);
  });

  it("queues an existing-thread input with its model until the active run releases the thread", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    // Keep the thread busy so the follow-up stays queued after model selection.
    const active = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "keep the thread busy",
    });

    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "enqueue with the thread model",
        clientEventId,
      },
      [201],
    );
    expect(sent).toMatchObject({ status: 201, body: { runId: null } });
    await flushWaitUntilForTest();
    expect(
      (await chat.listThreadEvents(actor, thread.id)).events,
    ).toContainEqual(
      expect.objectContaining({ id: clientEventId, eventType: "input.prompt" }),
    );
    expect(
      (await chat.listThreadEvents(actor, thread.id)).events,
    ).not.toContainEqual(
      expect.objectContaining({ revokesEventId: clientEventId }),
    );

    await cancelChatRun(actor, active.runId);
    const { picked } = await waitForPickedInput(
      actor,
      thread.id,
      clientEventId,
    );
    if (picked.runId === undefined) {
      throw new Error("Expected the follow-up to launch after the cancel");
    }
    const { claim } = await claimChatRun(runnerGroup, picked.runId);
    expect(claim.modelUsageProvider).toBe("claude-fable-5-1");
    await cancelChatRun(actor, picked.runId);
  }, 90_000);

  it("rejects personal model gpt-6-luna without the caller's subscription", async () => {
    const { actor, agentId } = await entitledChatActor();
    const response = await chat.requestCreateThread(
      actor,
      { agentId, model: "gpt-6-luna" },
      [400],
    );
    expect(response.status).toBe(400);
    expectApiError(response.body);
  });

  it("rejects the internal Auto run model as a send selection", async () => {
    const { actor, agentId } = await entitledChatActor();
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    for (const threadId of [undefined, thread.id]) {
      const response = await chat.requestSendEvent(
        actor,
        {
          agentId,
          ...(threadId === undefined ? {} : { threadId }),
          prompt: "select Auto by its run model id",
          model: "okou-1.0",
          clientEventId: randomUUID(),
        },
        [400],
      );
      expectApiError(response.body);
      expect(response.body.error.message).toBe('Unknown model "okou-1.0"');
    }
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({ selectedModel: "claude-fable-5-1" });
  });

  it("stores canonical Auto on a new thread and captures its runtime billing model", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    // Clears the member preference, so Auto is the default.
    await configureBuiltInPiModel(actor);
    await preparePiResourceHandoff(actor, agentId);
    const clientThreadId = randomUUID();
    const clientEventId = randomUUID();
    const prompt = "start a thread without naming a model";
    const sent = await requestSendEventRaw(actor, {
      agentId,
      clientThreadId,
      clientEventId,
      prompt,
      userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
      hasTextContent: true,
    });
    expect(sent).toMatchObject({
      status: 201,
      body: { threadId: clientThreadId },
    });
    await expect(
      chat.readThreadMetadata(actor, clientThreadId),
    ).resolves.toMatchObject({ selectedModel: "auto" });
    await expectThreadCreatedModelEvent(actor, clientThreadId, "auto");

    const { picked } = await waitForPickedInput(
      actor,
      clientThreadId,
      clientEventId,
    );
    expect(picked).toMatchObject({
      eventType: "input.prompt",
      userMessage: {
        parts: expect.arrayContaining([
          expect.objectContaining({ type: "model", selectedModel: "auto" }),
        ]),
      },
    });
    if (picked.runId === undefined) {
      throw new Error("Expected the Auto input to launch a run");
    }
    const { claim } = await claimChatRun(runnerGroup, picked.runId);
    expect(claim.modelUsageProvider).toBe("@preset/okou-1-0");
    const captured = await createRunReadsApi(context).requestReadLogById(
      actor,
      picked.runId,
      [200],
    );
    expect(captured.body).toMatchObject({
      selectedModel: "auto",
      modelRuntimeProvider: "openrouter-codex",
      modelRuntimeModel: claim.modelUsageProvider,
    });
    await expect(
      chat.readThreadMetadata(actor, clientThreadId),
    ).resolves.toMatchObject({ selectedModel: "auto" });
    await cancelChatRun(actor, picked.runId);
  }, 90_000);

  it("switches a subscription-pinned thread to Auto when a send selects null", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await seedBuiltInModelKey(SEEDED_SYSTEM_DEFAULT_MODEL);
    await preparePiResourceHandoff(actor, agentId);
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });

    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "continue this thread on Auto",
      model: null,
    });
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({ selectedModel: "auto" });
    await expect(
      chat.requestThreadEvents(actor, {}, [200]),
    ).resolves.toMatchObject({
      body: {
        events: expect.arrayContaining([
          expect.objectContaining({
            kind: "model_selection_updated",
            chatThreadId: thread.id,
            selectedModel: "auto",
          }),
        ]),
      },
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    expect(claim.modelUsageProvider).toBe("@preset/okou-1-0");
    await cancelChatRun(actor, run.runId);
  }, 90_000);

  it("rejects a disconnected thread subscription until its owner explicitly selects Auto", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start before the thread model is removed",
      model: "claude-fable-5-1",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.cliAgentType).toBe("claude-code");
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-fable-5-1",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    await seedBuiltInModelKey(SEEDED_SYSTEM_DEFAULT_MODEL);
    await misc.deletePersonalModelProvider(
      actor,
      "claude-code-oauth-token",
      [204],
    );
    // The member preference does not replace an unavailable thread model.
    await api.updateUserModelPreference(actor, null);
    await preparePiResourceHandoff(actor, agentId);

    const clientEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "continue through my disconnected subscription",
        clientEventId,
      },
      [201],
    );
    const { picked } = await waitForPickedInput(
      actor,
      first.threadId,
      clientEventId,
    );
    expect(picked).toMatchObject({
      eventType: "input.rejected",
      error: "conflict",
    });
    expect(picked.runId).toBeUndefined();
    await expect(
      chat.readThreadMetadata(actor, first.threadId),
    ).resolves.toMatchObject({
      selectedModel: "claude-fable-5-1",
    });
    await chat.updateThreadModelSelection(actor, first.threadId, null);
    const fallback = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue after explicitly selecting Auto",
    });
    const fallbackClaim = await claimChatRun(runnerGroup, fallback.runId);
    expect(fallbackClaim.claim.modelUsageProvider).toBe("@preset/okou-1-0");
    await expect(
      chat.readThreadMetadata(actor, first.threadId),
    ).resolves.toMatchObject({
      selectedModel: "auto",
    });
    await cancelChatRun(actor, fallback.runId, fallbackClaim.sandboxHeaders);
  }, 90_000);

  it("rejects a requested retired Claude alias once its subscription account is deleted", async () => {
    const { actor, agentId } = await entitledChatActor();
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    await misc.deletePersonalModelProvider(
      actor,
      "claude-code-oauth-token",
      [204],
    );
    const before = await chat.listThreadEvents(actor, thread.id);

    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "continue through my deleted subscription",
        model: "claude-fable-5",
        clientEventId: randomUUID(),
      },
      [400],
    );

    expect(sent.body).toMatchObject({
      error: {
        message:
          "Claude Fable 5 was replaced by Claude Fable 5.1, which requires a Claude subscription. Select Auto or connect your Claude subscription.",
      },
    });
    await flushWaitUntilForTest();
    expect(
      (await chat.listThreadEvents(actor, thread.id)).events,
    ).toStrictEqual(before.events);
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({ selectedModel: "claude-fable-5-1" });
  }, 90_000);

  it("keeps the enqueued model after thread and member defaults change", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey("okou-1.0");
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the historical thread model",
      model: "claude-fable-5-1",
    });
    const queuedEventId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "continue using the model captured before defaults change",
        clientEventId: queuedEventId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the legacy-thread follow-up to queue");
    }
    expect(queued.body.runId).toBeNull();

    const historicalMessages = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    expect(userMessages(historicalMessages.events)).toContainEqual(
      expect.objectContaining({ runId: first.runId }),
    );

    await api.updateUserModelPreference(actor, null);
    await chat.updateThreadModelSelection(actor, first.threadId, null);
    expect(
      (await chat.readThreadMetadata(actor, first.threadId)).selectedModel,
    ).toBe("auto");

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const promotedMessages = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesEventId === queuedEventId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promotedRunId = userMessages(promotedMessages.events).find(
      (message) => {
        return message.revokesEventId === queuedEventId;
      },
    )?.runId;
    if (!promotedRunId) {
      throw new Error("Expected the queued legacy-thread message to run");
    }

    const promotedClaim = await claimChatRun(runnerGroup, promotedRunId);
    expect(promotedClaim.claim.cliAgentType).toBe("claude-code");
    expect(claimEnvironment(promotedClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-fable-5-1",
    );
    expect(
      (await chat.readThreadMetadata(actor, first.threadId)).selectedModel,
    ).toBe("auto");

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    // Only the explicit Auto selection updated the thread; the promoted pick
    // did not write its captured model back.
    expect(
      threadEvents.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === first.threadId &&
          event.selectedModel !== "claude-fable-5-1"
        );
      }),
    ).toStrictEqual([expect.objectContaining({ selectedModel: "auto" })]);

    await cancelChatRun(actor, promotedRunId, promotedClaim.sandboxHeaders);
  }, 90_000);

  it("does not overwrite a concurrent explicit thread model selection", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey("okou-1.0");
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    await api.updateUserModelPreference(actor, null);

    const racedEventId = randomUUID();
    const [sent, updated] = await Promise.all([
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "send while choosing a new sticky model",
          clientEventId: racedEventId,
        },
        [201],
      ),
      chat.requestUpdateThreadModelSelection(
        actor,
        thread.id,
        "claude-fable-5-1",
        [204],
      ),
    ]);
    expect(updated.status).toBe(204);
    expect(sent.status).toBe(201);
    const { picked: racedInput } = await waitForPickedInput(
      actor,
      thread.id,
      racedEventId,
    );
    const racedRunId = racedInput.runId;
    if (racedRunId === undefined) {
      throw new Error("Expected the concurrent send to create a run");
    }
    const racedClaim = await claimChatRun(runnerGroup, racedRunId);
    expect(["okou-1.0", "claude-fable-5-1"]).toContain(
      racedClaim.claim.modelUsageProvider,
    );
    await cancelChatRun(actor, racedRunId, racedClaim.sandboxHeaders);

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "continue on the explicit sticky model",
    });
    const followUpClaim = await claimChatRun(runnerGroup, followUp.runId);
    expect(claimEnvironment(followUpClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-fable-5-1",
    );

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      events.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === thread.id &&
          event.selectedModel === "claude-fable-5-1"
        );
      }),
    ).toHaveLength(1);
    expect(
      events.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === thread.id &&
          event.selectedModel === null
        );
      }).length,
    ).toBeLessThanOrEqual(1);
    await cancelChatRun(actor, followUp.runId);
  }, 90_000);

  it("passes Fast only on a supported personal Codex route", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-sonnet-5-5",
    });
    await configureSubscriptionPiModel(actor, {}, "gpt-6-sol");

    await preparePiResourceHandoff(actor, agentId);
    const fast = await sendChatRun(actor, {
      agentId,
      prompt: "run codex fast",
      model: "gpt-6-sol",
      runOptions: { codexServiceTier: "fast" },
    });
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );
    const fastMessages = await waitForThreadMessages(
      actor,
      fast.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return event.runId === fast.runId;
        });
      },
    );
    const fastUserMessage = userMessages(fastMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.runId === fast.runId;
      },
    )?.userMessage;
    expect(
      fastUserMessage?.parts.find((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual({
      type: "model",
      selectedModel: "gpt-6-sol",
      serviceTier: "priority",
    });
    const fastClaim = await claimChatRun(runnerGroup, fast.runId);
    expect(fastClaim.claim.cliAgentType).toBe("pi");
    expect(fastClaim.claim.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6-sol",
      serviceTier: "fast",
    });
    await cancelChatRun(actor, fast.runId, fastClaim.sandboxHeaders);
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    const invalidFastPatch = await chat.requestUpdateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5-5",
      [400],
      { codexServiceTier: "fast" },
    );
    expectApiError(invalidFastPatch.body);
    expect(invalidFastPatch.body.error.message).toBe(
      "Fast mode is unavailable for this model route",
    );
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    await chat.updateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5-5",
      {
        codexServiceTier: null,
      },
    );
    expect(
      (await readThreadProjection(actor, fast.threadId)).serviceTier,
    ).toBeNull();
    const updatedFastThreadEvents = await chat.requestThreadEvents(
      actor,
      {},
      [200],
    );
    expect(updatedFastThreadEvents.status).toBe(200);
    if (updatedFastThreadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: fast.threadId,
        selectedModel: "claude-sonnet-5-5",
      }),
    );
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: fast.threadId,
        serviceTier: "priority",
      }),
    );
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "service_tier_updated",
        chatThreadId: fast.threadId,
        serviceTier: null,
      }),
    );

    const standard = await sendChatRun(actor, {
      agentId,
      threadId: fast.threadId,
      prompt: "run codex standard",
      model: "gpt-6.1-sol",
    });
    expect(
      (await readThreadProjection(actor, standard.threadId)).serviceTier,
    ).toBeNull();
    const standardMessages = await waitForThreadMessages(
      actor,
      standard.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return event.runId === standard.runId;
        });
      },
    );
    const standardUserMessage = userMessages(standardMessages.events).find(
      (event): event is PromptMessage => {
        return (
          event.eventType === "input.prompt" && event.runId === standard.runId
        );
      },
    )?.userMessage;
    expect(
      standardUserMessage?.parts.find((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual({
      type: "model",
      selectedModel: "gpt-6.1-sol",
    });
    const { claim: standardClaim } = await claimChatRun(
      runnerGroup,
      standard.runId,
    );
    expect(standardClaim.cliAgentType).toBe("pi");
    expect(standardClaim.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6.1-sol",
    });
    expect(standardClaim.piModelConfig).not.toHaveProperty("serviceTier");
    await cancelChatRun(actor, standard.runId);

    const rejectedThreadId = randomUUID();
    const rejected = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "Claude cannot use Codex fast mode",
        clientThreadId: rejectedThreadId,
        model: "claude-sonnet-5-5",
        runOptions: { codexServiceTier: "fast" },
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe(
      "Codex fast mode is only available for GPT 5.6 runs",
    );
    await chat.requestReadThread(actor, rejectedThreadId, [404]);
  }, 90_000);

  it("routes built-in okou-1.0 through global OpenRouter and resolves its firewall credential", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const model = await configureBuiltInPiModelOnOpenRouter(actor, "okou-1.0");
    await preparePiResourceHandoff(actor, agentId);
    const run = await sendChatRun(actor, {
      agentId,
      model,
      prompt: "capture the managed okou-1.0 route",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.cliAgentType).toBe("pi");
    expect(claim.piModelConfig).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "@preset/okou-1-0",
    });
    expect(claim.billableFirewalls).toContain(
      "model-provider:openrouter-codex",
    );
    if (!claim.encryptedSecrets) {
      throw new Error("Missing managed credential bundle");
    }
    const auth = await createFirewallApi(context).requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    expect(auth.body).toMatchObject({
      resolvedSecrets: ["OPENROUTER_API_KEY"],
    });
    await cancelChatRun(actor, run.runId);
  }, 90_000);
});
