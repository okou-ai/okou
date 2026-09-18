import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
  authDeviceSupport,
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
    await api.updateOrgModelPolicies(
      actor,
      (["claude-sonnet-5", "claude-opus-4-8"] as const).map((model) => {
        return {
          model,
          isDefault: model === "claude-sonnet-5",
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        };
      }),
    );
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Saved effort",
    });
    await chat.updateThreadModelSelection(actor, thread.id, "claude-sonnet-5", {
      reasoningEffort: "high",
    });
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
      modelSettings: { "claude-sonnet-5": { effort: "extra" } },
    });
    await cancelChatRun(actor, explicit.runId, explicitClaim.sandboxHeaders);

    const override = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Use another model's native default",
      model: "claude-opus-4-8",
    });
    const overrideClaim = await claimChatRun(runnerGroup, override.runId);
    expect(overrideClaim.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "high",
    );
    // A run-level model override uses Opus's default without rewriting the
    // thread's persisted Sonnet selection or its saved effort.
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "claude-sonnet-5",
      modelSettings: { "claude-sonnet-5": { effort: "high" } },
    });
    await cancelChatRun(actor, override.runId, overrideClaim.sandboxHeaders);
  }, 90_000);

  it("merges concurrent explicit effort writes without dropping another model", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    await api.updateOrgModelPolicies(
      actor,
      (["claude-sonnet-5", "claude-opus-4-8"] as const).map((model) => {
        return {
          model,
          isDefault: model === "claude-sonnet-5",
          defaultProviderType: "anthropic-api-key" as const,
          credentialScope: "org" as const,
          modelProviderId: providerId,
        };
      }),
    );
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
          prompt: "Save Sonnet effort",
          model: "claude-sonnet-5",
          runOptions: { reasoningEffort: "extra" },
        },
        [201],
      ),
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "Save Opus effort",
          model: "claude-opus-4-8",
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
        "claude-sonnet-5": { effort: "extra" },
        "claude-opus-4-8": { effort: "low" },
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
      model: "claude-sonnet-5",
      effort: "ultracode",
      pi: false,
      providerType: "anthropic-api-key",
      effectiveEffort: "high",
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
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: pi,
      });
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
      effectiveEffort: "high",
      pi: false,
    },
  ] as const)(
    "uses current thread settings when a queued message starts with Pi $pi and $requestedEffort effort",
    async ({ requestedEffort, effectiveEffort, pi }) => {
      const { actor, agentId, providerId, runnerGroup } =
        await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: false,
      });
      const selectedModel = pi ? "gpt-5.6-sol" : "claude-opus-4-8";
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
          model: "claude-sonnet-5",
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
        {
          model: selectedModel,
          isDefault: false,
          defaultProviderType: pi ? "openai-api-key" : "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: targetProviderId,
        },
      ]);
      const active = await sendChatRun(actor, {
        agentId,
        prompt: "Active task",
      });
      const activeClaim = await claimChatRun(runnerGroup, active.runId);
      await chat.updateThreadModelSelection(
        actor,
        active.threadId,
        "claude-sonnet-5",
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
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: pi,
      });
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
          "claude-sonnet-5": { effort: "extra" },
          [selectedModel]: { effort: requestedEffort },
        },
      });
      await cancelChatRun(actor, promoted.runId, claimed.sandboxHeaders);
    },
    90_000,
  );

  it("preserves Fast when changing effort", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CodexFastMode]: true,
    });
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
      OKOU_REASONING_EFFORT: "ultra",
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
