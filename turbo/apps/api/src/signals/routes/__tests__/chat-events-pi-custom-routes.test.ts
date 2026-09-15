import { createHash, randomUUID } from "node:crypto";
import { MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS } from "@okouai/api-contracts/contracts/model-price-tiers";
import { modelProviderConnectionsByIdContract } from "@okouai/api-contracts/contracts/model-provider-gateways";
import {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  getProviderRuntimeModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  DEFAULT_PROFILE,
  piApiFirstTurnManifestSchema,
} from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { holdAgentRunPiExecutionSnapshotFixture } from "../../../test-fixtures/thread-bound-run-admission";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  readRunLaunchSnapshotFixture,
  readThreadSessionConversation,
} from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  GPT_PI_BDD_MODELS,
  USER_OWNED_GPT_FAST_BDD_ROUTES,
  type PiApiFirstTurnUsageProvider,
  requireOrgId,
  expectPiApiUsage,
  expectNoBuiltInModelUsage,
  createGptUsagePricingResolution,
  createPiApiFirstTurnUsagePricingResolution,
  claimEnvironment,
  userMessages,
  eventBackedContents,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
  occurrences,
} from "./helpers/chat-events-fixture";
import {
  piResponsesTextSse,
  piResponsesContentSse,
  nativeCodexSseResponse,
  readCodexRequestJson,
} from "./helpers/pi-responses";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  chatCallbacks,
  authDeviceSupport,
  entitledChatActor,
  configureBuiltInPiModel,
  configureBuiltInPiModelOnOpenRouter,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  modelProviderConnectionsClient,
  sessionHeaders,
  cancelBeforeLatePiResult,
  mockPiCheckpointObjectStore,
  expectNoPiApiFirstTurnArtifacts,
  piS3Object,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

async function expectPiApiFirstTurnUsage(
  runId: string,
  sessionBytes: Buffer,
  provider: PiApiFirstTurnUsageProvider,
): Promise<void> {
  const firstSession = MemoryPiSession.fromJsonl(sessionBytes.toString("utf8"));
  const firstAssistant = [...firstSession.buildSessionContext().messages]
    .reverse()
    .find((message) => {
      return message.role === "assistant";
    });
  expect(
    firstAssistant?.role === "assistant" ? firstAssistant.usage : null,
  ).toMatchObject({
    input: 5,
    output: 3,
    cacheRead: 3,
    cacheWrite: 2,
  });
  await expectPiApiUsage(runId, provider, "", {
    input: 5,
    output: 3,
    cacheRead: 3,
    cacheCreation: 2,
  });
}

async function configureCustomPiModel(
  actor: ApiTestUser,
  selectedModel: SupportedRunModel,
  upstreamModel = `company-${selectedModel}-production`,
) {
  if (selectedModel === "deepseek-v4.1-flash") {
    configureNativeCliArtifact();
  }
  const secret = "custom-pi-gateway-secret";
  const surface = {
    protocol: "openai-responses" as const,
    apiBaseUrl: "https://pi-custom-gateway.example.com/openai/v1",
    authHeaderName: "x-api-key",
    authHeaderTemplate: "Key {{secret}}",
    modelMappings: { [selectedModel]: upstreamModel },
  };
  const created = await accept(
    modelProviderConnectionsClient().create({
      headers: sessionHeaders(actor),
      body: {
        displayName: `Pi custom gateway for ${selectedModel}`,
        secret,
        surfaces: [surface],
      },
    }),
    [201],
  );
  const surfaceId = created.body.surfaces[0]?.id;
  if (!surfaceId) {
    throw new Error("Expected the custom Pi gateway to have a surface");
  }
  await api.updateOrgModelPolicies(actor, [
    {
      model: selectedModel,
      isDefault: true,
      defaultProviderType: "custom-openai-responses",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
    },
  ]);
  await authDeviceSupport.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PiLoop]: true,
    [FeatureSwitchKey.CodexFastMode]: true,
  });
  return {
    connection: created.body,
    surfaceId,
    surface,
    secret,
    upstreamModel,
    endpoint: `${surface.apiBaseUrl}/responses`,
  };
}

/** S3 reads issued so far, used to prove the API never downloads an archive. */
function s3GetObjectCommandCalls(): readonly unknown[] {
  return context.mocks.s3.send.mock.calls.filter(([command]) => {
    return (
      (command as { readonly constructor?: { readonly name?: string } })
        .constructor?.name === "GetObjectCommand"
    );
  });
}

describe("CHAT-02: model-first provider policies", () => {
  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return (["openai", "openrouter"] as const).map((provider) => {
        return {
          selectedModel,
          provider,
        };
      });
    }),
  )(
    "bills built-in $selectedModel on $provider at both canonical input boundaries and tiers",
    async ({ selectedModel, provider }) => {
      const { actor, agentId } = await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      const threshold =
        MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[selectedModel];
      if (threshold === undefined) {
        throw new Error(
          `Expected a long-context threshold for ${selectedModel}`,
        );
      }
      let withRoute = async <T>(work: () => Promise<T>): Promise<T> => {
        return await work();
      };
      if (provider === "openrouter") {
        withRoute = await configureBuiltInPiModelOnOpenRouter(
          actor,
          selectedModel,
        );
      } else {
        await configureBuiltInPiModel(actor, selectedModel);
      }
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.CodexFastMode]: true,
      });
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const endpoint =
        provider === "openai"
          ? "https://api.openai.com/v1/responses"
          : "https://openrouter.ai/api/v1/responses";
      const upstreamModel =
        provider === "openai" ? selectedModel : `openai/${selectedModel}`;
      const requests: unknown[] = [];
      for (const tier of [undefined, "fast"] as const) {
        for (const totalInput of [threshold - 1, threshold]) {
          server.use(
            http.post(endpoint, async ({ request }) => {
              requests.push(await request.json());
              return nativeCodexSseResponse(
                piResponsesTextSse(
                  "accounted response",
                  requests.length,
                  {
                    input_tokens: totalInput,
                    output_tokens: 3,
                    total_tokens: totalInput + 3,
                    input_tokens_details: {
                      cached_tokens: 3,
                      cache_write_tokens: 2,
                    },
                  },
                  tier === "fast" ? "priority" : "default",
                ),
              );
            }),
          );
          const run = await withRoute(async () => {
            return await sendChatRun(
              actor,
              {
                agentId,
                prompt: `bill ${selectedModel} at ${totalInput} total input`,
                model: selectedModel,
                runOptions: { codexServiceTier: tier },
              },
              usagePricingResolution,
            );
          });
          await waitForRunStatus(actor, run.runId, "completed");
          await flushWaitUntilForTest();
          const longContext = totalInput === threshold;
          const suffix = longContext
            ? tier === "fast"
              ? ".long_context.fast"
              : ".long_context"
            : tier === "fast"
              ? ".fast"
              : "";
          await expectPiApiUsage(run.runId, selectedModel, suffix, {
            input: totalInput - 5,
            output: 3,
            cacheRead: 3,
            cacheCreation: 2,
          });
          expect(requests.at(-1)).toMatchObject({
            model: upstreamModel,
            reasoning: { effort: "max" },
            store: false,
          });
          if (tier === undefined) {
            expect(requests.at(-1)).not.toHaveProperty("service_tier");
          } else {
            expect(requests.at(-1)).toMatchObject({ service_tier: "priority" });
          }
          await expect(
            readRunLaunchSnapshotFixture(context, run.runId),
          ).resolves.toMatchObject({ launch_snapshot: { framework: "pi" } });
        }
      }
      expect(requests).toHaveLength(4);
    },
    90_000,
  );

  it.each([
    "deepseek-v4-flash",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    ...GPT_PI_BDD_MODELS,
  ] as const)(
    "runs the Pi API first turn once for %s and resumes canonical JSONL",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      const orgId = actor.orgId;
      if (!orgId) {
        throw new Error("Expected entitled chat actor to have an org");
      }
      await configureBuiltInPiModel(actor, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.Effort]: true,
        },
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const modelRequests: {
        readonly body: unknown;
      }[] = [];
      const modelAnswers = [
        `first API answer for ${selectedModel}`,
        `second API answer for ${selectedModel}`,
      ];
      const providerUrl = selectedModel.startsWith("gpt-")
        ? "https://api.openai.com/v1/responses"
        : "https://api.deepseek.com/responses";
      server.use(
        http.post(providerUrl, async ({ request }) => {
          const sequence = modelRequests.length;
          modelRequests.push({
            body: await request.json(),
          });
          const answer = modelAnswers[sequence];
          if (!answer) {
            return HttpResponse.json(
              { error: "unexpected duplicate Pi model request" },
              { status: 500 },
            );
          }
          const usage =
            sequence === 0
              ? {
                  input_tokens: 10,
                  output_tokens: 3,
                  total_tokens: 13,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                }
              : undefined;
          return new HttpResponse(
            usage
              ? piResponsesTextSse(answer, sequence, usage)
              : piResponsesTextSse(answer, sequence),
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        }),
      );
      const firstPrompt = "persist this turn in the native Pi session";
      const first = await sendChatRun(
        actor,
        {
          agentId,
          prompt: firstPrompt,
          model: selectedModel,
          ...(selectedModel === "deepseek-v4.1-flash"
            ? {}
            : { runOptions: { reasoningEffort: "max" } }),
        },
        usagePricingResolution,
      );
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      await expect(
        readRunLaunchSnapshotFixture(context, first.runId),
      ).resolves.toStrictEqual({
        exists: true,
        launch_snapshot: {
          schemaVersion: 3,
          framework: "pi",
          runnerProfile: DEFAULT_PROFILE,
        },
      });
      expect(modelRequests).toHaveLength(1);
      expect(modelRequests[0]?.body).toMatchObject({
        model: getProviderRuntimeModel("built-in", selectedModel),
        reasoning: {
          effort: selectedModel === "deepseek-v4.1-flash" ? "high" : "max",
        },
      });
      const firstModelInput = JSON.stringify(modelRequests[0]?.body);
      expect(occurrences(firstModelInput, firstPrompt)).toBe(1);
      expect(occurrences(firstModelInput, modelAnswers[0] ?? "")).toBe(0);
      // The first GET validates the just-written native H1 before canonical
      // checkpoint promotion; there is no H0 to download on a new thread.
      expect(s3GetObjectCommandCalls()).toHaveLength(1);
      const firstManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${first.runId}/manifest.json`;
      const firstSessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${first.runId}/session.jsonl`;
      const firstSessionEntry = [...checkpointObjects.entries()].find(
        ([key]) => {
          return key.includes("/blobs/");
        },
      );
      const firstSessionBytes = firstSessionEntry?.[1];
      expect(checkpointObjects.has(firstManifestKey)).toBeFalsy();
      expect(checkpointObjects.has(firstSessionKey)).toBeFalsy();
      if (!firstSessionBytes) {
        throw new Error("Expected the first Pi run to persist native H1");
      }
      await expectPiApiFirstTurnUsage(
        first.runId,
        firstSessionBytes,
        selectedModel,
      );
      expect(firstSessionBytes.toString("utf8")).toContain(first.threadId);
      expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
        `runner-group:${runnerGroup}`,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
        runId: first.runId,
        mode: "hard",
      });
      const firstClaim = await api.requestClaimRunnerJob(
        true,
        first.runId,
        [404],
      );
      expect(firstClaim.status).toBe(404);

      await chat.updateThreadModelSelection(
        actor,
        first.threadId,
        selectedModel,
        selectedModel === "deepseek-v4.1-flash"
          ? {}
          : { reasoningEffort: "high" },
      );
      const secondPrompt = "continue the same Pi session";
      const second = await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt: secondPrompt,
        },
        usagePricingResolution,
      );
      await waitForRunStatus(actor, second.runId, "completed");
      await flushWaitUntilForTest();
      expect(modelRequests).toHaveLength(2);
      expect(modelRequests[1]?.body).toMatchObject({
        reasoning: { effort: "high" },
      });
      const metadata = await chat.readThreadMetadata(actor, first.threadId);
      if (selectedModel === "deepseek-v4.1-flash") {
        expect(metadata.modelSettings).not.toHaveProperty(selectedModel);
      } else {
        expect(metadata.modelSettings).toMatchObject({
          [selectedModel]: { effort: "high" },
        });
      }
      await expectPiApiUsage(second.runId, selectedModel, "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      const secondModelInput = JSON.stringify(modelRequests[1]?.body);
      expect(occurrences(secondModelInput, firstPrompt)).toBe(1);
      expect(occurrences(secondModelInput, modelAnswers[0] ?? "")).toBe(1);
      expect(occurrences(secondModelInput, secondPrompt)).toBe(1);
      expect(occurrences(secondModelInput, modelAnswers[1] ?? "")).toBe(0);
      // Follow-up adds one H0 restore and one strict H1 promotion check.
      expect(s3GetObjectCommandCalls()).toHaveLength(3);
      const secondManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`;
      expect(checkpointObjects.has(secondManifestKey)).toBeFalsy();
      expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
        runId: second.runId,
        mode: "hard",
      });
      const secondClaim = await api.requestClaimRunnerJob(
        true,
        second.runId,
        [404],
      );
      expect(secondClaim.status).toBe(404);
    },
    90_000,
  );

  it.each([
    {
      selectedModel: "deepseek-v4.1-flash",
      upstreamModel: "company-deepseek-v41-production",
    },
    {
      selectedModel: "deepseek-v4-flash",
      upstreamModel: "company-deepseek-flash-production",
    },
    {
      selectedModel: "deepseek-v4-pro",
      upstreamModel: "company-deepseek-pro-production",
    },
    ...GPT_PI_BDD_MODELS.map((selectedModel) => {
      return {
        selectedModel,
        upstreamModel: `company-${selectedModel}-production`,
      };
    }),
  ] as const)(
    "runs custom Responses gateway $selectedModel through Pi without built-in model billing",
    async ({ selectedModel, upstreamModel }) => {
      const { actor, agentId } = await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      await configureCustomPiModel(actor, selectedModel, upstreamModel);
      if (selectedModel === "deepseek-v4-pro") {
        // Snapshot availability must not block an admitted Pi provider request.
        context.mocks.axiom.ingest.mockImplementation((dataset) => {
          if (dataset === "run-context") {
            throw new Error("run-context ingest failed");
          }
          return true;
        });
      }
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const modelRequests: {
        readonly body: unknown;
        readonly authorization: string | null;
        readonly apiKey: string | null;
      }[] = [];
      server.use(
        http.post(
          "https://pi-custom-gateway.example.com/openai/v1/responses",
          async ({ request }) => {
            modelRequests.push({
              body: await request.json(),
              authorization: request.headers.get("authorization"),
              apiKey: request.headers.get("x-api-key"),
            });
            return new HttpResponse(
              piResponsesTextSse(
                `custom gateway answer for ${selectedModel}`,
                modelRequests.length - 1,
                {
                  input_tokens: 10,
                  output_tokens: 3,
                  total_tokens: 13,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                },
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: `route ${selectedModel} through the custom Pi gateway`,
          model: selectedModel,
        },
        usagePricingResolution,
      );
      await flushWaitUntilForTest();
      await waitForRunStatus(actor, run.runId, "completed");

      await expect(
        readRunLaunchSnapshotFixture(context, run.runId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: "pi" },
      });
      expect(modelRequests).toStrictEqual([
        {
          body: expect.objectContaining({
            model: upstreamModel,
            ...(selectedModel.startsWith("gpt-")
              ? { reasoning: expect.objectContaining({ effort: "max" }) }
              : {}),
          }),
          authorization: null,
          apiKey: "Key custom-pi-gateway-secret",
        },
      ]);
      expect(modelRequests[0]?.body).not.toHaveProperty("service_tier");
      await expectNoBuiltInModelUsage(run.runId);
      if (selectedModel.startsWith("gpt-")) {
        const firstSession = await readThreadSessionConversation(
          context,
          run.threadId,
        );
        for (const tier of ["fast", undefined] as const) {
          await chat.updateThreadModelSelection(
            actor,
            run.threadId,
            selectedModel,
            {
              codexServiceTier: tier ?? null,
            },
          );
          const continuation = await sendChatRun(
            actor,
            {
              agentId,
              threadId: run.threadId,
              model: selectedModel,
              prompt: `continue the custom session with ${tier ?? "standard"}`,
              runOptions: { codexServiceTier: tier },
            },
            usagePricingResolution,
          );
          await flushWaitUntilForTest();
          await waitForRunStatus(actor, continuation.runId, "completed");
          expect(modelRequests.at(-1)).toMatchObject({
            body: {
              model: upstreamModel,
              reasoning: { effort: "max" },
              store: false,
            },
            authorization: null,
            apiKey: "Key custom-pi-gateway-secret",
          });
          if (tier === "fast") {
            expect(modelRequests.at(-1)?.body).toMatchObject({
              service_tier: "priority",
            });
          } else {
            expect(modelRequests.at(-1)?.body).not.toHaveProperty(
              "service_tier",
            );
          }
          expect(JSON.stringify(modelRequests.at(-1)?.body)).toContain(
            `custom gateway answer for ${selectedModel}`,
          );
          await expect(
            readThreadSessionConversation(context, run.threadId),
          ).resolves.toMatchObject({
            agent_session_id: firstSession.agent_session_id,
            conversation_run_id: continuation.runId,
          });
          await expectNoBuiltInModelUsage(continuation.runId);
          const claim = await api.requestClaimRunnerJob(
            true,
            continuation.runId,
            [404],
          );
          expectApiError(claim.body);
        }
        expect(modelRequests).toHaveLength(3);
      }
    },
    90_000,
  );

  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return [
        { selectedModel, tier: undefined, outcome: "completed" },
        { selectedModel, tier: "fast", outcome: "completed" },
        { selectedModel, tier: "fast", outcome: "failed" },
        { selectedModel, tier: "fast", outcome: "cancelled" },
      ] as const;
    }),
  )(
    "keeps custom $selectedModel $tier legacy handoff, captured policy, and $outcome settlement unbilled",
    async ({ selectedModel, tier, outcome }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const firewall = createFirewallApi(context);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        body: unknown;
        authorization: string | null;
        apiKey: string | null;
      }[] = [];
      server.use(
        http.post(gateway.endpoint, async ({ request }) => {
          requests.push({
            body: await request.json(),
            authorization: request.headers.get("authorization"),
            apiKey: request.headers.get("x-api-key"),
          });
          return nativeCodexSseResponse(
            piResponsesContentSse({
              blocks: [
                {
                  type: "toolCall",
                  callId: "call_custom",
                  name: "read",
                  arguments: { path: "/home/user/workspace/AGENTS.md" },
                },
              ],
              sequence: requests.length,
            }),
          );
        }),
      );
      const run = await sendChatRun(
        actor,
        {
          agentId,
          model: selectedModel,
          prompt: "hand off custom gateway tools exactly once",
          runOptions: { codexServiceTier: tier },
        },
        usagePricingResolution,
      );
      const prefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}`;
      await expect
        .poll(() => {
          return objects.has(`${prefix}/manifest.json`);
        })
        .toBe(true);
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: null,
        apiKey: `Key ${gateway.secret}`,
        body: {
          model: gateway.upstreamModel,
          reasoning: { effort: "max" },
          store: false,
        },
      });
      if (tier === "fast") {
        expect(requests[0]?.body).toMatchObject({ service_tier: "priority" });
      } else {
        expect(requests[0]?.body).not.toHaveProperty("service_tier");
      }
      await expectNoBuiltInModelUsage(run.runId);

      await accept(
        setupApp({ context, routes: modelProviderGatewayRoutes })(
          modelProviderConnectionsByIdContract,
        ).update({
          headers: sessionHeaders(actor),
          params: { id: gateway.connection.id },
          body: {
            displayName: gateway.connection.displayName,
            secret: "custom-pi-gateway-rotated-secret",
            surfaces: [
              {
                ...gateway.surface,
                apiBaseUrl: "https://rotated-pi-custom-gateway.example.com/v2",
                authHeaderName: "Authorization",
                authHeaderTemplate: "Bearer {{secret}}",
                modelMappings: { [selectedModel]: "rotated-upstream-alias" },
              },
            ],
          },
        }),
        [200],
      );
      // Mutating current settings after API ownership cannot rewrite the captured claim.
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: false,
        [FeatureSwitchKey.CodexFastMode]: false,
      });
      await chat.updateThreadModelSelection(
        actor,
        run.threadId,
        selectedModel,
        { codexServiceTier: null },
      );
      await configureBuiltInPiModel(actor, selectedModel);
      await api.heartbeatRunner(runnerGroup);
      // The existing custom legacy carrier also works for claimants without generation capabilities.
      const claimResponse = await api.requestClaimRunnerJob(
        true,
        run.runId,
        [200],
      );
      if (claimResponse.status !== 200) {
        throw new Error("Expected the custom legacy claim");
      }
      const claim = claimResponse.body;
      const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piSessionId).toBe(run.threadId);
      expect(claim.piModelConfig).toStrictEqual({
        provider: "openai",
        baseUrl: gateway.surface.apiBaseUrl,
        model: gateway.upstreamModel,
        catalogModel: selectedModel,
        thinkingLevel: "max",
        ...(tier === undefined ? {} : { serviceTier: "priority" }),
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OKOU_MODEL_PROVIDER_API_KEY",
        credentialHeader: {
          name: "x-api-key",
          valueTemplate: "Key {{secret}}",
        },
      });
      expect(claim.billableFirewalls).toStrictEqual([]);
      expect(claim.firewalls).toContainEqual({
        kind: "inline",
        firewall: expect.objectContaining({
          name: `model-provider-surface:${gateway.surfaceId}`,
          apis: [
            expect.objectContaining({
              base: gateway.endpoint,
              auth: {
                headers: {
                  "x-api-key": `Key ${secretTemplate("OKOU_MODEL_PROVIDER_API_KEY")}`,
                },
              },
            }),
          ],
        }),
      });
      expect(claimEnvironment(claim)).toMatchObject({
        OPENAI_BASE_URL: gateway.surface.apiBaseUrl,
        OPENAI_MODEL: gateway.upstreamModel,
        OPENAI_API_KEY: MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
      });
      expect(JSON.stringify(claim)).not.toContain(gateway.secret);
      if (!claim.encryptedSecrets) {
        throw new Error("Expected captured custom credentials");
      }
      const resolved = await firewall.requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: {
            "x-api-key": `Key ${secretTemplate("OKOU_MODEL_PROVIDER_API_KEY")}`,
          },
          secretConnectorMap: claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      expect(resolved.body).toMatchObject({
        headers: { "x-api-key": `Key ${gateway.secret}` },
        resolvedSecrets: ["OKOU_MODEL_PROVIDER_API_KEY"],
      });
      expect(resolved.body).not.toHaveProperty("headers.Authorization");

      const h1 = objects.get(`${prefix}/session.jsonl`);
      const manifestBytes = objects.get(`${prefix}/manifest.json`);
      if (!h1 || !manifestBytes) {
        throw new Error("Expected custom handoff artifacts");
      }
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(manifestBytes.toString("utf8")),
      );
      const history = MemoryPiSession.fromJsonl(h1.toString("utf8"));
      const assistant = history.buildSessionContext().messages.at(-1);
      if (assistant?.role !== "assistant") {
        throw new Error("Expected pending custom assistant");
      }
      const tool = assistant.content.find((block) => {
        return block.type === "toolCall";
      });
      if (tool?.type !== "toolCall") {
        throw new Error("Expected pending custom tool");
      }
      history.appendMessage({
        role: "toolResult",
        toolCallId: tool.id,
        toolName: tool.name,
        content: [{ type: "text", text: "custom tool output" }],
        isError: false,
        timestamp: 2,
      });
      history.appendMessage({
        ...assistant,
        content: [{ type: "text", text: "custom Sandbox completion" }],
        stopReason: "stop",
        timestamp: 3,
      });
      const h2 = history.toJsonl();
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
      objects.set(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
        Buffer.from(h2, "utf8"),
      );
      const sequence = manifest.sandboxEventSequenceStart;
      await webhooks.requestAgentEvents(
        {
          runId: run.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: sequence,
              message: {
                content: [{ type: "text", text: "custom Sandbox completion" }],
              },
            },
            {
              type: "result",
              sequenceNumber: sequence + 1,
              result: "custom Sandbox completion",
            },
          ],
        },
        sandboxHeaders,
        [200],
      );
      if (outcome === "cancelled") {
        await cancelChatRun(actor, run.runId);
      }
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: outcome === "failed" ? 1 : 0,
          ...(outcome === "failed" ? { error: "custom Sandbox failed" } : {}),
          lastEventSequence: sequence + 1,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryHash: h2Hash,
          },
        },
        sandboxHeaders,
        outcome === "cancelled" ? [400] : [200],
        undefined,
        usagePricingResolution,
      );
      await waitForRunStatus(actor, run.runId, outcome);
      await flushWaitUntilForTest();
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
        undefined,
        usagePricingResolution,
      );
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: outcome,
      });
      expect(requests).toHaveLength(1);
      await expectNoBuiltInModelUsage(run.runId);
      expect(h2).not.toMatch(/serviceTier|service_tier/);
      expect(
        JSON.stringify({
          h2,
          events: (await chat.listThreadEvents(actor, run.threadId)).events,
        }),
      ).not.toContain(gateway.secret);
    },
    90_000,
  );

  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return [400, 401].map((status) => {
        return { selectedModel, status };
      });
    }),
  )(
    "preserves custom $selectedModel Fast rejection $status without downgrade or an API retry",
    async ({ selectedModel, status }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        url: string;
        body: unknown;
        apiKey: string | null;
        authorization: string | null;
      }[] = [];
      server.use(
        ...[
          gateway.endpoint,
          ...new Set(
            USER_OWNED_GPT_FAST_BDD_ROUTES.map((route) => {
              return route.endpoint;
            }),
          ),
        ].map((endpoint) => {
          return http.post(endpoint, async ({ request }) => {
            requests.push({
              url: request.url,
              body: await readCodexRequestJson(request),
              apiKey: request.headers.get("x-api-key"),
              authorization: request.headers.get("authorization"),
            });
            return HttpResponse.json(
              {
                error: {
                  code:
                    status === 400
                      ? "unsupported_service_tier"
                      : "invalid_api_key",
                  message: `gateway rejected priority: ${gateway.secret}`,
                },
              },
              { status },
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: selectedModel,
        prompt: "surface the custom Fast rejection",
        runOptions: { codexServiceTier: "fast" },
      });
      if (status === 400) {
        await flushWaitUntilForTest();
        const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
        const manifest = piApiFirstTurnManifestSchema.parse(
          JSON.parse(objects.get(manifestKey)?.toString("utf8") ?? "{}"),
        );
        expect(manifest).toMatchObject({
          outcome: "ownership-transfer",
          mode: "sandbox-first",
        });
        const claimed = await api.claimRunnerJob(run.runId, {
          capabilities: { piModelConfigGenerations: [1, 2, 3] },
        });
        expect(claimed.piModelConfig).toMatchObject({
          serviceTier: "priority",
          model: gateway.upstreamModel,
        });
        await failChatRun(
          run.runId,
          { authorization: `Bearer ${claimed.sandboxToken}` },
          "Sandbox rejected priority",
        );
      }
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expect(requests).toStrictEqual([
        {
          url: gateway.endpoint,
          apiKey: `Key ${gateway.secret}`,
          authorization: null,
          body: expect.objectContaining({
            model: gateway.upstreamModel,
            service_tier: "priority",
            reasoning: expect.objectContaining({ effort: "max" }),
          }),
        },
      ]);
      const failed = await api.readRun(actor, run.runId);
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringContaining(
          status === 401
            ? "[PI_API_MODEL_FAILED]"
            : "Sandbox rejected priority",
        ),
      });
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expectApiError(claim.body);
      await expectNoBuiltInModelUsage(run.runId);
      if (status === 401) {
        expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      }
      expect(
        JSON.stringify({
          failed,
          events: (await chat.listThreadEvents(actor, run.threadId)).events,
        }),
      ).not.toContain(gateway.secret);
    },
    90_000,
  );

  it.each(
    ([...GPT_PI_BDD_MODELS, "deepseek-v4.1-flash"] as const).flatMap(
      (selectedModel) => {
        return ["mapping", "connection"].map((removed) => {
          return { selectedModel, removed };
        });
      },
    ),
  )(
    "fails custom $selectedModel when its $removed disappears before credential capture",
    async ({ selectedModel, removed }) => {
      const { actor, agentId } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      const gate = holdAgentRunPiExecutionSnapshotFixture({
        userId: actor.userId,
        orgId: requireOrgId(actor),
        signal: context.signal,
      });
      onTestFinished(gate.release);
      const requests: string[] = [];
      server.use(
        ...[
          gateway.endpoint,
          ...new Set(
            USER_OWNED_GPT_FAST_BDD_ROUTES.map((route) => {
              return route.endpoint;
            }),
          ),
        ].map((endpoint) => {
          return http.post(endpoint, ({ request }) => {
            requests.push(request.url);
            return nativeCodexSseResponse(
              piResponsesTextSse("unexpected substituted request", 0),
            );
          });
        }),
      );
      const sent = chat.requestSendEvent(
        actor,
        {
          agentId,
          clientEventId: randomUUID(),
          model: selectedModel,
          prompt: "fail the unavailable custom route before any model call",
          ...(selectedModel === "deepseek-v4.1-flash"
            ? {}
            : { runOptions: { codexServiceTier: "fast" as const } }),
        },
        [503],
      );
      await expect(gate.arrival).resolves.toMatchObject({ piExecution: true });
      const connection = setupApp({
        context,
        routes: modelProviderGatewayRoutes,
      })(modelProviderConnectionsByIdContract);
      if (removed === "connection") {
        await accept(
          connection.delete({
            headers: sessionHeaders(actor),
            params: { id: gateway.connection.id },
          }),
          [204],
        );
      } else {
        await accept(
          connection.update({
            headers: sessionHeaders(actor),
            params: { id: gateway.connection.id },
            body: {
              displayName: gateway.connection.displayName,
              surfaces: [
                {
                  ...gateway.surface,
                  modelMappings: { "gpt-6-astra": "unrelated-upstream-alias" },
                },
              ],
            },
          }),
          [200],
        );
      }
      gate.release();
      const rejected = await sent;
      await flushWaitUntilForTest();
      expect(rejected.body).toMatchObject({
        error: { code: "PROVIDER_UNAVAILABLE" },
      });
      expect(requests).toStrictEqual([]);
    },
    90_000,
  );

  it.each([...GPT_PI_BDD_MODELS, "deepseek-v4.1-flash"] as const)(
    "preserves captured custom %s credentials after gateway removal without substitution",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const gateway = await configureCustomPiModel(actor, selectedModel);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        url: string;
        body: unknown;
        apiKey: string | null;
        authorization: string | null;
      }[] = [];
      server.use(
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          const objectKey = new URL(request.url).searchParams.get("object");
          if (!objectKey) {
            throw new Error("Expected Pi archive identity");
          }
          return new HttpResponse(piS3Object(objectKey), {
            headers: { "content-type": "application/gzip" },
          });
        }),
        ...[
          gateway.endpoint,
          ...new Set(
            USER_OWNED_GPT_FAST_BDD_ROUTES.map((route) => {
              return route.endpoint;
            }),
          ),
        ].map((endpoint) => {
          return http.post(endpoint, async ({ request }) => {
            requests.push({
              url: request.url,
              body: await readCodexRequestJson(request),
              apiKey: request.headers.get("x-api-key"),
              authorization: request.headers.get("authorization"),
            });
            return nativeCodexSseResponse(
              piResponsesTextSse("captured custom credential", requests.length),
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: selectedModel,
        prompt: "retain the captured custom credential authority",
        ...(selectedModel === "deepseek-v4.1-flash"
          ? {}
          : { runOptions: { codexServiceTier: "fast" as const } }),
      });
      await entered.promise;
      await accept(
        setupApp({ context, routes: modelProviderGatewayRoutes })(
          modelProviderConnectionsByIdContract,
        ).delete({
          headers: sessionHeaders(actor),
          params: { id: gateway.connection.id },
        }),
        [204],
      );
      release.resolve(undefined);
      await waitForRunStatus(actor, run.runId, "completed");
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "completed",
      });
      expect(requests).toStrictEqual([
        {
          url: gateway.endpoint,
          body: expect.objectContaining({
            model: gateway.upstreamModel,
            ...(selectedModel === "deepseek-v4.1-flash"
              ? {}
              : { service_tier: "priority" }),
          }),
          apiKey: `Key ${gateway.secret}`,
          authorization: null,
        },
      ]);
      await expectNoBuiltInModelUsage(run.runId);
      for (const bytes of objects.values()) {
        expect(bytes.toString("utf8")).not.toContain(gateway.secret);
      }
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expectApiError(claim.body);
    },
    90_000,
  );

  it.each(GPT_PI_BDD_MODELS)(
    "promotes queued custom %s Fast with the admitted tier and switch snapshot",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the target thread",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
      const gateway = await configureCustomPiModel(actor, selectedModel);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(gateway.endpoint, async ({ request }) => {
          expect(request.headers.get("x-api-key")).toBe(
            `Key ${gateway.secret}`,
          );
          expect(request.headers.get("authorization")).toBeNull();
          requests.push(await request.json());
          return nativeCodexSseResponse(
            piResponsesTextSse("queued custom answer", requests.length),
          );
        }),
      );
      const queuedId = randomUUID();
      const queued = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          clientEventId: queuedId,
          model: selectedModel,
          prompt: "queued custom Fast",
          runOptions: { codexServiceTier: "fast" },
        },
        [201],
      );
      if (queued.status !== 201) {
        throw new Error("Expected a queued custom send");
      }
      expect(queued.body.runId).toBeNull();
      const gate = holdAgentRunPiExecutionSnapshotFixture({
        userId: actor.userId,
        orgId: requireOrgId(actor),
        signal: context.signal,
      });
      onTestFinished(gate.release);
      chatCallbacks.mockChatOutputEvents([]);
      const completion = completeChatRunOk(
        anchor.runId,
        anchorClaim.sandboxHeaders,
      );
      const snapshot = await gate.arrival;
      expect(snapshot).toMatchObject({
        chatThreadId: anchor.threadId,
        piExecution: true,
        threadSessionCliAgentType: "pi",
      });
      // Promotion reads the current thread selection, then owns that snapshot.
      await chat.updateThreadModelSelection(
        actor,
        anchor.threadId,
        selectedModel,
        { codexServiceTier: null },
      );
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: false,
        [FeatureSwitchKey.CodexFastMode]: false,
      });
      gate.release();
      await completion;
      const messages = await waitForThreadMessages(
        actor,
        anchor.threadId,
        (events) => {
          return userMessages(events).some((event) => {
            return (
              event.revokesEventId === queuedId && event.runId !== undefined
            );
          });
        },
      );
      const promoted = userMessages(messages.events).find((event) => {
        return event.revokesEventId === queuedId;
      });
      if (!promoted?.runId) {
        throw new Error("Expected a promoted custom run");
      }
      await waitForRunStatus(actor, promoted.runId, "completed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: gateway.upstreamModel,
        service_tier: "priority",
        reasoning: { effort: "max" },
      });
      expect(
        occurrences(JSON.stringify(requests[0]), "queued custom Fast"),
      ).toBe(1);
      await expectNoBuiltInModelUsage(promoted.runId);
      await expect(
        readRunLaunchSnapshotFixture(context, promoted.runId),
      ).resolves.toMatchObject({ launch_snapshot: { framework: "pi" } });
      const claim = await api.requestClaimRunnerJob(
        true,
        promoted.runId,
        [404],
      );
      expectApiError(claim.body);
    },
    90_000,
  );

  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return ["in-flight", "late-result"].map((phase) => {
        return { selectedModel, phase };
      });
    }),
  )(
    "keeps cancelled custom $selectedModel Fast $phase unbilled and unreplayed",
    async ({ selectedModel, phase }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      const requests: unknown[] = [];
      server.use(
        http.post(gateway.endpoint, async ({ request }) => {
          expect(request.headers.get("x-api-key")).toBe(
            `Key ${gateway.secret}`,
          );
          expect(request.headers.get("authorization")).toBeNull();
          requests.push(await request.json());
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          return nativeCodexSseResponse(
            piResponsesTextSse("discarded custom answer", requests.length),
          );
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: selectedModel,
        prompt: "cancel custom Fast ownership",
        runOptions: { codexServiceTier: "fast" },
      });
      await entered.promise;
      if (phase === "late-result") {
        await cancelBeforeLatePiResult(actor, run.runId, () => {
          release.resolve(undefined);
        });
      } else {
        await cancelChatRun(actor, run.runId);
        release.resolve(undefined);
      }
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "cancelled",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: gateway.upstreamModel,
        service_tier: "priority",
      });
      await expectNoBuiltInModelUsage(run.runId);
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      expect(
        eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          run.runId,
        ),
      ).toHaveLength(0);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expectApiError(claim.body);
    },
    90_000,
  );

  it.each([
    { selectedModel: "gpt-6-astra", tier: undefined, piLoop: true },
    { selectedModel: "gpt-6-astra", tier: "fast", piLoop: true },
    ...GPT_PI_BDD_MODELS.map((selectedModel) => {
      return { selectedModel, tier: "fast", piLoop: false } as const;
    }),
  ] as const)(
    "keeps custom $selectedModel $tier with PiLoop=$piLoop inside its existing runtime boundary",
    async ({ selectedModel, tier, piLoop }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: piLoop,
      });
      const run = await sendChatRun(actor, {
        agentId,
        model: selectedModel,
        prompt: "respect custom Pi admission boundaries",
        runOptions: { codexServiceTier: tier },
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim.cliAgentType).toBe("codex");
      expect(claimed.claim.piModelConfig).toBeUndefined();
      expect(claimEnvironment(claimed.claim)).toMatchObject({
        OPENAI_MODEL: gateway.upstreamModel,
      });
      await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
      await expectNoBuiltInModelUsage(run.runId);
    },
    90_000,
  );

  it.each(GPT_PI_BDD_MODELS)(
    "rejects custom %s Fast admission when the existing Fast gate is disabled",
    async (selectedModel) => {
      const { actor, agentId } = await entitledChatActor();
      await configureCustomPiModel(actor, selectedModel);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CodexFastMode]: false,
      });
      const clientThreadId = randomUUID();
      const rejected = await chat.requestSendEvent(
        actor,
        {
          agentId,
          clientEventId: randomUUID(),
          clientThreadId,
          model: selectedModel,
          prompt: "respect the custom Fast feature gate",
          runOptions: { codexServiceTier: "fast" },
        },
        [400],
      );
      expect(rejected.body).toMatchObject({
        error: {
          message: "Codex fast mode is not enabled for this workspace",
        },
      });
      await chat.requestReadThread(actor, clientThreadId, [404]);
    },
    90_000,
  );
});
