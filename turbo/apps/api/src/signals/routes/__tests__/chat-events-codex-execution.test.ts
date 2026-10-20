import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import {
  claimEnvironment,
  createChatEventsFixture,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  configureSubscriptionPiModel,
  mockPiResourceArchiveDownloads,
  mockPiObjectStore,
  completeSandboxFirstPiRun,
  completeChatRunOk,
} = createChatEventsFixture(context);

async function ownedChatActor(tier: "pro" | "team" = "pro") {
  const owned = await publicChatActor(context, {
    tier,
    beforeWorkspaceCleanup: async (actor) => {
      const accounts = createAuthDeviceSupportApi(context);
      const errors: unknown[] = [];
      for (const type of [
        "claude-code-oauth-token",
        "codex-oauth-token",
      ] as const) {
        const result = await settleIncludingAbort(() => {
          return accounts.deletePersonalModelProvider(actor, type, [204, 404]);
        });
        if (!result.ok) {
          errors.push(result.error);
        }
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Codex test account cleanup failed");
      }
    },
  });
  owned.ownsFeatureSwitches();
  return owned;
}

const SUBSCRIPTION_CASES = [
  { model: "gpt-6.1-sol", tier: undefined },
  { model: "gpt-6.1-sol", tier: "fast" },
  { model: "gpt-6-luna", tier: undefined },
  { model: "gpt-6-luna", tier: "fast" },
] as const;

describe("Codex execution switch", () => {
  beforeEach(mockSecretKmsHttp);

  it.each(SUBSCRIPTION_CASES)(
    "uses native Codex for $model with tier $tier without changing its account",
    async ({ model, tier }) => {
      const owned = await ownedChatActor();
      await owned.run(async () => {
        const { actor, agentId, runnerGroup, sendChatRun, claimChatRun } =
          owned;
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
      });
    },
  );

  it("uses the switch when an event-triggered workflow launches a subscription chat", async () => {
    const owned = await ownedChatActor("team");
    await owned.run(async () => {
      const { actor, agentId, runnerGroup, claimChatRun } = owned;
      const accountId = `codex-workflow-${randomUUID()}`;
      await configureSubscriptionPiModel(actor, { accountId }, "gpt-6-luna");
      const thread = await chat.createThread(actor, {
        agentId,
        model: "gpt-6-luna",
      });
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: requireOrgId(actor) },
        { [FeatureSwitchKey.CodexExecution]: true },
      );

      const workflowRun = await createWorkflowsBddApi(
        context,
      ).startEventAutomationRun(actor, agentId, thread.id);
      const { claim } = await claimChatRun(runnerGroup, workflowRun.runId);
      expect(claim.cliAgentType).toBe("codex");
      expect(claim.piLaunchConfig).toBeUndefined();
      expect(claimEnvironment(claim)).toMatchObject({
        OPENAI_MODEL: "gpt-6-luna",
        CODEX_OAUTH_ACCOUNT_ID: accountId,
      });
      expect(claim.billableFirewalls).toStrictEqual([]);
    });
  });

  it("leaves Claude subscriptions on Claude Code", async () => {
    const owned = await ownedChatActor();
    await owned.run(async () => {
      const { actor, agentId, runnerGroup, sendChatRun, claimChatRun } = owned;
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
    });
  });

  it("rotates native sessions and preserves visible context when switching both ways", async () => {
    const owned = await ownedChatActor();
    await owned.run(async () => {
      const { actor, agentId, runnerGroup, sendChatRun, claimChatRun } = owned;
      await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
      mockPiResourceArchiveDownloads(true);
      const historyObjects = mockPiObjectStore();

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

      expect(secondClaim.claim.appendSystemPrompt).not.toContain(
        "The earlier Pi answer",
      );
      expect(secondClaim.claim.nativeContinuation?.recoveryPrompt).toContain(
        "okou chat messages --output-dir threads",
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

      expect(thirdClaim.claim.appendSystemPrompt).not.toContain(
        "The later Codex answer",
      );
    });
  });
});
