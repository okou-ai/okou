import { createHash } from "node:crypto";
import { MODEL_PROVIDER_ENV_PLACEHOLDERS } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { now } from "../../../lib/time";
import { readRunModelSourceFixture } from "../../../test-fixtures/agent-runs";
import { withModelRoutingQueryReceipt } from "../../../test-fixtures/model-routing-query-receipt";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { expectApiError } from "./helpers/api-bdd";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { readThreadSessionConversation } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  GPT_PI_BDD_MODELS,
  type PiGptBddModel,
  expectNoBuiltInModelUsage,
  claimEnvironment,
  eventBackedContents,
  assistantEvent,
} from "./helpers/chat-events-fixture";

const context = testContext({ connectorCatalog: true });
const {
  api,
  chat,
  misc,
  webhooks,
  chatCallbacks,
  authDeviceSupport,
  entitledChatActor,
  entitledNativeChatActor,
  configureSubscriptionPiModel,
  seedBuiltInModelKey,
  sendChatRun,
  expectThreadCreatedModelEvent,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  piSandboxBaseSession,
} = createChatEventsFixture(context);

function completedSubscriptionHistory(
  h0: string,
  prompt: string,
  selectedModel: PiGptBddModel,
): string {
  const h2Session = MemoryPiSession.fromJsonl(h0);
  h2Session.appendMessage({ role: "user", content: prompt, timestamp: 1 });
  h2Session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Subscription Sandbox complete" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: selectedModel,
    usage: {
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  return h2Session.toJsonl();
}

describe("CHAT-02: run-level model overrides", () => {
  it("describes raw chat history sync by default", async () => {
    // This checks the appended prompt, not Pi execution. Keep the run
    // claimable by the native Runner until the test cancels it.
    const { actor, agentId } = await entitledNativeChatActor();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "inspect raw thread history",
    });
    const stored = await api.readRun(actor, run.runId);
    const appended = stored.appendSystemPrompt ?? "";
    expect(appended).toContain(
      `okou chat messages --thread-id ${run.threadId} --output-dir threads`,
    );
    expect(appended).toContain(
      `rg -n '"seqId":<SEQ_ID>' threads/${run.threadId}/`,
    );
    expect(appended).not.toContain(
      "`okou chat messages` prints this thread's user and assistant messages",
    );

    await api.requestCancelRun(actor, run.runId, [200]);
  }, 60_000);

  it("uses send model overrides without mutating the thread model while preserving same-family sessions", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    // Claude subscription credentials stay on the native Claude Code harness
    // for every Claude model, so a same-family override keeps the CLI session.
    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "claude-code-oauth-token",
        secret: "send-override-claude-oauth-token",
      },
      [200, 201],
    );
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-5",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const firstPrompt = "first turn on the default opus policy";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-opus-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-5",
    );
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "opus answer")]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "opus answer";
      });
    });
    await expectThreadCreatedModelEvent(actor, first.threadId, "claude-opus-5");
    expect(
      (await api.readRun(actor, first.runId)).result?.agentSessionId,
    ).toMatch(/[0-9a-f-]{36}/);

    // A run-level override of another model in the same family resumes the CLI
    // session, which already carries the prior web round, so the prompt does
    // not replay it.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "switch to sonnet",
      model: "claude-sonnet-5",
    });
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).not.toContain("Assistant: opus answer");
    expect(appended).toContain("# This Chat Thread");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);
    expect(appended).toContain("`okou chat messages`");
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    // Follow-ups without a send model override go back to the thread's stored
    // model. Both models remain in the Claude family, so session continuity is
    // preserved.
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on the thread model",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    expect(claimEnvironment(thirdClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-5",
    );
    await cancelChatRun(actor, third.runId);
  }, 90_000);

  it("loads a personal default after the persisted model becomes invalid", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-5",
    });

    const { accountSourceId } = await configureSubscriptionPiModel(actor, {
      accountId: "personal-default-fallback-account",
    });
    // Astra keeps the fallback run on the native Codex harness, so the receipt
    // observes only send admission.
    await seedBuiltInModelKey("gpt-6-astra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-6-astra",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    await misc.deleteOrgModelProvider(actor, "anthropic-api-key", [204]);

    const captured = await withModelRoutingQueryReceipt(() => {
      return sendChatRun(actor, {
        agentId,
        threadId: thread.id,
        prompt: "continue through the personal workspace default",
      });
    });
    const followUp = captured.result;
    // The optimistic read and transactional revalidation each load metadata
    // once; selected-route failure and default fallback share it within both.
    expect(captured.receipt.personalMetadataReads).toBe(2);
    await expect(
      readRunModelSourceFixture(followUp.runId),
    ).resolves.toMatchObject({
      modelProvider: "codex-oauth-token",
      modelProviderCredentialScope: "member",
      modelProviderId: accountSourceId,
      selectedModel: "gpt-6-astra",
      creditAdmitted: false,
      builtInModelKeyId: null,
    });
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({ selectedModel: "gpt-6-astra" });
    await cancelChatRun(actor, followUp.runId);
  }, 90_000);

  it.each(
    (
      [
        {
          name: "standard",
          tier: undefined,
          generation: 2,
          outcome: "completed",
        },
        { name: "Fast", tier: "fast", generation: 3, outcome: "completed" },
        { name: "Fast", tier: "fast", generation: 3, outcome: "failed" },
        { name: "Fast", tier: "fast", generation: 3, outcome: "cancelled" },
      ] as const
    ).flatMap((scenario) => {
      return GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
        const routes =
          selectedModel === "gpt-5.6-terra" && scenario.outcome === "completed"
            ? [false, true]
            : [false];
        return routes
          .map((organizationApi) => {
            return {
              ...scenario,
              selectedModel,
              organizationApi,
            };
          })
          .filter(({ tier, outcome, organizationApi }) => {
            return (
              (tier === "fast" && outcome === "completed") ||
              (selectedModel === "gpt-5.6-terra" &&
                tier === undefined &&
                !organizationApi) ||
              (selectedModel === "gpt-5.6-sol" && outcome === "failed") ||
              (selectedModel === "gpt-5.6-luna" && outcome === "cancelled")
            );
          });
      });
    }),
  )(
    "hands native $name subscription $selectedModel runs to a generation-$generation Sandbox with $outcome outcome and no built-in billing (organization API: $organizationApi)",
    async ({ tier, generation, outcome, selectedModel, organizationApi }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const firewall = createFirewallApi(context);
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const externalAccountId = "chat-codex-pi-subscription-account";
      const refreshToken = "rt_pi_subscription_fixture_high_entropy";
      const { oauth, accountSourceId } = await configureSubscriptionPiModel(
        actor,
        {
          accountId: externalAccountId,
          refreshToken,
          accessTokenExpiresAt: Math.floor(now() / 1000) - 60,
          refreshedAccessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
          workspaceName: "Pi Subscription Account",
        },
        selectedModel,
      );
      if (organizationApi) {
        await api.updateOrgModelPolicies(actor, [
          {
            model: selectedModel,
            isDefault: true,
            defaultProviderType: "built-in",
            credentialScope: "org",
            modelProviderId: null,
          },
        ]);
      }
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PersonalModelProviderAccounts]: false,
      });

      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();

      const prompt = "use the Okou CLI through native subscription Terra";
      const run = await sendChatRun(actor, {
        agentId,
        prompt,
        model: selectedModel,
        runOptions: { codexServiceTier: tier },
      });
      await expectNoBuiltInModelUsage(run.runId);

      await api.heartbeatRunner(runnerGroup);
      if (tier === "fast") {
        const oldClaim = await api.requestClaimRunnerJob(
          true,
          run.runId,
          [404],
          { capabilities: { piModelConfigGenerations: [1, 2] } },
        );
        expectApiError(oldClaim.body);
        await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
          status: "pending",
        });
      }
      const claim = await api.claimRunnerJob(run.runId, {
        capabilities: {
          piModelConfigGenerations: tier === "fast" ? [1, 2, 3] : [1, 2],
        },
      });
      const sandboxHeaders = {
        authorization: `Bearer ${claim.sandboxToken}`,
      };
      expect(claim).toMatchObject({
        cliAgentType: "pi",
        piSessionId: run.threadId,
        piModelConfig: {
          schemaVersion: generation,
          ...(tier === undefined ? {} : { serviceTier: tier }),
          dialect: "openai-codex-responses",
          transport: "sse",
          provider: "openai-codex",
          baseUrl: "https://chatgpt.com/backend-api",
          model: selectedModel,
          thinkingLevel: "max",
          credentialBindings: [
            {
              kind: "access-token",
              environment: "CHATGPT_ACCESS_TOKEN",
              secretName: "CHATGPT_ACCESS_TOKEN",
            },
            {
              kind: "account-id",
              environment: "CHATGPT_ACCOUNT_ID",
              secretName: "CHATGPT_ACCOUNT_ID",
            },
          ],
        },
      });
      expect(claimEnvironment(claim)).toMatchObject({
        CHATGPT_ACCESS_TOKEN:
          MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN,
        CHATGPT_ACCOUNT_ID: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCOUNT_ID,
      });
      expect(claim.billableFirewalls).toStrictEqual([]);
      expect(
        claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
      ).toMatchObject({ sourceId: accountSourceId });
      expect(
        claim.secretConnectorMetadataMap?.CHATGPT_ACCOUNT_ID,
      ).toMatchObject({
        sourceId: accountSourceId,
      });
      expect(claim.resumeSession).toBeNull();
      expect(JSON.stringify(claim)).not.toContain(externalAccountId);
      expect(JSON.stringify(claim)).not.toContain(refreshToken);

      const encryptedSecrets = z.string().parse(claim.encryptedSecrets);
      const sandboxCredential = await firewall.requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets,
          authHeaders: {
            Authorization: `Bearer \${{ secrets.CHATGPT_ACCESS_TOKEN }}`,
            "ChatGPT-Account-ID": `\${{ secrets.CHATGPT_ACCOUNT_ID }}`,
          },
          secretConnectorMap: claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (sandboxCredential.status !== 200) {
        throw new Error("Expected exact subscription firewall credentials");
      }
      expect(sandboxCredential.body.headers["ChatGPT-Account-ID"]).toBe(
        externalAccountId,
      );
      // The expired access token is refreshed once for the Sandbox request.
      expect(oauth.oauthToken).toHaveLength(2);
      expect(oauth.oauthToken[1]?.get("grant_type")).toBe("refresh_token");
      const refreshedAccessToken = z
        .string()
        .parse(oauth.oauthTokenResponses[1]?.access_token);
      expect(sandboxCredential.body.headers.Authorization).toBe(
        `Bearer ${refreshedAccessToken}`,
      );

      const h0Text = piSandboxBaseSession(claim, checkpointObjects).toString(
        "utf8",
      );
      const h2 = completedSubscriptionHistory(h0Text, prompt, selectedModel);
      expect(h2).not.toMatch(/serviceTier|service_tier/);
      const h2Hash = createHash("sha256").update(h2).digest("hex");
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: h2Hash,
          rawSize: Buffer.byteLength(h2),
          encodedSize: Buffer.byteLength(h2),
          encoding: "identity",
        },
        sandboxHeaders,
        [200],
      );
      checkpointObjects.set(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
        Buffer.from(h2, "utf8"),
      );
      if (outcome === "cancelled") {
        await cancelChatRun(actor, run.runId);
      }
      const completion = await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: outcome === "failed" ? 1 : 0,
          ...(outcome === "failed"
            ? { error: "Subscription Sandbox failed" }
            : {}),
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryHash: h2Hash,
          },
        },
        sandboxHeaders,
        outcome === "cancelled" ? [400] : [200],
      );
      expect(completion.status).toBe(outcome === "cancelled" ? 400 : 200);
      await waitForRunStatus(actor, run.runId, outcome);
      await flushWaitUntilForTest();
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      await expectNoBuiltInModelUsage(run.runId);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: outcome,
      });
      if (outcome !== "completed") {
        return;
      }

      const firstSession = await readThreadSessionConversation(
        context,
        run.threadId,
      );
      const continued = await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "continue on the same subscription account",
        model: selectedModel,
        runOptions: { codexServiceTier: tier },
      });
      await flushWaitUntilForTest();
      const continuedClaim = await claimChatRun(runnerGroup, continued.runId);
      expect(continuedClaim.claim).toMatchObject({
        piSessionId: run.threadId,
        resumeSession: {
          sessionId: run.threadId,
          historyRef: { kind: "blob", hash: h2Hash },
        },
        piModelConfig: {
          model: selectedModel,
          ...(tier === undefined ? {} : { serviceTier: tier }),
        },
      });
      await expect(
        readThreadSessionConversation(context, run.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
      });
      await expectNoBuiltInModelUsage(continued.runId);
      await cancelChatRun(
        actor,
        continued.runId,
        continuedClaim.sandboxHeaders,
      );
    },
    90_000,
  );
});
