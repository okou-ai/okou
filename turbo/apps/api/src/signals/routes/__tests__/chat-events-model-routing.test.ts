import { randomUUID } from "node:crypto";

import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signIn(actor: ApiTestUser): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId ?? null,
    actor.orgRole,
  );
}

function threads(actor: ApiTestUser) {
  signIn(actor);
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

async function selectedModel(actor: ApiTestUser, id: string) {
  signIn(actor);
  const response = await accept(
    setupApp({ context, routes: chatThreadRoutes })(
      chatThreadMetadataContract,
    ).get({ headers, params: { id } }),
    [200],
  );
  return response.body.selectedModel;
}

async function threadEvents(actor: ApiTestUser) {
  const response = await accept(
    threads(actor).events({ headers, query: {} }),
    [200],
  );
  return response.body;
}

async function setupEntitledClaudeActor(
  fixture: ReturnType<typeof createChatEventsFixture>,
) {
  const actor = fixture.bdd.user();
  fixture.chatCallbacks.acceptChatObjectStorage();
  fixture.api.acceptStorageDownloads();
  fixture.api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();
  mockClaudeCodeTokenEndpoint();
  const [runnerGroup] = await Promise.all([
    fixture.api.configureRunnerGroup(),
    fixture.api.grantProEntitlement(actor),
    fixture.api.createPersonalModelProvider(actor, {
      type: "claude-code-oauth-token",
      secret: `claude-token-${randomUUID()}`,
    }),
  ]);
  return { actor, runnerGroup };
}

describe("CHAT-02: model-first routing", () => {
  it("chat-events-model-routing-003 rejects personal model gpt-6-luna without the caller's subscription", async () => {
    const member = createBddApi(context).user({ orgRole: "org:member" });

    const rejected = await accept(
      threads(member).create({
        headers,
        body: { clientThreadId: randomUUID(), model: "gpt-6-luna" },
      }),
      [400],
    );

    expect(rejected.body).toMatchObject({
      error: { message: expect.any(String) },
    });
  });

  it("chat-events-model-routing-008 rejects the retired Fable 5 alias once the Claude subscription is deleted", async () => {
    const member = createBddApi(context).user();
    mockClaudeCodeTokenEndpoint();
    await createRunsApi(context).createPersonalModelProvider(member, {
      type: "claude-code-oauth-token",
      secret: "personal-claude-token",
    });
    const created = await accept(
      threads(member).create({
        headers,
        body: { clientThreadId: randomUUID(), model: "claude-fable-5-1" },
      }),
      [201],
    );
    const threadId = created.body.id;
    const eventsBefore = await threadEvents(member);
    signIn(member);
    await accept(
      setupApp({ context, routes: meModelProvidersDeleteRoutes })(
        personalModelProvidersByTypeContract,
      ).delete({
        headers,
        params: { type: "claude-code-oauth-token" },
      }),
      [204],
    );

    const rejected = await createChatFilesBddApi(context).requestSendEvent(
      member,
      { prompt: "Continue", threadId, model: "claude-fable-5" },
      [400],
    );
    const [eventsAfter, model] = await Promise.all([
      threadEvents(member),
      selectedModel(member, threadId),
    ]);

    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body)).toContain("Fable 5.1");
    expect(JSON.stringify(rejected.body)).toMatch(/Auto/);
    expect(JSON.stringify(rejected.body)).toMatch(/connect/i);
    expect(eventsAfter).toStrictEqual(eventsBefore);
    expect(model).toBe("claude-fable-5-1");
  });

  it(
    "chat-events-model-routing-002 queues an existing-thread input with its model until the active run releases the thread",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const { actor } = await setupEntitledClaudeActor(fixture);
      const occupied = await fixture.sendChatRun(actor, {
        prompt: "Occupy Fable thread",
        model: "claude-fable-5-1",
      });

      const queuedEventId = randomUUID();
      const [occupiedExecution, queuedSend] = await Promise.all([
        fixture.api.executionInput(occupied.runId),
        fixture.chat.requestSendEvent(
          actor,
          {
            threadId: occupied.threadId,
            prompt: "Queued personal Fable follow-up",
            model: "claude-fable-5-1",
            clientEventId: queuedEventId,
          },
          [201],
        ),
      ]);
      expect(queuedSend.status).toBe(201);
      await flushWaitUntilForTest();

      const whileOccupied = await fixture.chat.listThreadEvents(
        actor,
        occupied.threadId,
      );
      expect(whileOccupied.events).toContainEqual(
        expect.objectContaining({
          id: queuedEventId,
          eventType: "input.prompt",
        }),
      );
      expect(
        whileOccupied.events.find((event) => {
          return event.id === queuedEventId;
        })?.runId,
      ).toBeUndefined();
      expect(
        whileOccupied.events.filter((event) => {
          return event.revokesEventId === queuedEventId;
        }),
      ).toStrictEqual([]);

      await fixture.api.requestCancelRun(actor, occupied.runId, [200]);
      await fixture.failChatRun(
        occupied.runId,
        { authorization: `Bearer ${occupiedExecution.sandboxToken}` },
        "Run cancelled",
      );
      await flushWaitUntilForTest();

      const afterRelease = await fixture.chat.listThreadEvents(
        actor,
        occupied.threadId,
      );
      const promoted = afterRelease.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === queuedEventId
        );
      });
      if (!promoted?.runId) {
        throw new Error("Expected promoted replacement to carry a Run ID");
      }
      expect(promoted.runId).not.toBe(occupied.runId);

      const execution = await fixture.api.executionInput(promoted.runId);
      expect(execution.modelUsageProvider).toBe("claude-fable-5-1");
    },
  );

  it(
    "chat-events-model-routing-005 stores canonical Auto when the first send omits a model with no member preference",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const owner = fixture.bdd.user();
      if (!owner.orgId) {
        throw new Error("Expected owner orgId");
      }
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      mockClaudeCodeTokenEndpoint();
      await Promise.all([
        fixture.api.configureRunnerGroup(),
        createBddApi(context).bootstrapLimitedFreeOnboarding(owner),
        fixture.api.createPersonalModelProvider(owner, {
          type: "claude-code-oauth-token",
          secret: `claude-token-${randomUUID()}`,
        }),
      ]);

      await Promise.all([
        fixture.sendChatRun(owner, {
          prompt: "Occupy slot one",
          model: "claude-fable-5-1",
        }),
        fixture.sendChatRun(owner, {
          prompt: "Occupy slot two",
          model: "claude-fable-5-1",
        }),
      ]);

      const member = fixture.bdd.user({
        orgId: owner.orgId,
        orgRole: "org:member",
      });
      const clientThreadId = randomUUID();
      const clientEventId = randomUUID();
      signIn(member);
      const sent = await accept(
        setupApp({ context, routes: chatEventsRoutes })(
          chatEventsContract,
        ).send({
          headers,
          body: {
            clientThreadId,
            clientEventId,
            prompt: "Wait for workspace capacity",
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "Wait for workspace capacity" }],
            },
          },
        }),
        [201],
      );
      expect(sent.body.threadId).toBe(clientThreadId);
      await flushWaitUntilForTest();

      const [metadata, lifecycle, history] = await Promise.all([
        fixture.chat.readThreadMetadata(member, clientThreadId),
        fixture.chat.requestThreadEvents(member, {}, [200]),
        fixture.chat.listThreadEvents(member, clientThreadId),
      ]);

      expect(metadata.selectedModel).toBe(AUTO_SELECTED_MODEL);
      if (!("events" in lifecycle.body)) {
        throw new Error("Expected thread lifecycle events");
      }
      expect(lifecycle.body.events).toContainEqual(
        expect.objectContaining({
          kind: "created",
          chatThreadId: clientThreadId,
          selectedModel: AUTO_SELECTED_MODEL,
        }),
      );
      expect(history.events).toHaveLength(1);
      expect(history.events[0]).toMatchObject({
        id: clientEventId,
        eventType: "input.prompt",
        content: null,
        userMessage: {
          version: 1,
          parts: expect.arrayContaining([
            { type: "text", text: "Wait for workspace capacity" },
          ]),
        },
      });
      expect(history.events[0]?.runId).toBeUndefined();
    },
  );

  it(
    "chat-events-model-routing-007 rejects a disconnected thread subscription until its owner explicitly selects Auto",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const { actor } = await setupEntitledClaudeActor(fixture);
      const initial = await fixture.sendChatRun(actor, {
        prompt: "Initial Fable run",
        model: "claude-fable-5-1",
      });
      const { sandboxHeaders } = await fixture.runExecution(initial.runId);
      await fixture.completeChatRunOk(initial.runId, sandboxHeaders);

      await fixture.misc.deletePersonalModelProvider(
        actor,
        "claude-code-oauth-token",
        [204],
      );

      const continuationEventId = randomUUID();
      await fixture.chat.requestSendEvent(
        actor,
        {
          threadId: initial.threadId,
          prompt: "Continue without changing model",
          clientEventId: continuationEventId,
        },
        [201],
      );
      await flushWaitUntilForTest();

      const [historyAfterReject, metadataAfterReject] = await Promise.all([
        fixture.chat.listThreadEvents(actor, initial.threadId),
        fixture.chat.readThreadMetadata(actor, initial.threadId),
      ]);
      const rejected = historyAfterReject.events.find((event) => {
        return event.revokesEventId === continuationEventId;
      });
      expect(rejected).toMatchObject({
        eventType: "input.rejected",
        revokesEventId: continuationEventId,
        error: "conflict",
      });
      expect(rejected?.runId).toBeUndefined();
      expect(metadataAfterReject.selectedModel).toBe("claude-fable-5-1");

      await fixture.chat.updateThreadModelSelection(
        actor,
        initial.threadId,
        null,
      );

      const [metadataAfterAuto, lifecycleAfterAuto] = await Promise.all([
        fixture.chat.readThreadMetadata(actor, initial.threadId),
        fixture.chat.requestThreadEvents(actor, {}, [200]),
      ]);
      expect(metadataAfterAuto.selectedModel).toBe(AUTO_SELECTED_MODEL);
      if (!("events" in lifecycleAfterAuto.body)) {
        throw new Error("Expected thread lifecycle events after Auto");
      }
      expect(lifecycleAfterAuto.body.events).toContainEqual(
        expect.objectContaining({
          kind: "model_selection_updated",
          chatThreadId: initial.threadId,
          selectedModel: AUTO_SELECTED_MODEL,
        }),
      );
    },
  );

  it(
    "chat-events-model-routing-012 passes Fast only on a supported personal Codex route",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const actor = fixture.bdd.user();
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      mockClaudeCodeTokenEndpoint();
      await Promise.all([
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(actor),
        fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: `claude-token-${randomUUID()}`,
        }),
        fixture.connectSubscriptionPiModel(actor),
      ]);

      const fastEventId = randomUUID();
      const fastRun = await fixture.sendChatRun(actor, {
        prompt: "Run fast GPT-6 Sol",
        model: "gpt-6-sol",
        runOptions: { codexServiceTier: "fast" },
        clientEventId: fastEventId,
      });

      const [fastExecution, fastMetadata, fastHistory] = await Promise.all([
        fixture.api.executionInput(fastRun.runId),
        fixture.chat.readThreadMetadata(actor, fastRun.threadId),
        fixture.chat.listThreadEvents(actor, fastRun.threadId),
      ]);
      expect(fastExecution.cliAgentType).toBe("pi");
      expect(fastExecution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        model: "gpt-6-sol",
        serviceTier: "fast",
      });
      expect(fastMetadata).toMatchObject({
        selectedModel: "gpt-6-sol",
        serviceTier: "priority",
      });
      const fastLaunched = fastHistory.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === fastEventId
        );
      });
      if (fastLaunched?.eventType !== "input.prompt") {
        throw new Error("Expected launched fast Sol input prompt");
      }
      expect(fastLaunched.userMessage.parts).toContainEqual({
        type: "model",
        selectedModel: "gpt-6-sol",
        serviceTier: "priority",
      });

      await fixture.chat.requestUpdateThreadModelSelection(
        actor,
        fastRun.threadId,
        "claude-sonnet-5-5",
        [400],
        { codexServiceTier: "fast" },
      );
      const metadataAfterFailedSwitch = await fixture.chat.readThreadMetadata(
        actor,
        fastRun.threadId,
      );
      expect(metadataAfterFailedSwitch.serviceTier).toBe("priority");

      await fixture.chat.updateThreadModelSelection(
        actor,
        fastRun.threadId,
        "claude-sonnet-5-5",
        { codexServiceTier: null },
      );
      const lifecycleAfterClear = await fixture.chat.requestThreadEvents(
        actor,
        {},
        [200],
      );
      if (!("events" in lifecycleAfterClear.body)) {
        throw new Error("Expected thread lifecycle events after clear");
      }
      expect(lifecycleAfterClear.body.events).toContainEqual(
        expect.objectContaining({
          kind: "created",
          chatThreadId: fastRun.threadId,
          selectedModel: "gpt-6-sol",
          serviceTier: "priority",
        }),
      );
      expect(lifecycleAfterClear.body.events).toContainEqual(
        expect.objectContaining({
          kind: "model_selection_updated",
          chatThreadId: fastRun.threadId,
          selectedModel: "claude-sonnet-5-5",
        }),
      );
      expect(lifecycleAfterClear.body.events).toContainEqual(
        expect.objectContaining({
          kind: "service_tier_updated",
          chatThreadId: fastRun.threadId,
          serviceTier: null,
        }),
      );

      await fixture.api.requestCancelRun(actor, fastRun.runId, [200]);
      await fixture.failChatRun(
        fastRun.runId,
        { authorization: `Bearer ${fastExecution.sandboxToken}` },
        "Run cancelled",
      );
      await flushWaitUntilForTest();

      const standardEventId = randomUUID();
      const standardRun = await fixture.sendChatRun(actor, {
        threadId: fastRun.threadId,
        prompt: "Run standard GPT-6.1 Sol",
        model: "gpt-6.1-sol",
        clientEventId: standardEventId,
      });
      const proposedSonnetThreadId = randomUUID();
      const [
        standardExecution,
        standardMetadata,
        standardHistory,
        rejectedFresh,
      ] = await Promise.all([
        fixture.api.executionInput(standardRun.runId),
        fixture.chat.readThreadMetadata(actor, fastRun.threadId),
        fixture.chat.listThreadEvents(actor, fastRun.threadId),
        fixture.chat.requestSendEvent(
          actor,
          {
            clientThreadId: proposedSonnetThreadId,
            prompt: "Fresh fast Sonnet",
            model: "claude-sonnet-5-5",
            runOptions: { codexServiceTier: "fast" },
          },
          [400],
        ),
      ]);

      expect(standardMetadata).toMatchObject({
        selectedModel: "gpt-6.1-sol",
        serviceTier: null,
      });
      const standardLaunched = standardHistory.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === standardEventId
        );
      });
      if (standardLaunched?.eventType !== "input.prompt") {
        throw new Error("Expected launched standard Sol input prompt");
      }
      const standardModelPart = standardLaunched.userMessage.parts.find(
        (part) => {
          return part.type === "model";
        },
      );
      expect(standardModelPart).toStrictEqual({
        type: "model",
        selectedModel: "gpt-6.1-sol",
      });
      expect(standardExecution.cliAgentType).toBe("pi");
      expect(standardExecution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        model: "gpt-6.1-sol",
      });
      expect(
        standardExecution.piModelConfig &&
          "serviceTier" in standardExecution.piModelConfig
          ? standardExecution.piModelConfig.serviceTier
          : undefined,
      ).toBeUndefined();
      expect(rejectedFresh.status).toBe(400);
      await fixture.chat.requestReadThreadMetadata(
        actor,
        proposedSonnetThreadId,
        [404],
      );
    },
  );
});
