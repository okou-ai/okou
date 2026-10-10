import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  claimEnvironment,
  createChatEventsFixture,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";

const context = testContext();
const {
  api,
  chatCallbacks,
  entitledChatActor,
  configureBuiltInPiModelOnOpenRouter,
  configureSubscriptionPiModel,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
  mockPiCheckpointObjectStore,
  completeSandboxFirstPiRun,
  completeChatRunOk,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

const SUBSCRIPTION_CASES = [
  { model: "gpt-6.1-sol", tier: undefined },
  { model: "gpt-6.1-sol", tier: "fast" },
  { model: "gpt-6-luna", tier: undefined },
  { model: "gpt-6-luna", tier: "fast" },
] as const;

describe("Codex execution switch", () => {
  it.each(SUBSCRIPTION_CASES)(
    "uses native Codex for $model with tier $tier without changing its account",
    async ({ model, tier }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const accountId = `codex-switch-${randomUUID()}`;
      const connected = await configureSubscriptionPiModel(
        actor,
        { accountId },
        model,
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: requireOrgId(actor) },
        { [FeatureSwitchKey.CodexExecution]: true },
      );
      const run = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "run the same subscription through Codex",
        runOptions: { codexServiceTier: tier, reasoningEffort: "high" },
      });
      const { claim } = await claimChatRun(runnerGroup, run.runId);
      expect(claim.cliAgentType).toBe("codex");
      expect(claim.piModelConfig).toBeUndefined();
      expect(claim.piLaunchConfig).toBeUndefined();
      expect(claim.piSessionId).toBeUndefined();
      expect(claim.resumeSession).toBeNull();
      expect(claim.billableFirewalls).toStrictEqual([]);
      expect(claimEnvironment(claim)).toMatchObject({
        OPENAI_MODEL: model,
        CODEX_OAUTH_ACCOUNT_ID: accountId,
        OKOU_REASONING_EFFORT: "high",
      });
      expect(claimEnvironment(claim).OKOU_CODEX_SERVICE_TIER).toBe(tier);
      expect(
        claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
      ).toMatchObject({
        sourceId: connected.accountSourceId,
      });
      await cancelChatRun(actor, run.runId);
    },
  );

  it("uses the existing OpenRouter preset and billing route for Auto on Codex", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await configureBuiltInPiModelOnOpenRouter(actor);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.CodexExecution]: true },
    );
    const run = await sendChatRun(actor, {
      agentId,
      model: null,
      prompt: "run Auto through Codex",
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    expect(claim.cliAgentType).toBe("codex");
    expect(claim.piModelConfig).toBeUndefined();
    expect(claim.codexRuntimeConfig).toMatchObject({
      providerId: "openrouter-codex",
      baseUrl: "https://openrouter.ai/api/v1",
      wireApi: "responses",
    });
    expect(claimEnvironment(claim).OPENAI_MODEL).toBe("@preset/okou-1-0");
    expect(claim.modelUsageProvider).toBe("@preset/okou-1-0");
    expect(claim.billableFirewalls).toContain(
      "model-provider:openrouter-codex",
    );
    await cancelChatRun(actor, run.runId);
  });

  it("uses the switch when an event-triggered workflow launches Auto", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor({}, "team");
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await configureBuiltInPiModelOnOpenRouter(actor);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.CodexExecution]: true },
    );

    const workflowRun = await createWorkflowsBddApi(
      context,
    ).startEventAutomationRun(actor, agentId);
    const { claim } = await claimChatRun(runnerGroup, workflowRun.runId);
    expect(claim.cliAgentType).toBe("codex");
    expect(claim.piLaunchConfig).toBeUndefined();
    expect(claim.codexRuntimeConfig).toMatchObject({
      providerId: "openrouter-codex",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(claim.billableFirewalls).toContain(
      "model-provider:openrouter-codex",
    );
    await cancelChatRun(actor, workflowRun.runId);
  });

  it("leaves Claude subscriptions on Claude Code", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.CodexExecution]: true },
    );
    const run = await sendChatRun(actor, {
      agentId,
      model: "claude-fable-5-1",
      prompt: "keep Claude on its own harness",
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    expect(claim.cliAgentType).toBe("claude-code");
    expect(claim.piModelConfig).toBeUndefined();
    expect(claimEnvironment(claim).ANTHROPIC_MODEL).toBe("claude-fable-5-1");
    await cancelChatRun(actor, run.runId);
  });

  it("rotates native sessions and preserves visible context when switching both ways", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    await publishPendingPiInstructions(actor, agentId);
    mockPiResourceArchiveDownloads(true);
    const historyObjects = mockPiCheckpointObjectStore();

    const prompt = "start this conversation on Pi";
    const first = await sendChatRun(actor, { agentId, prompt });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.cliAgentType).toBe("pi");
    // Changing the switch does not rewrite the already claimed Pi run.
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.CodexExecution]: true },
    );
    await completeSandboxFirstPiRun({
      actor,
      answer: "The earlier Pi answer",
      historyObjects,
      claim: firstClaim,
      prompt,
      run: first,
      responsesModel: { provider: "openai-codex", model: "gpt-6-luna" },
    });
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue this conversation on Codex",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.cliAgentType).toBe("codex");
    expect(secondClaim.claim.resumeSession).toBeNull();
    expect(secondClaim.claim.appendSystemPrompt).toContain(
      "The earlier Pi answer",
    );
    chatCallbacks.mockChatOutputEvents([
      {
        type: "assistant",
        sequenceNumber: 1,
        message: {
          content: [{ type: "text", text: "The later Codex answer" }],
        },
      },
      { type: "result", sequenceNumber: 2, result: "The later Codex answer" },
    ]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
      cliAgentType: "codex",
      cliAgentSessionId: randomUUID(),
    });
    await flushWaitUntilForTest();
    await expect(api.readRun(actor, second.runId)).resolves.toMatchObject({
      status: "completed",
    });

    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.CodexExecution]: false },
    );
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "return this conversation to Pi",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.cliAgentType).toBe("pi");
    expect(thirdClaim.claim.resumeSession).toBeNull();
    expect(thirdClaim.claim.appendSystemPrompt).toContain(
      "The later Codex answer",
    );
    await cancelChatRun(actor, third.runId);
  });
});
