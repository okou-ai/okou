import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  cancelChatRun,
  upsertOrgModelProvider,
  mockPiCheckpointObjectStore,
} = createChatEventsFixture(context);

describe("CHAT effort: thread configuration", () => {
  it("applies requested and saved native effort through the existing claim protocol", async () => {
    const { actor, agentId, providerId, runnerGroup } =
      await entitledChatActor();
    const { providerId: openaiProviderId } = await upsertOrgModelProvider(
      actor,
      { type: "openai-api-key", secret: "native-effort-openai-key" },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-6-astra",
        isDefault: false,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: openaiProviderId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Saved effort",
    });
    await chat.updateThreadModelSelection(
      actor,
      thread.id,
      "claude-fable-5-1",
      {
        reasoningEffort: "high",
      },
    );
    const saved = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Use saved effort",
    });
    const savedClaim = await claimChatRun(runnerGroup, saved.runId);
    expect(savedClaim.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "high",
    );
    await cancelChatRun(actor, saved.runId, savedClaim.sandboxHeaders);

    const explicit = await sendChatRun(actor, {
      agentId,
      prompt: "New explicit effort",
      runOptions: { reasoningEffort: "extra" },
    });
    const explicitClaim = await claimChatRun(runnerGroup, explicit.runId);
    // Storage and dispatch retain the user's Claude name. The guest maps it.
    expect(explicitClaim.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "extra",
    );
    await expect(
      chat.readThreadMetadata(actor, explicit.threadId),
    ).resolves.toMatchObject({
      modelSettings: { "claude-fable-5-1": { effort: "extra" } },
    });
    await cancelChatRun(actor, explicit.runId, explicitClaim.sandboxHeaders);

    const override = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Use another model's native default",
      model: "gpt-6-astra",
    });
    const overrideClaim = await claimChatRun(runnerGroup, override.runId);
    expect(overrideClaim.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "max",
    );
    // A run-level model override uses Astra's default without rewriting the
    // thread's persisted Fable selection or its saved effort.
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "claude-fable-5-1",
      modelSettings: { "claude-fable-5-1": { effort: "high" } },
    });
    await cancelChatRun(actor, override.runId, overrideClaim.sandboxHeaders);
  }, 90_000);

  it("merges concurrent explicit effort writes without dropping another model", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    const { providerId: openaiProviderId } = await upsertOrgModelProvider(
      actor,
      { type: "openai-api-key", secret: "concurrent-effort-openai-key" },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-6-astra",
        isDefault: false,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: openaiProviderId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Concurrent effort patches",
    });
    const threadLock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });

    const requests = [
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "Save Fable effort",
          model: "claude-fable-5-1",
          runOptions: { reasoningEffort: "extra" },
        },
        [201],
      ),
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "Save Astra effort",
          model: "gpt-6-astra",
          runOptions: { reasoningEffort: "low" },
        },
        [201],
      ),
    ] as const;
    await expect.poll(threadLock.blockedWaiterCount).toBeGreaterThanOrEqual(2);
    threadLock.release();
    await threadLock.done;
    const responses = await Promise.all(requests);

    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      modelSettings: {
        "claude-fable-5-1": { effort: "extra" },
        "gpt-6-astra": { effort: "low" },
      },
    });
    for (const response of responses) {
      if (response.status !== 201) {
        throw new Error("Expected both effort updates to be accepted");
      }
      if (response.body.runId) {
        await cancelChatRun(actor, response.body.runId);
      }
    }
  }, 90_000);

  it.each([
    {
      model: "gpt-5.6-sol",
      effort: "ultra",
      pi: true,
      providerType: "openai-api-key",
      effectiveEffort: "max",
    },
    {
      model: "deepseek-v4-flash",
      effort: "low",
      pi: true,
      providerType: "openrouter-codex",
      effectiveEffort: "high",
    },
    {
      model: "deepseek-v4-pro",
      effort: "max",
      pi: true,
      providerType: "openrouter-codex",
      effectiveEffort: "high",
    },
    {
      model: "claude-fable-5-1",
      effort: "ultracode",
      pi: false,
      providerType: "anthropic-api-key",
      effectiveEffort: "max",
    },
  ] as const)(
    "falls back from unavailable $model $effort without deleting the preference",
    async ({ model, effort, pi, providerType, effectiveEffort }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: providerType,
        secret: "test-native-effort-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: providerType,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      if (pi) {
        mockPiCheckpointObjectStore();
      }
      const thread = await chat.createThread(actor, {
        agentId,
        title: "Unsupported effort route",
        model,
      });
      for (const saved of [false, true]) {
        if (saved) {
          await chat.updateThreadModelSelection(actor, thread.id, model, {
            reasoningEffort: effort,
          });
        }
        const sent = await sendChatRun(actor, {
          agentId,
          threadId: thread.id,
          prompt: pi
            ? "/unknown-command use the route fallback"
            : "Use the route fallback",
          ...(saved ? {} : { runOptions: { reasoningEffort: effort } }),
        });
        if (pi) {
          await flushWaitUntilForTest();
        }
        const claimed = await claimChatRun(runnerGroup, sent.runId);
        expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
          effectiveEffort,
        );
        if (pi) {
          expect(claimed.claim.piModelConfig).toMatchObject({
            thinkingLevel: effectiveEffort,
          });
        }
        await expect(
          chat.readThreadMetadata(actor, thread.id),
        ).resolves.toMatchObject({
          modelSettings: { [model]: { effort } },
        });
        await cancelChatRun(actor, sent.runId, claimed.sandboxHeaders);
      }
    },
    90_000,
  );

  it.each([
    {
      requestedEffort: "high",
      effectiveEffort: "high",
      pi: false,
    },
    {
      requestedEffort: "high",
      effectiveEffort: "high",
      pi: true,
    },
    {
      requestedEffort: "ultra",
      effectiveEffort: "max",
      pi: true,
    },
    {
      requestedEffort: "ultracode",
      effectiveEffort: "max",
      pi: false,
    },
  ] as const)(
    "uses current thread settings when a queued message starts with Pi $pi and $requestedEffort effort",
    async ({ requestedEffort, effectiveEffort, pi }) => {
      const { actor, agentId, providerId, runnerGroup } =
        await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();

      const selectedModel = pi ? "gpt-5.6-sol" : "claude-fable-5-1";
      const targetProviderId = pi
        ? (
            await upsertOrgModelProvider(actor, {
              type: "openai-api-key",
              secret: "queued-pi-effort-key",
            })
          ).providerId
        : providerId;
      await api.updateOrgModelPolicies(actor, [
        {
          model: "claude-fable-5-1",
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
        ...(pi
          ? [
              {
                model: selectedModel,
                isDefault: false,
                defaultProviderType: "openai-api-key" as const,
                credentialScope: "org" as const,
                modelProviderId: targetProviderId,
              },
            ]
          : []),
      ]);
      const active = await sendChatRun(actor, {
        agentId,
        prompt: "Active task",
      });
      const activeClaim = await claimChatRun(runnerGroup, active.runId);
      await chat.updateThreadModelSelection(
        actor,
        active.threadId,
        "claude-fable-5-1",
        { reasoningEffort: "extra" },
      );
      const clientEventId = randomUUID();
      const prompt = pi
        ? "/unknown-command read the current thread settings at launch"
        : "Read the current thread settings at launch";
      const queued = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: active.threadId,
          prompt,
          clientEventId,
        },
        [201],
      );
      expect(queued.body).toMatchObject({ runId: null });
      await chat.updateThreadModelSelection(
        actor,
        active.threadId,
        selectedModel,
        { reasoningEffort: requestedEffort },
      );
      const retry = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: active.threadId,
          prompt,
          clientEventId,
          runOptions: { reasoningEffort: requestedEffort },
        },
        [201],
      );
      expect(retry.body).toStrictEqual(queued.body);
      if (pi) {
        mockPiCheckpointObjectStore();
      }
      await cancelChatRun(actor, active.runId, activeClaim.sandboxHeaders);
      const messages = await waitForThreadMessages(
        actor,
        active.threadId,
        (items) => {
          return userMessages(items).some((message) => {
            return (
              message.revokesEventId === clientEventId &&
              typeof message.runId === "string"
            );
          });
        },
      );
      const promoted = userMessages(messages.events).find((message) => {
        return message.revokesEventId === clientEventId;
      });
      if (!promoted?.runId || promoted.eventType !== "input.prompt") {
        throw new Error("Expected queued input to launch");
      }
      expect(promoted.userMessage.parts).toContainEqual({
        type: "model",
        selectedModel,
      });
      if (pi) {
        await flushWaitUntilForTest();
      }
      const claimed = await claimChatRun(runnerGroup, promoted.runId);
      if (pi) {
        expect(claimed.claim.piModelConfig).toMatchObject({
          thinkingLevel: effectiveEffort,
        });
      }
      expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        effectiveEffort,
      );
      await expect(
        chat.readThreadMetadata(actor, active.threadId),
      ).resolves.toMatchObject({
        selectedModel,
        modelSettings: {
          "claude-fable-5-1": { effort: "extra" },
          [selectedModel]: { effort: requestedEffort },
        },
      });
      await cancelChatRun(actor, promoted.runId, claimed.sandboxHeaders);
    },
    90_000,
  );

  it("preserves Fast when changing effort", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "openai-api-key",
      secret: "test-effort-openai-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-sol",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Independent Fast",
      model: "gpt-5.6-sol",
    });
    await chat.updateThreadModelSelection(actor, thread.id, "gpt-5.6-sol", {
      reasoningEffort: "low",
      codexServiceTier: "fast",
    });
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      serviceTier: "priority",
    });
    const sent = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Fast with saved effort",
    });
    const claimed = await claimChatRun(runnerGroup, sent.runId);
    expect(claimed.claim.platformEnvironment.OKOU_CODEX_SERVICE_TIER).toBe(
      "fast",
    );
    expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe("low");
    await cancelChatRun(actor, sent.runId, claimed.sandboxHeaders);
    const explicit = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Change effort and retain Fast",
      runOptions: { reasoningEffort: "ultra" },
    });
    const explicitClaim = await claimChatRun(runnerGroup, explicit.runId);
    expect(explicitClaim.claim.platformEnvironment).toMatchObject({
      OKOU_CODEX_SERVICE_TIER: "fast",
      OKOU_REASONING_EFFORT: "max",
    });
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      modelSettings: { "gpt-5.6-sol": { effort: "ultra" } },
      serviceTier: "priority",
    });
    await cancelChatRun(actor, explicit.runId, explicitClaim.sandboxHeaders);
  }, 90_000);
});
