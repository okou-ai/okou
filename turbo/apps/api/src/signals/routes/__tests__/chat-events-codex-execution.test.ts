import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import {
  executionEnvironment,
  createChatEventsFixture,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { publicChatActor } from "./helpers/public-chat-actor";
import { server } from "../../../mocks/server";

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
    "routes native Codex for $model with tier $tier when KMS decryption is unavailable",
    async ({ model, tier }) => {
      const owned = await ownedChatActor();
      await owned.run(async () => {
        const { actor, agentId, sendChatRun, runExecution } = owned;
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
        server.use(
          http.post("https://kms.us-west-2.amazonaws.com/", ({ request }) => {
            if (
              request.headers.get("x-amz-target") === "TrentService.Decrypt"
            ) {
              return HttpResponse.json(
                { __type: "AccessDeniedException" },
                { status: 400 },
              );
            }
            return undefined;
          }),
        );
        const run = await sendChatRun(actor, {
          agentId,
          model,
          prompt: "run the same subscription through Codex",
          runOptions: { codexServiceTier: tier, reasoningEffort: "high" },
        });
        const { execution } = await runExecution(run.runId);
        expect(execution.cliAgentType).toBe("codex");
        expect(execution.piModelConfig).toBeUndefined();
        expect(execution.piLaunchConfig).toBeUndefined();
        expect(execution.piSessionId).toBeUndefined();

        expect(execution.billableFirewalls).toStrictEqual([]);
        expect(executionEnvironment(execution)).toMatchObject({
          OPENAI_MODEL: model,
          CODEX_OAUTH_ACCOUNT_ID: accountId,
          OKOU_REASONING_EFFORT: "high",
        });
        expect(executionEnvironment(execution).OKOU_CODEX_SERVICE_TIER).toBe(
          tier,
        );
        expect(
          execution.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
        ).toMatchObject({
          sourceId: connected.accountSourceId,
        });
      });
    },
  );

  it("uses the switch when an event-triggered workflow launches a subscription chat", async () => {
    const owned = await ownedChatActor("team");
    await owned.run(async () => {
      const { actor, agentId, runExecution } = owned;
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
      const { execution } = await runExecution(workflowRun.runId);
      expect(execution.cliAgentType).toBe("codex");
      expect(execution.piLaunchConfig).toBeUndefined();
      expect(executionEnvironment(execution)).toMatchObject({
        OPENAI_MODEL: "gpt-6-luna",
        CODEX_OAUTH_ACCOUNT_ID: accountId,
      });
      expect(execution.billableFirewalls).toStrictEqual([]);
    });
  });

  it("leaves Claude subscriptions on Claude Code", async () => {
    const owned = await ownedChatActor();
    await owned.run(async () => {
      const { actor, agentId, sendChatRun, runExecution } = owned;
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
      const { execution } = await runExecution(run.runId);
      expect(execution.cliAgentType).toBe("claude-code");
      expect(execution.piModelConfig).toBeUndefined();
      expect(executionEnvironment(execution).ANTHROPIC_MODEL).toBe(
        "claude-fable-5-1",
      );
    });
  });

  it("rotates native sessions and preserves visible context when switching both ways", async () => {
    const owned = await ownedChatActor();
    await owned.run(async () => {
      const { actor, agentId, sendChatRun, runExecution } = owned;
      await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
      mockPiResourceArchiveDownloads(true);
      const historyObjects = mockPiObjectStore();

      const prompt = "start this conversation on Pi";
      const first = await sendChatRun(actor, { agentId, prompt });
      const firstExecution = await runExecution(first.runId);
      expect(firstExecution.execution.cliAgentType).toBe("pi");
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
        execution: firstExecution,
        prompt,
        run: first,
        responsesModel: { provider: "openai-codex", model: "gpt-6-luna" },
      });
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue this conversation on Codex",
      });
      const secondExecution = await runExecution(second.runId);
      expect(secondExecution.execution.cliAgentType).toBe("codex");

      expect(secondExecution.execution.appendSystemPrompt).not.toContain(
        "The earlier Pi answer",
      );
      expect(
        secondExecution.execution.nativeContinuation?.recoveryPrompt,
      ).toContain("okou chat messages --output-dir /tmp/okou-chat-history");
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
      await completeChatRunOk(second.runId, secondExecution.sandboxHeaders, {
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
      const thirdExecution = await runExecution(third.runId);
      expect(thirdExecution.execution.cliAgentType).toBe("pi");

      expect(thirdExecution.execution.appendSystemPrompt).not.toContain(
        "The later Codex answer",
      );
    });
  });
});
