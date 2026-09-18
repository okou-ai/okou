import { createHash, randomUUID } from "node:crypto";
import { MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS } from "@okouai/api-contracts/contracts/model-price-tiers";
import { modelProvidersByTypeContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { piApiFirstTurnManifestSchema } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { v5 as uuidv5 } from "uuid";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  deletePiApiFirstTurnUsageEventsFixture,
  insertPiApiFirstTurnUsageEventsFixture,
  readRunUsageEventsFixture,
  replacePiSessionHistoryJsonlFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { modelProvidersRoutes } from "../model-providers";
import { expectApiError } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  readRunLaunchSnapshotFixture,
  readThreadSessionBinding,
  readThreadSessionConversation,
} from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  GPT_PI_BDD_MODELS,
  GPT_API_KEY_BDD_ROUTES,
  USER_OWNED_GPT_FAST_BDD_ROUTES,
  requireOrgId,
  expectPiApiUsage,
  expectNoBuiltInModelUsage,
  createGptUsagePricingResolution,
  createPiApiFirstTurnUsagePricingResolution,
  claimEnvironment,
  userMessages,
  eventBackedContents,
  modelProviderSecretPlaceholder,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
  occurrences,
} from "./helpers/chat-events-fixture";
import {
  piResponsesTextSse,
  piResponsesContentSse,
  readCodexRequestJson,
} from "./helpers/pi-responses";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  chatCallbacks,
  entitledChatActor,
  configureBuiltInPiModel,
  configureApiKeyGptPiModel,
  configureBuiltInPiModelOnOpenRouter,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  sessionHeaders,
  upsertOrgModelProvider,
  claimGptPiSandbox,
  mockPiCheckpointObjectStore,
  expectNoPiApiFirstTurnArtifacts,
  piS3Object,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

const PI_API_FIRST_TURN_USAGE_NAMESPACE =
  "26e1c547-485d-4438-bf6d-4b77959da0cb";

function piApiFirstTurnUsageEvents(
  runId: string,
  responseSourceId: string,
): readonly {
  readonly idempotencyKey: string;
  readonly category: string;
  readonly quantity: number;
}[] {
  return [
    { category: "tokens.input", quantity: 5 },
    { category: "tokens.output", quantity: 3 },
    { category: "tokens.cache_read", quantity: 3 },
    { category: "tokens.cache_creation", quantity: 2 },
  ].map((entry) => {
    return {
      ...entry,
      idempotencyKey: uuidv5(
        JSON.stringify([runId, responseSourceId, entry.category]),
        PI_API_FIRST_TURN_USAGE_NAMESPACE,
      ),
    };
  });
}

function expectApiKeyGptRequest(
  request: unknown,
  route: (typeof GPT_API_KEY_BDD_ROUTES)[number],
  secret: string,
  tier: "fast" | undefined,
): void {
  expect(request).toMatchObject({
    authorization: `Bearer ${secret}`,
    body: {
      model: route.runtimeModel,
      stream: true,
      store: false,
      reasoning: { effort: "max" },
    },
  });
  const { body } = z
    .object({ body: z.record(z.string(), z.unknown()) })
    .parse(request);
  expect(body.service_tier).toBe(tier === "fast" ? "priority" : undefined);
  expect(body).not.toHaveProperty("previous_response_id");
}

function expectApiKeyGptSandboxCarrier(
  claim: Awaited<ReturnType<typeof api.claimRunnerJob>>,
  route: (typeof GPT_API_KEY_BDD_ROUTES)[number],
  tier: "fast" | undefined,
): void {
  expect(claim.piModelConfig).toStrictEqual({
    schemaVersion: tier === undefined ? 2 : 3,
    ...(tier === undefined ? {} : { serviceTier: "priority" }),
    dialect: "openai-responses",
    transport: "sse",
    provider: route.piProvider,
    baseUrl: route.baseUrl,
    model: route.runtimeModel,
    ...(route.type === "vercel-ai-gateway-codex"
      ? { catalogModel: route.catalogModel }
      : {}),
    thinkingLevel: "max",
    credentialBindings: [
      {
        kind: "api-key",
        environment: "OPENAI_API_KEY",
        secretName: route.secretName,
      },
    ],
  });
  expect(claimEnvironment(claim)).toMatchObject({
    OPENAI_API_KEY: modelProviderSecretPlaceholder(
      route.type,
      route.secretName,
    ),
    OPENAI_MODEL: route.runtimeModel,
  });
  expect(claim.billableFirewalls).toStrictEqual([]);
  expect(claim.secretConnectorMap?.[route.secretName]).toBe(route.type);
  expect(claim.secretConnectorMetadataMap?.[route.secretName]).toStrictEqual({
    sourceType: "model-provider",
    sourceUserId: "__org__",
    metadataKey: route.type,
  });
}

describe("CHAT-02: model-first provider policies", () => {
  it.each(
    (
      [
        "deepseek-v4-flash",
        "deepseek-v4.1-flash",
        "deepseek-v4-pro",
        "gpt-5.6-terra",
      ] as const
    ).flatMap((selectedModel) => {
      return [false, true].map((usRoutingEnabled) => {
        return {
          selectedModel,
          usRoutingEnabled,
        };
      });
    }),
  )(
    "runs built-in $selectedModel OpenRouter Responses with US switch $usRoutingEnabled",
    async ({ selectedModel, usRoutingEnabled }) => {
      if (selectedModel === "deepseek-v4.1-flash") {
        configureNativeCliArtifact();
      }
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
        actor,
        selectedModel,
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.OpenRouterUsRouting]: usRoutingEnabled,
        },
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const modelRequests: unknown[] = [];
      server.use(
        http.post(
          `https://${usRoutingEnabled ? "us." : ""}openrouter.ai/api/v1/responses`,
          async ({ request }) => {
            modelRequests.push(await request.json());
            return new HttpResponse(
              piResponsesTextSse(
                `${selectedModel} OpenRouter Responses answer`,
                modelRequests.length,
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      const run = await withOpenRouterRoute(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            prompt: `run ${selectedModel} on its managed fallback`,
            model: selectedModel,
          },
          usagePricingResolution,
        );
      });
      await waitForRunStatus(actor, run.runId, "completed", 10_000);
      await flushWaitUntilForTest();

      expect(modelRequests).toStrictEqual([
        expect.objectContaining({
          model: `${selectedModel.startsWith("deepseek") ? "deepseek" : "openai"}/${selectedModel}`,
          store: false,
        }),
      ]);
      expect(modelRequests[0]).not.toHaveProperty("previous_response_id");
      await expect(
        readRunLaunchSnapshotFixture(context, run.runId),
      ).resolves.toMatchObject({ launch_snapshot: { framework: "pi" } });
      await expectPiApiUsage(run.runId, selectedModel, "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expect(claim.status).toBe(404);
    },
    90_000,
  );

  it.each([
    ...GPT_PI_BDD_MODELS.map((selectedModel) => {
      return {
        name: selectedModel,
        selectedModel,
        providerUrl: "https://api.openai.com/v1/responses",
      };
    }),
    {
      name: "DeepSeek V4.1 Flash",
      selectedModel: "deepseek-v4.1-flash",
      providerUrl: "https://api.deepseek.com/responses",
    },
    {
      name: "DeepSeek Flash",
      selectedModel: "deepseek-v4-flash",
      providerUrl: "https://api.deepseek.com/responses",
    },
  ] as const)(
    "keeps $name first-turn billing idempotent for matching usage identities",
    async ({ selectedModel, providerUrl }) => {
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      await configureBuiltInPiModel(actor, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();

      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!releaseProvider.settled()) {
          releaseProvider.resolve(undefined);
        }
      });
      let modelCalls = 0;
      server.use(
        http.post(providerUrl, async () => {
          modelCalls += 1;
          if (!providerEntered.settled()) {
            providerEntered.resolve(undefined);
          }
          await releaseProvider.promise;
          return new HttpResponse(
            piResponsesTextSse(`idempotent ${selectedModel} billing`, 0, {
              input_tokens: 10,
              output_tokens: 3,
              total_tokens: 13,
              input_tokens_details: {
                cached_tokens: 3,
                cache_write_tokens: 2,
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: `reuse matching ${selectedModel} billing identities`,
          model: selectedModel,
        },
        usagePricingResolution,
      );
      await providerEntered.promise;
      const usageEvents = piApiFirstTurnUsageEvents(run.runId, "resp_pi_api_0");
      const idempotencyKeys = usageEvents.map((event) => {
        return event.idempotencyKey;
      });
      onTestFinished(async () => {
        await deletePiApiFirstTurnUsageEventsFixture(idempotencyKeys);
      });
      // No production API can preseed first-turn billing identities before the
      // provider responds. This run-owned fixture creates the otherwise
      // unreachable retry state while the public chat API remains under test.
      await insertPiApiFirstTurnUsageEventsFixture({
        runId: run.runId,
        orgId,
        userId: actor.userId,
        provider: selectedModel,
        events: usageEvents,
      });

      releaseProvider.resolve(undefined);
      await waitForRunStatus(actor, run.runId, "completed");
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      await expectPiApiUsage(run.runId, selectedModel, "", {
        input: 5,
        output: 3,
        cacheRead: 3,
        cacheCreation: 2,
      });
    },
    90_000,
  );

  it.each([
    ...GPT_PI_BDD_MODELS.map((selectedModel) => {
      return {
        name: selectedModel,
        selectedModel,
        providerUrl: "https://api.openai.com/v1/responses",
      };
    }),
    {
      name: "DeepSeek V4.1 Flash",
      selectedModel: "deepseek-v4.1-flash",
      providerUrl: "https://api.deepseek.com/responses",
    },
    {
      name: "DeepSeek Pro",
      selectedModel: "deepseek-v4-pro",
      providerUrl: "https://api.deepseek.com/responses",
    },
  ] as const)(
    "fails $name first-turn billing on a conflicting usage identity",
    async ({ selectedModel, providerUrl }) => {
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      await configureBuiltInPiModel(actor, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();

      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!releaseProvider.settled()) {
          releaseProvider.resolve(undefined);
        }
      });
      let modelCalls = 0;
      server.use(
        http.post(providerUrl, async () => {
          modelCalls += 1;
          if (!providerEntered.settled()) {
            providerEntered.resolve(undefined);
          }
          await releaseProvider.promise;
          return new HttpResponse(
            piResponsesTextSse(`conflicting ${selectedModel} billing`, 0, {
              input_tokens: 10,
              output_tokens: 3,
              total_tokens: 13,
              input_tokens_details: {
                cached_tokens: 3,
                cache_write_tokens: 2,
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: `reject a conflicting ${selectedModel} billing identity`,
          model: selectedModel,
        },
        usagePricingResolution,
      );
      await providerEntered.promise;
      const usageEvents = piApiFirstTurnUsageEvents(run.runId, "resp_pi_api_0");
      const [expectedEvent] = usageEvents;
      if (!expectedEvent) {
        throw new Error(`Expected a ${selectedModel} billing identity fixture`);
      }
      onTestFinished(async () => {
        await deletePiApiFirstTurnUsageEventsFixture(
          usageEvents.map((event) => {
            return event.idempotencyKey;
          }),
        );
      });
      // No production API can preseed a conflicting first-turn billing identity
      // before the provider responds. This run-owned fixture creates that
      // otherwise unreachable state while the public chat API remains under test.
      await insertPiApiFirstTurnUsageEventsFixture({
        runId: run.runId,
        orgId,
        userId: actor.userId,
        provider: selectedModel,
        events: [{ ...expectedEvent, quantity: expectedEvent.quantity + 1 }],
      });

      releaseProvider.resolve(undefined);
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining("[PI_API_MODEL_FAILED]"),
      });
      // Public usage summaries omit unprocessed rows. Inspect this run's unique
      // rows only to prove the failed transaction added no partial billing data.
      await expect(readRunUsageEventsFixture(run.runId)).resolves.toStrictEqual(
        [
          expect.objectContaining({
            category: expectedEvent.category,
            provider: selectedModel,
            quantity: expectedEvent.quantity + 1,
          }),
        ],
      );
    },
    90_000,
  );

  it("resumes pre-migration OpenRouter Chat JSONL through API-first Responses", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const usagePricingResolution = await createGptUsagePricingResolution();
    const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
      actor,
      "gpt-5.6-terra",
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const modelRequests: unknown[] = [];
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/responses",
        async ({ request }) => {
          const requestIndex = modelRequests.length;
          modelRequests.push(await request.json());
          return new HttpResponse(
            piResponsesTextSse(
              requestIndex === 0
                ? "seed answer replaced by migration fixture"
                : "post-migration API answer",
              requestIndex,
              undefined,
              "default",
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
    const first = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          prompt: "seed the canonical Pi binding",
          model: "gpt-5.6-terra",
        },
        usagePricingResolution,
      );
    });
    await waitForRunStatus(actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    const legacy = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: first.threadId,
    });
    legacy.appendMessage({
      role: "user",
      content: "legacy API user context",
      timestamp: 1,
    });
    legacy.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "legacy API reasoning context" },
        { type: "text", text: "legacy API assistant context" },
        {
          type: "toolCall",
          id: "legacy_api_tool_call",
          name: "read",
          arguments: { path: "/home/user/workspace/AGENTS.md" },
        },
      ],
      api: "openai-completions",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    });
    legacy.appendMessage({
      role: "toolResult",
      toolCallId: "legacy_api_tool_call",
      toolName: "read",
      content: [{ type: "text", text: "legacy API tool output" }],
      isError: false,
      timestamp: 3,
    });
    legacy.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "legacy API tool conclusion" }],
      api: "openai-completions",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    const legacyJsonl = legacy.toJsonl();
    const legacyHash = await replacePiSessionHistoryJsonlFixture({
      runId: first.runId,
      jsonl: legacyJsonl,
    });
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${legacyHash}.blob`,
      Buffer.from(legacyJsonl, "utf8"),
    );

    const prompt = "continue the migrated OpenRouter session";
    const second = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt,
          model: "gpt-5.6-terra",
        },
        usagePricingResolution,
      );
    });
    await waitForRunStatus(actor, second.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    expect(modelRequests).toHaveLength(2);
    const resumedRequest = modelRequests[1];
    expect(resumedRequest).toMatchObject({ store: false });
    expect(resumedRequest).not.toHaveProperty("previous_response_id");
    const resumedInput = JSON.stringify(resumedRequest);
    for (const marker of [
      "legacy API user context",
      "legacy API reasoning context",
      "legacy API assistant context",
      "legacy API tool output",
      "legacy API tool conclusion",
      prompt,
    ]) {
      expect(occurrences(resumedInput, marker)).toBe(1);
    }
    const resumedSession = [...checkpointObjects.values()].find((bytes) => {
      return bytes.toString("utf8").includes("post-migration API answer");
    });
    if (!resumedSession) {
      throw new Error("Expected the migrated Responses H1 checkpoint");
    }
    const resumedJsonl = resumedSession.toString("utf8");
    for (const marker of [
      "legacy API reasoning context",
      "legacy API tool output",
      prompt,
      "post-migration API answer",
    ]) {
      expect(occurrences(resumedJsonl, marker)).toBe(1);
    }
    expect(
      MemoryPiSession.fromJsonl(resumedJsonl).hasPendingToolCalls(),
    ).toBeFalsy();
  }, 90_000);

  it.each(GPT_PI_BDD_MODELS)(
    "reuses one OpenRouter Responses Pi session across standard, fast, and long-context turns for %s",
    async (selectedModel) => {
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const longContextInputTokens =
        MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[selectedModel];
      if (longContextInputTokens === undefined) {
        throw new Error("Expected the Terra long-context pricing threshold");
      }
      const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
        actor,
        selectedModel,
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.CodexFastMode]: true,
        },
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const prompts = [
        "start standard Terra in the canonical Pi session",
        "continue fast Terra in the same Pi session",
        "continue long-context Terra in the same Pi session",
      ] as const;
      const answers = [
        "first standard Terra answer",
        "fast Terra answer",
        "long-context Terra answer",
      ] as const;
      const modelRequests: unknown[] = [];
      const observedTiers = ["default", "priority", "flex"] as const;
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/responses",
          async ({ request }) => {
            const requestIndex = modelRequests.length;
            modelRequests.push(await request.json());
            const answer = answers[requestIndex];
            if (!answer) {
              return HttpResponse.json(
                { error: "unexpected duplicate Terra request" },
                { status: 500 },
              );
            }
            return new HttpResponse(
              piResponsesTextSse(
                answer,
                requestIndex,
                requestIndex === 2
                  ? {
                      input_tokens: longContextInputTokens,
                      output_tokens: 3,
                      total_tokens: longContextInputTokens + 3,
                    }
                  : {
                      input_tokens: 10,
                      output_tokens: 3,
                      total_tokens: 13,
                      input_tokens_details: {
                        cached_tokens: 3,
                        cache_write_tokens: 2,
                      },
                    },
                observedTiers[requestIndex],
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      const first = await withOpenRouterRoute(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            prompt: prompts[0],
            model: selectedModel,
          },
          usagePricingResolution,
        );
      });
      await waitForRunStatus(actor, first.runId, "completed", 10_000);
      await flushWaitUntilForTest();
      const firstBinding = await readThreadSessionBinding(
        context,
        first.threadId,
      );
      if (!firstBinding.agent_session_id) {
        throw new Error(
          "Expected standard Terra to bind a canonical Pi session",
        );
      }

      const fast = await withOpenRouterRoute(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            threadId: first.threadId,
            prompt: prompts[1],
            model: selectedModel,
            runOptions: { codexServiceTier: "fast" },
          },
          usagePricingResolution,
        );
      });
      await waitForRunStatus(actor, fast.runId, "completed", 10_000);
      await flushWaitUntilForTest();
      const fastBinding = await readThreadSessionBinding(
        context,
        first.threadId,
      );
      expect(fastBinding.agent_session_id).toBe(firstBinding.agent_session_id);

      await chat.updateThreadModelSelection(
        actor,
        first.threadId,
        selectedModel,
        { codexServiceTier: null },
      );
      const returned = await withOpenRouterRoute(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            threadId: first.threadId,
            prompt: prompts[2],
            model: selectedModel,
          },
          usagePricingResolution,
        );
      });
      await waitForRunStatus(actor, returned.runId, "completed", 10_000);
      await flushWaitUntilForTest();
      const returnedBinding = await readThreadSessionBinding(
        context,
        first.threadId,
      );
      expect(returnedBinding.agent_session_id).toBe(
        firstBinding.agent_session_id,
      );
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstBinding.agent_session_id,
        conversation_run_id: returned.runId,
      });

      expect(modelRequests).toHaveLength(3);
      const requestTiers = modelRequests.map((body) => {
        return z
          .object({ service_tier: z.literal("priority").optional() })
          .passthrough()
          .parse(body).service_tier;
      });
      expect(requestTiers).toStrictEqual([undefined, "priority", undefined]);
      for (const body of modelRequests) {
        expect(body).toMatchObject({
          model: `openai/${selectedModel}`,
          reasoning: { effort: "max" },
          store: false,
        });
        expect(body).not.toHaveProperty("previous_response_id");
      }
      for (const [requestIndex, expectedTurns] of [
        [0, [prompts[0]]],
        [1, [prompts[0], answers[0], prompts[1]]],
        [2, [prompts[0], answers[0], prompts[1], answers[1], prompts[2]]],
      ] as const) {
        const input = JSON.stringify(modelRequests[requestIndex]);
        for (const turn of expectedTurns) {
          expect(occurrences(input, turn)).toBe(1);
        }
        expect(occurrences(input, answers[requestIndex])).toBe(0);
      }

      for (const run of [first, fast, returned]) {
        await expect(
          readRunLaunchSnapshotFixture(context, run.runId),
        ).resolves.toMatchObject({
          launch_snapshot: { framework: "pi" },
        });
        const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
        expect(claim.status).toBe(404);
      }
      for (const runId of [fast.runId, returned.runId]) {
        const run = await api.readRun(actor, runId);
        const appendSystemPrompt = run.appendSystemPrompt ?? "";
        expect(appendSystemPrompt).not.toContain("# Web Chat Run Context");
        for (const turn of [...prompts, ...answers]) {
          expect(appendSystemPrompt).not.toContain(turn);
        }
      }

      await expectPiApiUsage(first.runId, selectedModel, "", {
        input: 5,
        output: 3,
        cacheRead: 3,
        cacheCreation: 2,
      });
      await expectPiApiUsage(fast.runId, selectedModel, ".fast", {
        input: 5,
        output: 3,
        cacheRead: 3,
        cacheCreation: 2,
      });
      await expectPiApiUsage(returned.runId, selectedModel, ".long_context", {
        input: longContextInputTokens,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });

      const visibleTurns = [
        { runId: first.runId, prompt: prompts[0], answer: answers[0] },
        { runId: fast.runId, prompt: prompts[1], answer: answers[1] },
        { runId: returned.runId, prompt: prompts[2], answer: answers[2] },
      ];
      const finalEvents = await waitForThreadMessages(
        actor,
        first.threadId,
        (events) => {
          return eventBackedContents(events, returned.runId).some((event) => {
            return event.content === answers[2];
          });
        },
      );
      const runIds = new Set(
        visibleTurns.map((turn) => {
          return turn.runId;
        }),
      );
      expect(
        finalEvents.events
          .filter((event) => {
            return (
              event.runId !== undefined &&
              event.runId !== null &&
              runIds.has(event.runId) &&
              (event.eventType === "input.prompt" ||
                event.eventType === "output.message")
            );
          })
          .map((event) => {
            return {
              runId: event.runId,
              eventType: event.eventType,
              content: chatEventDisplayText(event),
            };
          }),
      ).toStrictEqual(
        visibleTurns.flatMap((turn) => {
          return [
            {
              runId: turn.runId,
              eventType: "input.prompt",
              content: turn.prompt,
            },
            {
              runId: turn.runId,
              eventType: "output.message",
              content: turn.answer,
            },
          ];
        }),
      );
      const sessionBlobs = [...checkpointObjects.entries()].filter(([key]) => {
        return key.includes("/blobs/");
      });
      expect(sessionBlobs.length).toBeGreaterThan(0);
      for (const [, bytes] of sessionBlobs) {
        expect(bytes.toString("utf8")).not.toContain("serviceTier");
      }
    },
    90_000,
  );

  it.each(GPT_PI_BDD_MODELS)(
    "bills managed OpenRouter priority only from the observed terminal Responses tier %s",
    async (selectedModel) => {
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
        actor,
        selectedModel,
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.CodexFastMode]: true,
        },
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const cases = [
        { observed: "priority", expectedSuffix: ".fast" },
        { observed: "fast", expectedSuffix: ".fast" },
        { observed: "default", expectedSuffix: "" },
        { observed: "flex", expectedSuffix: "" },
        { observed: null, expectedSuffix: "" },
        { observed: undefined, expectedSuffix: "" },
        { observed: "future-tier", expectedSuffix: "" },
      ] as const;
      const modelRequests: unknown[] = [];
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/responses",
          async ({ request }) => {
            const requestIndex = modelRequests.length;
            modelRequests.push(await request.json());
            const testCase = cases[requestIndex];
            if (!testCase) {
              return HttpResponse.json(
                { error: "unexpected duplicate OpenRouter request" },
                { status: 500 },
              );
            }
            return new HttpResponse(
              piResponsesTextSse(
                `OpenRouter tier answer ${requestIndex.toString()}`,
                requestIndex,
                undefined,
                testCase.observed,
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      for (const [index, testCase] of cases.entries()) {
        const run = await withOpenRouterRoute(async () => {
          return await sendChatRun(
            actor,
            {
              agentId,
              prompt: `observe OpenRouter tier case ${index.toString()}`,
              model: selectedModel,
              runOptions: { codexServiceTier: "fast" },
            },
            usagePricingResolution,
          );
        });
        await waitForRunStatus(actor, run.runId, "completed", 10_000);
        await flushWaitUntilForTest();
        await expectPiApiUsage(
          run.runId,
          selectedModel,
          testCase.expectedSuffix,
          { input: 5, output: 3, cacheRead: 0, cacheCreation: 0 },
        );
      }

      expect(modelRequests).toHaveLength(cases.length);
      for (const body of modelRequests) {
        expect(body).toMatchObject({
          model: `openai/${selectedModel}`,
          reasoning: { effort: "max" },
          service_tier: "priority",
          store: false,
        });
        expect(body).not.toHaveProperty("previous_response_id");
      }
    },
    90_000,
  );

  it.each(GPT_PI_BDD_MODELS)(
    "promotes queued fast %s through Pi API-first with priority",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the thread before queued fast Terra",
        model: "claude-sonnet-5",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

      await configureBuiltInPiModel(actor, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.CodexFastMode]: true,
        },
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const modelRequests: unknown[] = [];
      const prompt = "promote queued fast Terra through the callback";
      const answer = "queued fast Terra API-first answer";
      server.use(
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            modelRequests.push(await request.json());
            return new HttpResponse(piResponsesTextSse(answer, 0), {
              headers: { "content-type": "text/event-stream" },
            });
          },
        ),
      );

      const queuedId = randomUUID();
      const queued = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          prompt,
          clientEventId: queuedId,
          model: selectedModel,
          runOptions: { codexServiceTier: "fast" },
        },
        [201],
        { usagePricingResolution },
      );
      if (queued.status !== 201) {
        throw new Error("Expected queued fast Terra to enter the chat queue");
      }
      expect(queued.body.runId).toBeNull();

      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await flushWaitUntilForTest();
      const messages = await waitForThreadMessages(
        actor,
        anchor.threadId,
        (events) => {
          return userMessages(events).some((event) => {
            return (
              event.revokesEventId === queuedId &&
              typeof event.runId === "string"
            );
          });
        },
      );
      const promoted = userMessages(messages.events).find((event) => {
        return event.revokesEventId === queuedId;
      });
      if (!promoted?.runId) {
        throw new Error("Expected queued fast Terra to create a run");
      }
      const promotedRunId = promoted.runId;
      await waitForRunStatus(actor, promotedRunId, "completed", 10_000);

      expect(modelRequests).toHaveLength(1);
      const request = z
        .object({ service_tier: z.literal("priority") })
        .passthrough()
        .parse(modelRequests[0]);
      expect(request.service_tier).toBe("priority");
      expect(request).toMatchObject({
        model: selectedModel,
        reasoning: { effort: "max" },
      });
      expect(occurrences(JSON.stringify(request), prompt)).toBe(1);
      await expect(
        readRunLaunchSnapshotFixture(context, promotedRunId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: "pi" },
      });
      const claim = await api.requestClaimRunnerJob(true, promotedRunId, [404]);
      expect(claim.status).toBe(404);
      await expectPiApiUsage(promotedRunId, selectedModel, ".fast", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      const finalEvents = await waitForThreadMessages(
        actor,
        anchor.threadId,
        (events) => {
          return eventBackedContents(events, promotedRunId).some((event) => {
            return event.content === answer;
          });
        },
      );
      expect(
        eventBackedContents(finalEvents.events, promotedRunId).filter(
          (event) => {
            return event.content === answer;
          },
        ),
      ).toHaveLength(1);
    },
    90_000,
  );

  it("routes DeepSeek V4 Flash through the native Responses adapter", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "deepseek",
      secret: "selected-deepseek-responses-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-flash",
        isDefault: true,
        defaultProviderType: "deepseek",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with DeepSeek Responses",
      model: "deepseek-v4-flash",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);

    expect(claim.cliAgentType).toBe("codex");
    expect(environment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(environment.OPENAI_BASE_URL).toBe("https://api.deepseek.com/");
    expect(environment.OPENAI_MODEL).toBe("deepseek-v4-flash");
    expect(environment.ANTHROPIC_MODEL).toBeUndefined();
    expect(claim.codexRuntimeConfig).toMatchObject({
      providerId: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/",
      envKey: "OPENAI_API_KEY",
      requiresOpenaiAuth: false,
      wireApi: "responses",
      supportsWebsockets: false,
      modelCatalog: {
        models: expect.arrayContaining([
          expect.objectContaining({
            slug: "deepseek-v4-flash",
            default_reasoning_level: "high",
          }),
          expect.objectContaining({
            slug: "deepseek-v4-pro",
            default_reasoning_level: "high",
          }),
        ]),
      },
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      cliAgentType: "codex",
    });

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "continue with DeepSeek Responses",
    });
    const { claim: followUpClaim } = await claimChatRun(
      runnerGroup,
      followUp.runId,
    );
    const followUpEnvironment = claimEnvironment(followUpClaim);
    expect(followUpClaim.cliAgentType).toBe("codex");
    expect(followUpClaim.resumeSession?.sessionId).toBe(`bdd-cli-${run.runId}`);
    expect(followUpClaim.codexRuntimeConfig?.providerId).toBe("deepseek");
    expect(followUpEnvironment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(followUpEnvironment.OPENAI_BASE_URL).toBe(
      "https://api.deepseek.com/",
    );
    expect(followUpEnvironment.OPENAI_MODEL).toBe("deepseek-v4-flash");

    await cancelChatRun(actor, followUp.runId);
  });

  it.each([
    {
      name: "DeepSeek",
      model: "deepseek-v4-flash",
      providerType: "deepseek",
    },
  ] as const)(
    "keeps direct $name BYOK on Codex while PiLoop is disabled",
    async ({ model, providerType }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const orgId = requireOrgId(actor);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: false },
      );
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: providerType,
        secret: `selected-${model}-pi-disabled-key`,
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

      const run = await sendChatRun(actor, {
        agentId,
        prompt: `keep direct ${model} on the standard runtime`,
        model,
      });
      await flushWaitUntilForTest();
      const claimed = await claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim.cliAgentType).toBe("codex");
      expect(claimed.claim.piLaunchConfig).toBeUndefined();
      await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    },
    30_000,
  );

  it.each(
    GPT_API_KEY_BDD_ROUTES.flatMap((route) => {
      return [
        { ...route, tier: undefined, generation: 2, outcome: "completed" },
        { ...route, tier: "fast", generation: 3, outcome: "completed" },
        { ...route, tier: "fast", generation: 3, outcome: "failed" },
        { ...route, tier: "fast", generation: 3, outcome: "cancelled" },
      ] as const;
    }),
  )(
    "runs $name API-key $tier through API-first and generation-$generation Sandbox with $outcome and credential rotation",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const firewall = createFirewallApi(context);
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const initialSecret = `${route.type}-initial-secret`;
      const providerId = await configureApiKeyGptPiModel(
        actor,
        route,
        initialSecret,
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const providerRequests: {
        readonly authorization: string | null;
        readonly body: unknown;
      }[] = [];
      server.use(
        http.post(route.endpoint, async ({ request }) => {
          const sequence = providerRequests.length;
          providerRequests.push({
            authorization: request.headers.get("authorization"),
            body: await request.json(),
          });
          const responseBody = piResponsesContentSse({
            blocks:
              sequence === 0
                ? [
                    {
                      type: "toolCall",
                      callId: `call_${route.type.replaceAll("-", "_")}`,
                      name: "bash",
                      arguments: { command: "okou --help" },
                    },
                  ]
                : [
                    {
                      type: "text",
                      text: `${route.name} API answer ${sequence}`,
                    },
                  ],
            sequence,
          });
          return new HttpResponse(responseBody, {
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );

      const firstPrompt = `use ${route.name} Terra and hand off one tool`;
      const first = await sendChatRun(actor, {
        agentId,
        prompt: firstPrompt,
        model: route.selectedModel,
        runOptions: { codexServiceTier: route.tier },
      });
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${first.runId}/manifest.json`;
      const sessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${first.runId}/session.jsonl`;
      await expect
        .poll(() => {
          return checkpointObjects.has(manifestKey);
        })
        .toBe(true);
      await flushWaitUntilForTest();
      expect(providerRequests).toStrictEqual([
        {
          authorization: `Bearer ${initialSecret}`,
          body: expect.objectContaining({
            model: route.runtimeModel,
            store: false,
            stream: true,
          }),
        },
      ]);
      expect(providerRequests[0]?.body).not.toHaveProperty(
        "previous_response_id",
      );
      await expectNoBuiltInModelUsage(first.runId);

      await api.heartbeatRunner(runnerGroup);
      const claim = await claimGptPiSandbox(actor, first.runId, route.tier);
      const sandboxHeaders = {
        authorization: `Bearer ${claim.sandboxToken}`,
      };
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piSessionId).toBe(first.threadId);
      expectApiKeyGptSandboxCarrier(claim, route, route.tier);
      expect(JSON.stringify(claim)).not.toContain(initialSecret);
      if (!claim.encryptedSecrets) {
        throw new Error("Expected API-key Terra claim credentials");
      }
      const sandboxCredential = await firewall.requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: {
            Authorization: `Bearer ${secretTemplate(route.secretName)}`,
          },
          secretConnectorMap: claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (sandboxCredential.status !== 200) {
        throw new Error("Expected exact API-key Terra firewall credential");
      }
      expect(sandboxCredential.body.headers.Authorization).toBe(
        `Bearer ${initialSecret}`,
      );
      expect(sandboxCredential.body.resolvedSecrets).toStrictEqual([
        route.secretName,
      ]);

      const manifestBytes = checkpointObjects.get(manifestKey);
      const h1Bytes = checkpointObjects.get(sessionKey);
      if (!manifestBytes || !h1Bytes) {
        throw new Error("Expected API-key Terra ownership-transfer artifacts");
      }
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(manifestBytes.toString("utf8")),
      );
      const h2Session = MemoryPiSession.fromJsonl(h1Bytes.toString("utf8"));
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
      if (!pendingTool || pendingTool.type !== "toolCall") {
        throw new Error("Expected API-key Terra tool call in H1");
      }
      const sandboxToolResult = `${route.name} sandbox tool output`;
      const sandboxAnswer = `${route.name} Sandbox completion`;
      h2Session.appendMessage({
        role: "toolResult",
        toolCallId: pendingTool.id,
        toolName: pendingTool.name,
        content: [{ type: "text", text: sandboxToolResult }],
        details: {},
        isError: false,
        timestamp: 2,
      });
      h2Session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: sandboxAnswer }],
        api: "openai-responses",
        provider: route.piProvider,
        model: route.runtimeModel,
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
      expect(h1Bytes.toString("utf8")).not.toMatch(/serviceTier|service_tier/);
      expect(h1Bytes.toString("utf8")).not.toContain(initialSecret);
      const h2 = h2Session.toJsonl();
      expect(h2).not.toMatch(/serviceTier|service_tier/);
      const h2Hash = createHash("sha256").update(h2).digest("hex");
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: first.runId,
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
      const sandboxEventSequenceStart = manifest.sandboxEventSequenceStart;
      await webhooks.requestAgentEvents(
        {
          runId: first.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: sandboxEventSequenceStart,
              message: {
                content: [{ type: "text", text: sandboxAnswer }],
              },
            },
            {
              type: "result",
              sequenceNumber: sandboxEventSequenceStart + 1,
              result: sandboxAnswer,
            },
          ],
        },
        sandboxHeaders,
        [200],
      );
      if (route.outcome === "cancelled") {
        await cancelChatRun(actor, first.runId);
      }
      await webhooks.requestAgentComplete(
        {
          runId: first.runId,
          exitCode: route.outcome === "failed" ? 1 : 0,
          ...(route.outcome === "failed"
            ? { error: "API-key Sandbox failed" }
            : {}),
          lastEventSequence: sandboxEventSequenceStart + 1,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: first.threadId,
            cliAgentSessionHistoryHash: h2Hash,
          },
        },
        sandboxHeaders,
        route.outcome === "cancelled" ? [400] : [200],
      );
      await waitForRunStatus(actor, first.runId, route.outcome);
      await flushWaitUntilForTest();
      await webhooks.requestAgentComplete(
        { runId: first.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      expect(providerRequests).toHaveLength(1);
      expectApiKeyGptRequest(
        providerRequests[0],
        route,
        initialSecret,
        route.tier,
      );
      await expectNoBuiltInModelUsage(first.runId);
      const terminal = await api.readRun(actor, first.runId);
      expect(terminal).toMatchObject({ status: route.outcome });
      expect(
        JSON.stringify({
          terminal,
          events: (await chat.listThreadEvents(actor, first.threadId)).events,
          h2,
        }),
      ).not.toContain(initialSecret);
      if (route.outcome !== "completed") {
        return;
      }
      const firstSession = await readThreadSessionConversation(
        context,
        first.threadId,
      );

      const followUpPrompt = `continue the same ${route.name} credential`;
      const followUp = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: followUpPrompt,
        model: route.selectedModel,
        runOptions: { codexServiceTier: route.tier },
      });
      await waitForRunStatus(actor, followUp.runId, "completed");
      await flushWaitUntilForTest();
      expect(providerRequests).toHaveLength(2);
      expectApiKeyGptRequest(
        providerRequests[1],
        route,
        initialSecret,
        route.tier,
      );
      expect(providerRequests[1]).toMatchObject({
        authorization: `Bearer ${initialSecret}`,
        body: {
          model: route.runtimeModel,
          store: false,
          stream: true,
        },
      });
      expect(JSON.stringify(providerRequests[1]?.body)).toContain(
        sandboxToolResult,
      );
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
      });
      await expectNoBuiltInModelUsage(followUp.runId);

      const rotatedSecret = `${route.type}-rotated-secret`;
      const rotatedAt = now() + 1000;
      const rotated = await withMockNowForTest(rotatedAt, async () => {
        const updated = await upsertOrgModelProvider(actor, {
          type: route.type,
          secret: rotatedSecret,
        });
        expect(updated.providerId).toBe(providerId);
        return await sendChatRun(actor, {
          agentId,
          threadId: first.threadId,
          prompt: `continue after rotating the ${route.name} credential`,
          model: route.selectedModel,
          runOptions: { codexServiceTier: route.tier },
        });
      });
      await waitForRunStatus(actor, rotated.runId, "completed");
      await flushWaitUntilForTest();
      expect(providerRequests).toHaveLength(3);
      expectApiKeyGptRequest(
        providerRequests[2],
        route,
        rotatedSecret,
        route.tier,
      );
      expect(providerRequests[2]).toMatchObject({
        authorization: `Bearer ${rotatedSecret}`,
        body: {
          model: route.runtimeModel,
          store: false,
          stream: true,
        },
      });
      const rotatedBody = JSON.stringify(providerRequests[2]?.body);
      expect(occurrences(rotatedBody, firstPrompt)).toBe(1);
      expect(occurrences(rotatedBody, sandboxAnswer)).toBe(1);
      expect(occurrences(rotatedBody, followUpPrompt)).toBe(1);
      expect(rotatedBody).toContain(sandboxToolResult);
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
      });
      await expectNoBuiltInModelUsage(rotated.runId);
      const publicState = JSON.stringify({
        run: await api.readRun(actor, rotated.runId),
        events: (await chat.listThreadEvents(actor, first.threadId)).events,
      });
      expect(publicState).not.toContain(initialSecret);
      expect(publicState).not.toContain(rotatedSecret);
      const histories = [...checkpointObjects].filter(([key]) => {
        return key.endsWith(".blob") || key.endsWith(".jsonl");
      });
      expect(histories).not.toHaveLength(0);
      for (const [, value] of histories) {
        const jsonl = value.toString("utf8");
        expect(jsonl).not.toMatch(/serviceTier|service_tier/);
        expect(jsonl).not.toContain(initialSecret);
        expect(jsonl).not.toContain(rotatedSecret);
      }
    },
    90_000,
  );

  it.each(GPT_API_KEY_BDD_ROUTES)(
    "fails closed when the admitted $name Fast credential disappears before provider ownership",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const secret = `${route.type}-deleted-secret`;
      await configureApiKeyGptPiModel(actor, route, secret);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const objects = mockPiCheckpointObjectStore();
      const providerRequests: string[] = [];
      server.use(
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          const objectKey = new URL(request.url).searchParams.get("object");
          if (!objectKey) {
            throw new Error("Expected Pi resource archive identity");
          }
          return new HttpResponse(piS3Object(objectKey), {
            headers: { "content-type": "application/gzip" },
          });
        }),
        ...USER_OWNED_GPT_FAST_BDD_ROUTES.map((candidate) => {
          return http.post(candidate.endpoint, ({ request }) => {
            providerRequests.push(request.url);
            return new HttpResponse(
              piResponsesTextSse(
                "unexpected provider owner",
                providerRequests.length,
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "keep captured Fast credentials authoritative",
        runOptions: { codexServiceTier: "fast" },
      });
      await entered.promise;
      await accept(
        setupApp({ context, routes: modelProvidersRoutes })(
          modelProvidersByTypeContract,
        ).delete({
          headers: sessionHeaders(actor),
          params: { type: route.type },
        }),
        [204],
      );
      release.resolve(undefined);
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      const failed = await api.readRun(actor, run.runId);
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringContaining("[PI_API_MODEL_CREDENTIAL_INVALID]"),
      });
      expect(providerRequests).toStrictEqual([]);
      await expectNoBuiltInModelUsage(run.runId);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expectApiError(claim.body);
      const publicState = JSON.stringify({
        failed,
        events: (await chat.listThreadEvents(actor, run.threadId)).events,
        histories: [...objects.values()].map((value) => {
          return value.toString("utf8");
        }),
      });
      expect(publicState).not.toContain(secret);
      expect(
        objects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
    },
    90_000,
  );

  it.each(GPT_API_KEY_BDD_ROUTES)(
    "keeps rejected $name API-key Fast single-owner, redacted, and unbilled",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const secret = `${route.type}-rejected-secret`;
      const privateDiagnostic = "private-provider-rejection-details";
      await configureApiKeyGptPiModel(actor, route, secret);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        url: string;
        authorization: string | null;
        body: unknown;
      }[] = [];
      server.use(
        ...USER_OWNED_GPT_FAST_BDD_ROUTES.map((candidate) => {
          return http.post(candidate.endpoint, async ({ request }) => {
            requests.push({
              url: request.url,
              authorization: request.headers.get("authorization"),
              body: await readCodexRequestJson(request),
            });
            return HttpResponse.json(
              {
                error: {
                  code: "invalid_api_key",
                  message: `${privateDiagnostic} ${secret}`,
                },
              },
              { status: 401 },
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "fail the captured API-key Fast request once",
        runOptions: { codexServiceTier: "fast" },
      });
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(route.endpoint);
      expectApiKeyGptRequest(requests[0], route, secret, "fast");
      const failed = await api.readRun(actor, run.runId);
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringContaining("[PI_API_MODEL_FAILED]"),
      });
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      const publicState = JSON.stringify({
        failed,
        events,
        histories: [...objects.values()].map((value) => {
          return value.toString("utf8");
        }),
      });
      expect(publicState).not.toContain(secret);
      expect(publicState).not.toContain(privateDiagnostic);
      await expectNoBuiltInModelUsage(run.runId);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expectApiError(claim.body);
      expect(requests).toHaveLength(1);
    },
    90_000,
  );
});
