import {
  NATIVE_CLAUDE_OPUS_5_5_HEADER,
  NATIVE_GPT_6_LUNA_HEADER,
  NATIVE_GPT_6_SOL_HEADER,
} from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { stagePreAddabilityModelPolicyFixture } from "../../../test-fixtures/org-model-policies";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { seedBuiltInModelKey } from "./helpers/runtime-state";

const context = testContext();
const { api, chat, entitledChatActor } = createChatEventsFixture(context);

describe("native model claim compatibility", () => {
  it.each([
    ["gpt-6-sol", "built-in", NATIVE_GPT_6_SOL_HEADER],
    ["gpt-6-sol", "openai-api-key", NATIVE_GPT_6_SOL_HEADER],
    ["gpt-6-sol", "openrouter-codex", NATIVE_GPT_6_SOL_HEADER],
    ["gpt-6-luna", "built-in", NATIVE_GPT_6_LUNA_HEADER],
    ["gpt-6-luna", "openai-api-key", NATIVE_GPT_6_LUNA_HEADER],
    ["gpt-6-luna", "openrouter-codex", NATIVE_GPT_6_LUNA_HEADER],
  ] as const)(
    "keeps %s work on %s pending until a capable Runner claims it",
    async (model, providerType, capabilityHeader) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      if (!actor.orgId) {
        throw new Error("Expected an org-scoped chat actor");
      }
      const runtimeModel =
        providerType === "openrouter-codex" ? `openai/${model}` : model;
      let providerId: string | null = null;
      if (providerType === "built-in") {
        // Platform model keys are operator configuration with no user write API.
        await seedBuiltInModelKey(context, model);
      } else {
        const provider = await api.createOrgModelProvider(actor, {
          type: providerType,
          secret: "test-native-model-key",
          selectedModel: runtimeModel,
        });
        providerId = provider.providerId;
      }
      await stagePreAddabilityModelPolicyFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        model,
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
      const sent = await chat.requestSendEvent(
        actor,
        {
          agentId,
          model,
          prompt: `Run ${model} with the native model default`,
        },
        [201],
      );
      if (sent.status !== 201 || sent.body.runId === null) {
        throw new Error("Expected a queued native chat run");
      }
      const runId = sent.body.runId;
      await api.heartbeatRunner(runnerGroup);

      const oldPoll = await api.pollRunner(runnerGroup);
      expect(oldPoll.body.job).toBeNull();
      const capablePoll = await api.pollRunner(runnerGroup, {
        [capabilityHeader]: "1",
      });
      expect(capablePoll.body.job?.runId).toBe(runId);

      await api.requestClaimRunnerJob(true, runId, [404]);
      await expect(api.readRun(actor, runId)).resolves.toMatchObject({
        status: "pending",
      });
      await api.requestClaimRunnerJob(
        true,
        runId,
        [404],
        {},
        {
          [capabilityHeader]: "0",
        },
      );
      await expect(api.readRun(actor, runId)).resolves.toMatchObject({
        status: "pending",
      });

      if (model === "gpt-6-luna") {
        // A Sol-capable Runner still cannot execute newly added Luna work.
        const solOnlyPoll = await api.pollRunner(runnerGroup, {
          [NATIVE_GPT_6_SOL_HEADER]: "1",
        });
        expect(solOnlyPoll.body.job).toBeNull();
        await api.requestClaimRunnerJob(
          true,
          runId,
          [404],
          {},
          { [NATIVE_GPT_6_SOL_HEADER]: "1" },
        );
      }
      const claim = await api.claimRunnerJob(
        runId,
        {},
        {
          [capabilityHeader]: "1",
        },
      );
      expect(claim.cliAgentType).toBe("codex");
      expect(claim.environment).toMatchObject({ OPENAI_MODEL: runtimeModel });
      expect(claim.platformEnvironment).toMatchObject({
        OKOU_REASONING_EFFORT: "max",
      });
      await api.requestCancelRun(actor, runId, [200]);
    },
  );

  it.each([
    ["gpt-6-sol", NATIVE_GPT_6_SOL_HEADER],
    ["gpt-6-luna", NATIVE_GPT_6_LUNA_HEADER],
  ] as const)(
    "lets an older Runner poll work behind %s",
    async (newModel, capabilityHeader) => {
      const newModelFixture = await entitledChatActor();
      const astra = await entitledChatActor();
      // Both sends use the same configured Runner group, with separate orgs so
      // each run has an independent concurrency entitlement.
      const runnerGroup = astra.runnerGroup;
      const runIds: string[] = [];
      for (const [fixture, model] of [
        [newModelFixture, newModel],
        [astra, "gpt-6-astra"],
      ] as const) {
        const { actor, agentId } = fixture;
        if (!actor.orgId) {
          throw new Error("Expected an org-scoped chat actor");
        }
        const { providerId } = await api.createOrgModelProvider(actor, {
          type: "openai-api-key",
          secret: "test-native-model-key",
          selectedModel: model,
        });
        if (model === newModel) {
          await stagePreAddabilityModelPolicyFixture({
            orgId: actor.orgId,
            userId: actor.userId,
            model,
          });
        }
        await api.updateOrgModelPolicies(actor, [
          {
            model,
            isDefault: true,
            defaultProviderType: "openai-api-key",
            credentialScope: "org",
            modelProviderId: providerId,
          },
        ]);
        const sent = await chat.requestSendEvent(
          actor,
          { agentId, model, prompt: `Run ${model} through the shared queue` },
          [201],
        );
        if (sent.status !== 201 || sent.body.runId === null) {
          throw new Error("Expected a queued native chat run");
        }
        runIds.push(sent.body.runId);
      }
      const [newModelRunId, astraRunId] = runIds;
      if (!newModelRunId || !astraRunId) {
        throw new Error("Expected both native runs");
      }
      await api.heartbeatRunner(runnerGroup);
      const capablePoll = await api.pollRunner(runnerGroup, {
        [capabilityHeader]: "1",
      });
      expect(capablePoll.body.job?.runId).toBe(newModelRunId);
      const olderHeaders = [
        undefined,
        { [capabilityHeader]: "0" },
        ...(newModel === "gpt-6-luna"
          ? [{ [NATIVE_GPT_6_SOL_HEADER]: "1" }]
          : []),
      ];
      for (const headers of olderHeaders) {
        const oldPoll = await api.pollRunner(runnerGroup, headers);
        expect(oldPoll.body.job?.runId).toBe(astraRunId);
      }
      const claim = await api.claimRunnerJob(astraRunId);
      expect(claim.cliAgentType).toBe("codex");
      expect(claim.environment).toMatchObject({ OPENAI_MODEL: "gpt-6-astra" });
      await expect(
        api.readRun(newModelFixture.actor, newModelRunId),
      ).resolves.toMatchObject({
        status: "pending",
      });
      await api.requestCancelRun(astra.actor, astraRunId, [200]);
      await api.requestCancelRun(newModelFixture.actor, newModelRunId, [200]);
    },
  );
  it.each(["built-in", "anthropic-api-key", "openrouter-api-key"] as const)(
    "keeps %s Claude Opus 5.5 work pending until a capable Runner claims it",
    async (providerType) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      if (!actor.orgId) {
        throw new Error("Expected an org-scoped chat actor");
      }
      const model = "claude-opus-5-5";
      const runtimeModel =
        providerType === "openrouter-api-key"
          ? "anthropic/claude-opus-5.5"
          : model;
      let providerId: string | null = null;
      if (providerType === "built-in") {
        await seedBuiltInModelKey(context, model);
      } else {
        const provider = await api.createOrgModelProvider(actor, {
          type: providerType,
          secret: "test-native-model-key",
          selectedModel: runtimeModel,
        });
        providerId = provider.providerId;
      }
      await stagePreAddabilityModelPolicyFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        model,
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
      const sent = await chat.requestSendEvent(
        actor,
        { agentId, model, prompt: "Run Claude Opus 5.5" },
        [201],
      );
      if (sent.status !== 201 || sent.body.runId === null) {
        throw new Error("Expected a queued Claude Opus 5.5 chat run");
      }
      const runId = sent.body.runId;
      await api.heartbeatRunner(runnerGroup);

      const oldPoll = await api.pollRunner(runnerGroup);
      expect(oldPoll.body.job).toBeNull();
      const capablePoll = await api.pollRunner(runnerGroup, {
        [NATIVE_CLAUDE_OPUS_5_5_HEADER]: "1",
      });
      expect(capablePoll.body.job?.runId).toBe(runId);

      await api.requestClaimRunnerJob(true, runId, [404]);
      await expect(api.readRun(actor, runId)).resolves.toMatchObject({
        status: "pending",
      });
      await api.requestClaimRunnerJob(
        true,
        runId,
        [404],
        {},
        {
          [NATIVE_CLAUDE_OPUS_5_5_HEADER]: "0",
        },
      );
      await expect(api.readRun(actor, runId)).resolves.toMatchObject({
        status: "pending",
      });

      const claim = await api.claimRunnerJob(
        runId,
        {},
        {
          [NATIVE_CLAUDE_OPUS_5_5_HEADER]: "1",
        },
      );
      expect(claim.cliAgentType).toBe("claude-code");
      expect(claim.environment).toMatchObject({
        ANTHROPIC_MODEL: runtimeModel,
      });
      expect(claim.platformEnvironment).toMatchObject({
        OKOU_REASONING_EFFORT: "medium",
      });
      await api.requestCancelRun(actor, runId, [200]);
    },
  );

  it("lets an old Runner poll existing work behind an unsupported Claude Opus 5.5 job", async () => {
    const opus55 = await entitledChatActor();
    const opus5 = await entitledChatActor();
    const runnerGroup = opus5.runnerGroup;
    const runIds: string[] = [];
    for (const [fixture, model] of [
      [opus55, "claude-opus-5-5"],
      [opus5, "claude-opus-5"],
    ] as const) {
      const { actor, agentId } = fixture;
      if (!actor.orgId) {
        throw new Error("Expected an org-scoped chat actor");
      }
      const { providerId } = await api.createOrgModelProvider(actor, {
        type: "anthropic-api-key",
        secret: "test-native-model-key",
        selectedModel: model,
      });
      if (model === "claude-opus-5-5") {
        await stagePreAddabilityModelPolicyFixture({
          orgId: actor.orgId,
          userId: actor.userId,
          model,
        });
      }
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      const sent = await chat.requestSendEvent(
        actor,
        { agentId, model, prompt: `Run ${model} through the shared queue` },
        [201],
      );
      if (sent.status !== 201 || sent.body.runId === null) {
        throw new Error("Expected a queued Claude chat run");
      }
      runIds.push(sent.body.runId);
    }
    const [opus55RunId, opus5RunId] = runIds;
    if (!opus55RunId || !opus5RunId) {
      throw new Error("Expected both Claude runs");
    }
    await api.heartbeatRunner(runnerGroup);
    const capablePoll = await api.pollRunner(runnerGroup, {
      [NATIVE_CLAUDE_OPUS_5_5_HEADER]: "1",
    });
    expect(capablePoll.body.job?.runId).toBe(opus55RunId);
    for (const headers of [
      undefined,
      { [NATIVE_CLAUDE_OPUS_5_5_HEADER]: "0" },
    ]) {
      const oldPoll = await api.pollRunner(runnerGroup, headers);
      expect(oldPoll.body.job?.runId).toBe(opus5RunId);
    }
    const claim = await api.claimRunnerJob(opus5RunId);
    expect(claim.environment).toMatchObject({
      ANTHROPIC_MODEL: "claude-opus-5",
    });
    await expect(api.readRun(opus55.actor, opus55RunId)).resolves.toMatchObject(
      {
        status: "pending",
      },
    );
    await api.requestCancelRun(opus5.actor, opus5RunId, [200]);
    await api.requestCancelRun(opus55.actor, opus55RunId, [200]);
  });
});
