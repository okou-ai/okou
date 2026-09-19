import { createHash, randomUUID } from "node:crypto";
import { MODEL_PROVIDER_ENV_PLACEHOLDERS } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { env, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { readRunModelSourceFixture } from "../../../test-fixtures/agent-runs";
import { withModelRoutingQueryReceipt } from "../../../test-fixtures/model-routing-query-receipt";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { expectApiError } from "./helpers/api-bdd";
import { mockCodexDeviceAuthProvider } from "./helpers/api-bdd-auth-device";
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
import {
  piResponsesContentSse,
  nativeCodexSseResponse,
  readCodexRequestJson,
} from "./helpers/pi-responses";

const context = testContext();
const {
  api,
  chat,
  misc,
  webhooks,
  chatCallbacks,
  authDevice,
  authDeviceSupport,
  entitledChatActor,
  configureOrganizationGptModel,
  configureSubscriptionPiModel,
  configureBuiltInPiModel,
  sendChatRun,
  expectThreadCreatedModelEvent,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

function expectNativeSubscriptionRequest(
  request: unknown,
  accessToken: string,
  tier: "fast" | undefined,
  selectedModel: PiGptBddModel = "gpt-5.6-terra",
): void {
  expect(request).toMatchObject({
    accountMatches: true,
    authorization: `Bearer ${accessToken}`,
    body: {
      model: selectedModel,
      stream: true,
      store: false,
      reasoning: { effort: "max" },
    },
  });
  const { body } = z
    .object({ body: z.record(z.string(), z.unknown()) })
    .parse(request);
  expect(body.service_tier).toBe(tier === undefined ? undefined : "priority");
  expect(body).not.toHaveProperty("previous_response_id");
}

function settledSubscriptionToolHistory(h1: string): string {
  const h2Session = MemoryPiSession.fromJsonl(h1);
  const pendingAssistant = [...h2Session.buildSessionContext().messages]
    .reverse()
    .find((message) => {
      return message.role === "assistant";
    });
  const pendingTool =
    pendingAssistant?.role === "assistant"
      ? pendingAssistant.content.find((content) => {
          return content.type === "toolCall";
        })
      : undefined;
  if (
    pendingAssistant?.role !== "assistant" ||
    !pendingTool ||
    pendingTool.type !== "toolCall"
  ) {
    throw new Error("Expected native Codex tool call in H1");
  }
  h2Session.appendMessage({
    role: "toolResult",
    toolCallId: pendingTool.id,
    toolName: pendingTool.name,
    content: [{ type: "text", text: "Okou CLI help output" }],
    details: {},
    isError: false,
    timestamp: 2,
  });
  h2Session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Subscription Sandbox complete" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: pendingAssistant.model,
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
    timestamp: 3,
  });
  return h2Session.toJsonl();
}

describe("CHAT-02: run-level model overrides", () => {
  it("describes raw chat history sync by default", async () => {
    const { actor, agentId } = await entitledChatActor();

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
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const firstPrompt = "first turn on the default opus policy";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-opus-4-8",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-8",
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
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-opus-4-8",
    );
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
      "claude-opus-4-8",
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

    const { accountSourceId } = await configureSubscriptionPiModel(
      actor,
      { accountId: "personal-default-fallback-account" },
      "gpt-5.6-terra",
    );
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-terra",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    await misc.deleteOrgModelProvider(actor, "anthropic-api-key", [204]);
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
      [FeatureSwitchKey.PiLoop]: false,
    });

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
      selectedModel: "gpt-5.6-terra",
      creditAdmitted: false,
      builtInModelKeyId: null,
    });
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({ selectedModel: "gpt-5.6-terra" });
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
        return routes.map((organizationApi) => {
          return {
            ...scenario,
            selectedModel,
            organizationApi,
          };
        });
      });
    }),
  )(
    "hands native $name subscription $selectedModel tools to a generation-$generation Sandbox with $outcome outcome and no built-in billing (organization API: $organizationApi)",
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
        [FeatureSwitchKey.PersonalSubscriptionPriority]: organizationApi,
        [FeatureSwitchKey.PersonalModelProviderAccounts]: false,
        [FeatureSwitchKey.PiLoop]: true,
      });

      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const providerRequests: {
        readonly accountMatches: boolean;
        readonly authorization: string | null;
        readonly body: unknown;
      }[] = [];
      server.use(
        http.post(
          "https://chatgpt.com/backend-api/codex/responses",
          async ({ request }) => {
            const authorization = request.headers.get("authorization");
            const body = await readCodexRequestJson(request);
            providerRequests.push({
              accountMatches:
                request.headers.get("chatgpt-account-id") === externalAccountId,
              authorization,
              body,
            });
            const responseBody = piResponsesContentSse({
              blocks:
                providerRequests.length === 1
                  ? [
                      {
                        type: "toolCall",
                        callId: "call_subscription_tool",
                        name: "bash",
                        arguments: {
                          command: `npx --yes --package="\${CLI_PKG_URL}" okou --help`,
                        },
                      },
                    ]
                  : [
                      {
                        type: "text",
                        text: "Subscription API-first continuation complete",
                      },
                    ],
              sequence: providerRequests.length,
            });
            return nativeCodexSseResponse(responseBody);
          },
        ),
      );

      const run = await sendChatRun(actor, {
        agentId,
        prompt: "use the Okou CLI through native subscription Terra",
        model: selectedModel,
        runOptions: { codexServiceTier: tier },
      });
      await expect
        .poll(() => {
          return providerRequests.length;
        })
        .toBe(1);
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
      const sessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`;
      await expect
        .poll(() => {
          return checkpointObjects.has(manifestKey);
        })
        .toBe(true);
      await flushWaitUntilForTest();

      expect(providerRequests).toHaveLength(1);
      const refreshedAccessToken = z
        .string()
        .parse(oauth.oauthTokenResponses[1]?.access_token);
      expectNativeSubscriptionRequest(
        providerRequests[0],
        refreshedAccessToken,
        tier,
        selectedModel,
      );
      expect(oauth.oauthToken).toHaveLength(2);
      expect(oauth.oauthToken[1]?.get("grant_type")).toBe("refresh_token");
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
      expect(sandboxCredential.body.headers.Authorization).toBe(
        `Bearer ${refreshedAccessToken}`,
      );
      expect(oauth.oauthToken).toHaveLength(2);

      const h1 = z
        .instanceof(Buffer)
        .parse(checkpointObjects.get(sessionKey))
        .toString("utf8");
      expect(h1).not.toMatch(/serviceTier|service_tier/);
      expect(h1).not.toContain(externalAccountId);
      expect(h1).not.toContain(refreshToken);
      expect(h1).not.toContain(
        MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN,
      );
      const h2 = settledSubscriptionToolHistory(h1);
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
      expect(providerRequests).toHaveLength(1);
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
      await waitForRunStatus(actor, continued.runId, "completed");
      await flushWaitUntilForTest();
      expect(providerRequests).toHaveLength(2);
      expectNativeSubscriptionRequest(
        providerRequests[1],
        refreshedAccessToken,
        tier,
        selectedModel,
      );
      expect(JSON.stringify(providerRequests[1]?.body)).toContain(
        "Okou CLI help output",
      );
      expect(
        eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          continued.runId,
        ),
      ).toContainEqual(
        expect.objectContaining({
          content: "Subscription API-first continuation complete",
        }),
      );
      await expect(
        readThreadSessionConversation(context, run.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
      });
      await expectNoBuiltInModelUsage(continued.runId);
    },
    90_000,
  );

  it.each(
    [
      ...[
        "refresh_token_reused",
        "refresh_token_expired",
        "refresh_token_invalidated",
      ].map((refreshErrorCode) => {
        return {
          name: refreshErrorCode,
          failureReason: "reconnect_required" as const,
          errorCode: "PI_API_MODEL_CREDENTIAL_INVALID",
          refreshErrorCode,
          expectedReconnect: true,
          expired: true,
          providerCalls: 0,
        };
      }),
      {
        name: "unknown refresh failure",
        failureReason: "reconnect_required" as const,
        errorCode: "PI_API_MODEL_CREDENTIAL_INVALID",
        refreshErrorCode: "new_provider_error",
        expectedReconnect: false,
        expired: true,
        providerCalls: 0,
      },
      {
        name: "transient refresh failure",
        failureReason: undefined,
        errorCode: "PI_API_MODEL_CREDENTIAL_INVALID",
        refreshErrorCode: null,
        expectedReconnect: false,
        expired: true,
        providerCalls: 0,
      },
      {
        name: "transient provider failure",
        failureReason: undefined,
        errorCode: "PI_API_MODEL_FAILED",
        refreshErrorCode: null,
        expectedReconnect: false,
        expired: false,
        providerCalls: 1,
      },
      {
        name: "subscription usage limit",
        failureReason: "usage_limit" as const,
        errorCode: "PI_API_MODEL_FAILED",
        refreshErrorCode: null,
        expectedReconnect: false,
        expired: false,
        providerCalls: 1,
      },
    ].flatMap((scenario) => {
      return ([undefined, "fast"] as const).flatMap((tier) => {
        return [false, true].map((organizationApi) => {
          return {
            ...scenario,
            tier,
            organizationApi,
          };
        });
      });
    }),
  )(
    "classifies a $name with tier $tier without replay, billing, or private diagnostics (organization API: $organizationApi)",
    async (scenario) => {
      mockOptionalEnv("OKOU_DEBUG", "webhook:firewall-auth,pi-api-first-turn");
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const privateMarker = `private-${scenario.failureReason}-diagnostic`;
      const externalAccountId = `chat-${scenario.failureReason}-account`;
      const refreshToken = `rt_${scenario.failureReason}_high_entropy`;
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PersonalSubscriptionPriority]:
          scenario.organizationApi,
        [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
        [FeatureSwitchKey.PiLoop]: true,
      });
      if (scenario.organizationApi) {
        mockCodexDeviceAuthProvider({
          tokenScope: "personal",
          accountId: `sibling-${randomUUID()}`,
          accessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
        });
        const siblingStart = await authDevice.requestCodexStart(
          actor,
          "personal",
          [200],
          { mode: "add" },
        );
        if (siblingStart.status !== 200) {
          throw new Error("Expected sibling authorization");
        }
        await authDevice.requestCodexComplete(
          actor,
          siblingStart.body.sessionToken,
          [200],
        );
      }
      const oauth = mockCodexDeviceAuthProvider({
        tokenScope: "personal",
        accountId: externalAccountId,
        refreshToken,
        accessTokenExpiresAt: scenario.expired
          ? Math.floor(now() / 1000) - 60
          : Math.floor(now() / 1000) + 7200,
        workspaceName: "Pi Failure Account",
      });
      const started = await authDevice.requestCodexStart(
        actor,
        "personal",
        [200],
        { mode: "add" },
      );
      if (started.status !== 200) {
        throw new Error("Expected subscription auth to start");
      }
      const completed = await authDevice.requestCodexComplete(
        actor,
        started.body.sessionToken,
        [200],
      );
      if (
        !("status" in completed.body) ||
        completed.body.status !== "complete"
      ) {
        throw new Error("Expected subscription auth to complete");
      }
      if (scenario.organizationApi) {
        await authDeviceSupport.activatePersonalModelProviderAccount(
          actor,
          completed.body.provider.id,
        );
      }
      let refreshAttempts = 0;
      if (scenario.expired) {
        server.use(
          http.post("https://auth.openai.com/oauth/token", () => {
            refreshAttempts += 1;
            return HttpResponse.json(
              {
                error: {
                  code: scenario.refreshErrorCode ?? "server_error",
                  message: privateMarker,
                },
              },
              { status: scenario.refreshErrorCode === null ? 503 : 401 },
            );
          }),
        );
      }

      if (scenario.organizationApi) {
        await configureOrganizationGptModel(actor);
      } else {
        await chatCallbacks.updateOrgModelPolicies(actor, [
          {
            model: "gpt-5.6-terra",
            isDefault: true,
            defaultProviderType: "codex-oauth-token",
            credentialScope: "member",
            modelProviderId: null,
          },
        ]);
      }
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      const providerAttempted = createDeferredPromise<void>(context.signal);
      const alternateRequests: string[] = [];
      server.use(
        http.post(
          /^https:\/\/(api\.openai\.com|openrouter\.ai|api\.anthropic\.com)\//,
          ({ request }) => {
            alternateRequests.push(request.url);
            return HttpResponse.json(
              { error: "unexpected alternate API" },
              { status: 500 },
            );
          },
        ),
      );
      server.use(
        http.post(
          "https://chatgpt.com/backend-api/codex/responses",
          async ({ request }) => {
            modelCalls += 1;
            expect(request.headers.get("authorization")).toBe(
              `Bearer ${oauth.oauthTokenResponses[0]?.access_token}`,
            );
            expect(request.headers.get("chatgpt-account-id")).toBe(
              externalAccountId,
            );
            await expect(readCodexRequestJson(request)).resolves.toMatchObject({
              model: "gpt-5.6-terra",
            });
            providerAttempted.resolve(undefined);
            return HttpResponse.json(
              {
                error: {
                  code:
                    scenario.name === "transient provider failure"
                      ? "server_error"
                      : "usage_limit_reached",
                  message: privateMarker,
                },
              },
              {
                status:
                  scenario.name === "transient provider failure" ? 503 : 429,
              },
            );
          },
        ),
      );

      const run = await sendChatRun(actor, {
        agentId,
        prompt: `classify ${scenario.failureReason}`,
        model: "gpt-5.6-terra",
        runOptions: { codexServiceTier: scenario.tier },
      });
      if (scenario.name === "transient provider failure") {
        // Existing Pi recovery hands the same personal source to Sandbox. This
        // is not an organization API/model/account retry or a paid model route.
        await providerAttempted.promise;
        await flushWaitUntilForTest();
        await waitForRunStatus(actor, run.runId, "pending", 10_000);
        const { claim, sandboxHeaders } = await claimChatRun(
          runnerGroup,
          run.runId,
        );
        expect(claim.billableFirewalls).toStrictEqual([]);
        expect(
          claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN?.sourceId,
        ).toBe(completed.body.provider.id);
        await failChatRun(
          run.runId,
          sandboxHeaders,
          "[PI_API_MODEL_FAILED] Upstream provider temporarily unavailable",
        );
      }
      await waitForRunStatus(actor, run.runId, "failed", 10_000);
      await flushWaitUntilForTest();

      const failed = await api.readRun(actor, run.runId);
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringContaining(`[${scenario.errorCode}]`),
      });
      expect(modelCalls).toBe(scenario.providerCalls);
      expect(alternateRequests).toStrictEqual([]);
      await expect(readRunModelSourceFixture(run.runId)).resolves.toMatchObject(
        {
          modelProvider: "codex-oauth-token",
          modelProviderCredentialScope: "member",
          modelProviderId: completed.body.provider.id,
          selectedModel: "gpt-5.6-terra",
          creditAdmitted: false,
          builtInModelKeyId: null,
        },
      );
      expect(refreshAttempts).toBe(scenario.expired ? 1 : 0);
      expect(oauth.oauthToken).toHaveLength(1);
      if (scenario.expectedReconnect) {
        expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
      }
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      const failureEvent = events.find((event) => {
        return event.eventType === "run.failed" && event.runId === run.runId;
      });
      if (failureEvent?.eventType !== "run.failed") {
        throw new Error("Expected the subscription run failure event");
      }
      expect(failureEvent.failureReason).toBe(scenario.failureReason);
      const publicState = JSON.stringify({
        failed,
        events,
        checkpointObjects: [...checkpointObjects.entries()].map(
          ([key, value]) => {
            return [key, value.toString("utf8")];
          },
        ),
      });
      expect(publicState).not.toContain(privateMarker);
      expect(publicState).not.toContain(externalAccountId);
      expect(publicState).not.toContain(refreshToken);
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      await expectNoBuiltInModelUsage(run.runId);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expectApiError(claim.body);
      if (scenario.expectedReconnect) {
        const repeated = await sendChatRun(actor, {
          agentId,
          prompt: "retry the terminal subscription account",
          model: "gpt-5.6-terra",
          runOptions: { codexServiceTier: scenario.tier },
        });
        await waitForRunStatus(actor, repeated.runId, "failed", 10_000);
        await flushWaitUntilForTest();
        expect(refreshAttempts).toBe(1);
        expect(modelCalls).toBe(0);
        expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
        expect(
          (await chat.listThreadEvents(actor, repeated.threadId)).events,
        ).toContainEqual(
          expect.objectContaining({
            eventType: "run.failed",
            runId: repeated.runId,
            failureReason: "reconnect_required",
          }),
        );
      }
    },
    90_000,
  );
});
