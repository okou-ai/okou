import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";
import {
  PI_NATIVE_CREDENTIAL_PLACEHOLDER,
  piModelConfigV4Schema,
  piNativeInferenceUrl,
} from "@okouai/api-contracts/contracts/pi-native";
import { piNativeFirewall } from "@okouai/api-contracts/contracts/pi-native-firewall";
import { createHash, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { getProviderRuntimeModel } from "@okouai/api-contracts/contracts/model-providers";
import { piApiFirstTurnManifestSchema } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { readRunModelSourceFixture } from "../../../test-fixtures/agent-runs";
import {
  readmitPiMemoryStage1CandidateFixture,
  readPiMemoryStage1CandidateFixture,
} from "../../../test-fixtures/pi-memory-stage1-candidates";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { readThreadSessionBinding } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  requireOrgId,
  expectPiApiUsage,
  expectNoBuiltInModelUsage,
  createPiApiFirstTurnUsagePricingResolution,
  claimEnvironment,
  expectExactPrivatePiMemoryAdmission,
} from "./helpers/chat-events-fixture";
import { piResponsesTextSse } from "./helpers/pi-responses";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  misc,
  authDeviceSupport,
  entitledChatActor,
  configureBuiltInPiModel,
  configureBuiltInPiModelOnOpenRouter,
  sendChatRun,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForRunStatus,
  cancelChatRun,
  modelProviderConnectionsClient,
  sessionHeaders,
  upsertOrgModelProvider,
  threadPiAutomationsClient,
  postThreadPiAutomationEvent,
  lastThreadPiAutomationRun,
  expectThreadPiTerminal,
  cancelBeforeLatePiResult,
  mockPiCheckpointObjectStore,
  expectNoPiApiFirstTurnArtifacts,
  expectPiApiFirstTurnTerminalWithoutOutput,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
} = createChatEventsFixture(context);

function nativeMessagesResponse(model: string, answer: string, tool = false) {
  const events = [
    {
      type: "message_start",
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "route-bound reasoning" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "route-bound-signature" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: tool
        ? { type: "tool_use", id: randomUUID(), name: "read", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: tool
        ? {
            type: "input_json_delta",
            partial_json: '{"path":"/home/user/workspace/AGENTS.md"}',
          }
        : { type: "text_delta", text: answer },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn" },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
  return new HttpResponse(
    events
      .map((event) => {
        return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function nativeBedrockResponse(tool = false) {
  function frame(event: string, payload: unknown): Buffer {
    const headers = Buffer.concat(
      Object.entries({
        ":message-type": "event",
        ":event-type": event,
        ":content-type": "application/json",
      }).map(([name, value]) => {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(Buffer.byteLength(value));
        return Buffer.concat([
          Buffer.from([name.length]),
          Buffer.from(name),
          Buffer.from([7]),
          length,
          Buffer.from(value),
        ]);
      }),
    );
    const body = Buffer.from(JSON.stringify(payload));
    const prefix = Buffer.alloc(12);
    prefix.writeUInt32BE(16 + headers.length + body.length);
    prefix.writeUInt32BE(headers.length, 4);
    prefix.writeUInt32BE(crc32(prefix.subarray(0, 8)), 8);
    const data = Buffer.concat([prefix, headers, body]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(data));
    return Buffer.concat([data, checksum]);
  }
  return new HttpResponse(
    new Uint8Array(
      Buffer.concat([
        frame("messageStart", { role: "assistant" }),
        ...(tool
          ? [
              frame("contentBlockStart", {
                contentBlockIndex: 0,
                start: {
                  toolUse: { toolUseId: "native-bedrock-tool", name: "read" },
                },
              }),
            ]
          : []),
        frame("contentBlockDelta", {
          contentBlockIndex: 0,
          delta: tool
            ? { toolUse: { input: '{"path":"README.md"}' } }
            : { text: "Exact Bedrock deployment answer" },
        }),
        frame("contentBlockStop", { contentBlockIndex: 0 }),
        frame("messageStop", { stopReason: tool ? "tool_use" : "end_turn" }),
        frame("metadata", {
          usage: {
            inputTokens: 5,
            outputTokens: 3,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 2,
            totalTokens: 13,
          },
        }),
      ]),
    ),
    {
      headers: {
        "content-type": "application/vnd.amazon.eventstream",
        "x-amzn-requestid": "selected-bedrock-response",
      },
    },
  );
}

async function completeNativeToolHandoff({
  actor,
  agentId,
  run,
  claim,
  objects,
  prefix,
  model,
  surfaceId,
  requests,
}: {
  actor: ApiTestUser;
  agentId: string;
  run: Awaited<ReturnType<typeof sendChatRun>>;
  claim: Awaited<ReturnType<typeof api.claimRunnerJob>>;
  objects: Map<string, Buffer>;
  prefix: string;
  model: "claude-sonnet-4-6";
  surfaceId: string | null;
  requests: readonly { body: unknown }[];
}): Promise<void> {
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  const activeInput = "include this native active input exactly once";
  const activeInputEventId = randomUUID();
  await chat.requestSendEvent(
    actor,
    {
      agentId,
      threadId: run.threadId,
      prompt: activeInput,
      clientEventId: activeInputEventId,
    },
    [201],
  );
  const reserved = await api.reserveRunnerActiveInputs(
    claim.sandboxToken,
    run.runId,
  );
  if (reserved.outcome !== "reserved") {
    throw new Error("Expected native active input ownership");
  }
  await expect(
    api.reserveRunnerActiveInputs(claim.sandboxToken, run.runId),
  ).resolves.toStrictEqual(reserved);
  await expect(
    api.recordRunnerActiveInputDelivery(
      claim.sandboxToken,
      run.runId,
      reserved.deliveryId,
    ),
  ).resolves.toStrictEqual({ outcome: "delivered" });
  const h1 = objects.get(`${prefix}/session.jsonl`);
  const manifestBytes = objects.get(`${prefix}/manifest.json`);
  if (!h1 || !manifestBytes) {
    throw new Error("Expected native handoff history");
  }
  const manifest = piApiFirstTurnManifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const history = MemoryPiSession.fromJsonl(h1.toString("utf8"));
  const assistant = history.buildSessionContext().messages.at(-1);
  if (assistant?.role !== "assistant") {
    throw new Error("Expected native pending assistant");
  }
  const tool = assistant.content.find((block) => {
    return block.type === "toolCall";
  });
  if (tool?.type !== "toolCall") {
    throw new Error("Expected native pending tool");
  }
  history.appendMessage({
    role: "toolResult",
    toolCallId: tool.id,
    toolName: tool.name,
    content: [
      { type: "text", text: "native tool result" },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=",
      },
    ],
    isError: false,
    timestamp: 2,
  });
  history.appendMessage({
    role: "user",
    content: activeInput,
    timestamp: 3,
  });
  history.appendMessage({
    ...assistant,
    content: [{ type: "text", text: "Native sandbox completion" }],
    stopReason: "stop",
    timestamp: 3,
  });
  const h2 = history.toJsonl();
  const hash = createHash("sha256").update(h2).digest("hex");
  await webhooks.requestAgentCheckpointPrepareHistory(
    {
      runId: run.runId,
      hash,
      rawSize: Buffer.byteLength(h2),
      encodedSize: Buffer.byteLength(h2),
      encoding: "identity",
    },
    sandboxHeaders,
    [200],
  );
  objects.set(
    `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${hash}.blob`,
    Buffer.from(h2),
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
            content: [{ type: "text", text: "Native sandbox completion" }],
          },
        },
        {
          type: "result",
          sequenceNumber: sequence + 1,
          result: "Native sandbox completion",
        },
      ],
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: run.runId,
      exitCode: 0,
      lastEventSequence: sequence + 1,
      checkpoint: {
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: hash,
      },
    },
    sandboxHeaders,
    [200],
  );
  await waitForRunStatus(actor, run.runId, "completed");
  await flushWaitUntilForTest();
  await expectExactPrivatePiMemoryAdmission({
    orgId: requireOrgId(actor),
    userId: actor.userId,
    runId: run.runId,
  });
  await api.updateOrgModelPolicies(actor, [
    {
      model,
      isDefault: true,
      defaultProviderType: "custom-anthropic-messages",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
    },
  ]);
  await authDeviceSupport.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PiLoop]: true,
  });
  const resumed = await sendChatRun(actor, {
    agentId,
    threadId: run.threadId,
    prompt: "continue with the native tool image and accepted input",
  });
  await expect
    .poll(() => {
      return objects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${resumed.runId}/manifest.json`,
      );
    })
    .toBe(true);
  await flushWaitUntilForTest();
  expect(JSON.stringify(requests[1]?.body)).toContain("image/png");
  expect(JSON.stringify(requests[1]?.body)).toContain(activeInput);
  expect(JSON.stringify(requests[1]?.body)).toContain("route-bound-signature");
  await cancelChatRun(actor, resumed.runId);
}

describe("shared native Pi route activation", () => {
  it.each([
    {
      type: "openrouter-codex",
      model: "deepseek-v4.1-flash",
      url: "https://openrouter.ai/api/v1/responses",
    },
    {
      type: "deepseek",
      model: "deepseek-v4-flash",
      url: "https://api.deepseek.com/responses",
    },
    {
      type: "deepseek",
      model: "deepseek-v4-pro",
      url: "https://api.deepseek.com/responses",
    },
    {
      type: "openrouter-codex",
      model: "deepseek-v4-flash",
      url: "https://openrouter.ai/api/v1/responses",
    },
    {
      type: "openrouter-codex",
      model: "deepseek-v4-pro",
      url: "https://openrouter.ai/api/v1/responses",
    },
  ] as const)(
    "launches canonical $type $model Responses and continues the owned Pi session",
    async ({ type, model, url }) => {
      if (model === "deepseek-v4.1-flash") {
        configureNativeCliArtifact();
      }
      const { actor, agentId } = await entitledChatActor();
      const { providerId } = await upsertOrgModelProvider(actor, {
        type,
        secret: "selected-deepseek-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(url, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer selected-deepseek-key",
          );
          requests.push(await request.json());
          return new HttpResponse(
            piResponsesTextSse("DeepSeek BYOK answer", requests.length),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const first = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "remember the selected DeepSeek route",
      });
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with the same history",
      });
      await waitForRunStatus(actor, second.runId, "completed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        model: getProviderRuntimeModel(type, model),
      });
      expect(JSON.stringify(requests[1])).toContain(
        "remember the selected DeepSeek route",
      );
      await expectNoBuiltInModelUsage(first.runId);
      await expectNoBuiltInModelUsage(second.runId);
    },
    90_000,
  );

  it.each(piNativeCatalogModelSchema.options)(
    "runs built-in %s API-first with native billing and exact session continuation",
    async (model) => {
      const { actor, agentId } = await entitledChatActor();
      configureNativeCliArtifact();
      await configureBuiltInPiModel(actor, model);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      });
      const pricing = await createPiApiFirstTurnUsagePricingResolution(model);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(
          "https://api.anthropic.com/v1/messages",
          async ({ request }) => {
            expect(request.headers.get("x-api-key")).toBeTruthy();
            expect(request.headers.get("authorization")).toBeNull();
            requests.push(await request.json());
            return nativeMessagesResponse(model, "Native Claude answer");
          },
        ),
      );
      const first = await sendChatRun(
        actor,
        {
          agentId,
          model,
          prompt: "retain this Claude native preference",
          runOptions: { reasoningEffort: "low" },
        },
        pricing,
      );
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      await expectExactPrivatePiMemoryAdmission({
        orgId: requireOrgId(actor),
        userId: actor.userId,
        runId: first.runId,
      });
      const nextEffort = model === "claude-sonnet-4-6" ? "high" : "extra";
      await chat.updateThreadModelSelection(actor, first.threadId, model, {
        reasoningEffort: nextEffort,
      });
      const second = await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt: "continue the native session",
        },
        pricing,
      );
      await waitForRunStatus(actor, second.runId, "completed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ model });
      expect(JSON.stringify(requests[0])).toContain('"effort":"low"');
      expect(JSON.stringify(requests[1])).toContain(
        `"effort":"${nextEffort === "extra" ? "xhigh" : "high"}"`,
      );
      await expect(
        chat.readThreadMetadata(actor, first.threadId),
      ).resolves.toMatchObject({
        modelSettings: { [model]: { effort: nextEffort } },
      });
      expect(JSON.stringify(requests[1])).toContain(
        "retain this Claude native preference",
      );
      expect(JSON.stringify(requests[1])).toContain("route-bound-signature");
      for (const run of [first, second]) {
        await expectPiApiUsage(run.runId, model, "", {
          input: 5,
          output: 3,
          cacheRead: 3,
          cacheCreation: 2,
        });
        await api.requestClaimRunnerJob(true, run.runId, [404], {
          capabilities: { piModelConfigGenerations: [4] },
        });
      }
      expect(
        [...objects.values()].some((value) => {
          return value.toString("utf8").includes(first.threadId);
        }),
      ).toBeTruthy();
    },
    90_000,
  );

  it.each([
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
    "custom-anthropic-messages",
    "azure-foundry",
  ] as const)(
    "hands off $0 with the same native route, frozen auth and capable claims",
    async (type) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const cliUrl = configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      const secret = "selected-native-key";
      const upstreamModel =
        type === "azure-foundry" || type === "custom-anthropic-messages"
          ? "production-deployment"
          : getProviderRuntimeModel(type, model);
      let providerId: string | null = null;
      let surfaceId: string | null = null;
      if (type === "custom-anthropic-messages") {
        const created = await accept(
          modelProviderConnectionsClient().create({
            headers: sessionHeaders(actor),
            body: {
              displayName: "Native selected surface",
              secret,
              surfaces: [
                {
                  protocol: "anthropic-messages",
                  apiBaseUrl: "https://native-gateway.example.com",
                  authHeaderName: "X-Provider-Key",
                  authHeaderTemplate: "Custom {{secret}}",
                  modelMappings: { [model]: upstreamModel },
                },
              ],
            },
          }),
          [201],
        );
        surfaceId = created.body.surfaces[0]?.id ?? null;
      } else {
        const created = await upsertOrgModelProvider(
          actor,
          type === "azure-foundry"
            ? {
                type,
                authMethod: "api-key",
                selectedModel: upstreamModel,
                secrets: {
                  ANTHROPIC_FOUNDRY_API_KEY: secret,
                  ANTHROPIC_FOUNDRY_RESOURCE: "native-resource",
                },
              }
            : { type, secret },
        );
        providerId = created.providerId;
      }
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: providerId,
          modelProviderSurfaceId: surfaceId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      });
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const urls = {
        "anthropic-api-key": "https://api.anthropic.com/v1/messages",
        "openrouter-api-key": "https://openrouter.ai/api/v1/messages",
        "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/messages",
        "custom-anthropic-messages":
          "https://native-gateway.example.com/v1/messages",
        "azure-foundry":
          "https://native-resource.services.ai.azure.com/anthropic/v1/messages",
      };
      const requests: {
        body: unknown;
        auth: string | null;
        key: string | null;
        custom: string | null;
      }[] = [];
      server.use(
        http.post(urls[type], async ({ request }) => {
          requests.push({
            body: await request.json(),
            auth: request.headers.get("authorization"),
            key: request.headers.get("x-api-key"),
            custom: request.headers.get("x-provider-key"),
          });
          return nativeMessagesResponse(upstreamModel, "", true);
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "read the workspace with the selected native route",
      });
      const prefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}`;
      await expect
        .poll(() => {
          return objects.has(`${prefix}/manifest.json`);
        })
        .toBe(true);
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(1);
      const bearer =
        type === "openrouter-api-key" || type === "vercel-ai-gateway";
      expect(requests[0]).toMatchObject({
        body: { model: upstreamModel },
        auth: bearer ? `Bearer ${secret}` : null,
        key:
          type === "anthropic-api-key" || type === "azure-foundry"
            ? secret
            : null,
        custom:
          type === "custom-anthropic-messages" ? `Custom ${secret}` : null,
      });
      if (type !== "custom-anthropic-messages") {
        await upsertOrgModelProvider(
          actor,
          type === "azure-foundry"
            ? {
                type,
                authMethod: "api-key",
                secrets: {
                  ANTHROPIC_FOUNDRY_API_KEY: "rotated-native-secret",
                  ANTHROPIC_FOUNDRY_RESOURCE: "rotated-resource",
                },
              }
            : { type, secret: "rotated-native-secret" },
        );
      }
      await configureBuiltInPiModel(actor, model);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: false,
      });
      await api.heartbeatRunner(runnerGroup);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "pending",
      });
      await api.requestClaimRunnerJob(true, run.runId, [400], {
        capabilities: undefined,
      });
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      const result = await api.requestClaimRunnerJob(true, run.runId, [200], {
        capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
      });

      if (result.status !== 200) {
        throw new Error("Expected native-capable claim");
      }
      const claim = result.body;
      const config = piModelConfigV4Schema.parse(claim.piModelConfig);
      expect(config).toMatchObject({
        route: type,
        catalogModel: model,
        model: upstreamModel,
        credentialOwner: "organization",
        billingOwner: "user",
      });
      expect(piNativeInferenceUrl(config)).toBe(urls[type]);
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piSessionId).toBe(run.threadId);
      expect(claim.platformEnvironment.CLI_PKG_URL).toBe(cliUrl);
      expect(claimEnvironment(claim).OKOU_PI_NATIVE_API_KEY).toBe(
        PI_NATIVE_CREDENTIAL_PLACEHOLDER,
      );
      expect(JSON.stringify(claim)).not.toContain(secret);
      expect(claim.billableFirewalls).toStrictEqual([]);
      const expectedFirewall = piNativeFirewall(config);
      expect(claim.firewalls).toContainEqual({
        kind: "inline",
        firewall: expect.objectContaining({
          name: expectedFirewall.name,
          apis: expectedFirewall.apis,
        }),
      });
      if (!claim.encryptedSecrets || config.dialect !== "anthropic-messages") {
        throw new Error("Expected encrypted native Messages credentials");
      }
      const binding = config.credentialBindings[0];
      if (!binding) {
        throw new Error("Missing native binding");
      }
      const header = binding.credentialHeader;
      const auth = await createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${claim.sandboxToken}` },
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: {
            [header.name]: header.valueTemplate.replace(
              "{{secret}}",
              secretTemplate(binding.secretName),
            ),
          },
        },
        [200],
      );
      expect(auth.body).toMatchObject({
        headers: {
          [header.name]: header.valueTemplate.replace("{{secret}}", secret),
        },
        resolvedSecrets: [binding.secretName],
      });
      await expectNoBuiltInModelUsage(run.runId);
      const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      if (type === "custom-anthropic-messages") {
        await completeNativeToolHandoff({
          actor,
          agentId,
          run,
          claim,
          objects,
          prefix,
          model,
          surfaceId,
          requests,
        });
      } else {
        await cancelChatRun(actor, run.runId, sandboxHeaders);
      }
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      const terminal = (
        await chat.listThreadEvents(actor, run.threadId)
      ).events.filter((event) => {
        return (
          "runId" in event &&
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      });
      expect(terminal).toHaveLength(1);
      await expectNoBuiltInModelUsage(run.runId);
      expect(requests).toHaveLength(
        type === "custom-anthropic-messages" ? 2 : 1,
      );
    },
    90_000,
  );
  it.each(["api-key", "access-keys", "temporary-access-keys"] as const)(
    "uses only the configured Bedrock %s region, profile and credential bundle",
    async (mode) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      const profile =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/production";
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: "aws-bedrock",
        authMethod: mode === "api-key" ? "api-key" : "access-keys",
        selectedModel: profile,
        secrets:
          mode === "api-key"
            ? {
                AWS_BEARER_TOKEN_BEDROCK: "selected-bedrock-bearer",
                AWS_REGION: "us-east-1",
              }
            : {
                AWS_ACCESS_KEY_ID: "AKIASELECTED",
                AWS_SECRET_ACCESS_KEY: "selected-aws-secret",
                AWS_REGION: "us-east-1",
                ...(mode === "temporary-access-keys"
                  ? { AWS_SESSION_TOKEN: "selected-session-token" }
                  : {}),
              },
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: "aws-bedrock",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      });
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      let requests = 0;
      server.use(
        http.post(
          "https://bedrock-runtime.us-east-1.amazonaws.com/*",
          async ({ request }) => {
            requests += 1;
            expect(decodeURIComponent(new URL(request.url).pathname)).toBe(
              `/model/${profile}/converse-stream`,
            );
            expect(request.headers.get("x-api-key")).toBeNull();
            if (mode === "api-key") {
              expect(request.headers.get("authorization")).toBe(
                "Bearer selected-bedrock-bearer",
              );
            } else {
              expect(request.headers.get("authorization")).toContain(
                "Credential=AKIASELECTED/",
              );
            }
            expect(request.headers.get("x-amz-security-token")).toBe(
              mode === "temporary-access-keys"
                ? "selected-session-token"
                : null,
            );
            await expect(request.json()).resolves.toMatchObject({
              messages: expect.any(Array),
            });
            return nativeBedrockResponse(requests === 2);
          },
        ),
      );
      const first = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "use the explicit Bedrock profile",
      });
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      await expectNoBuiltInModelUsage(first.runId);
      await expectExactPrivatePiMemoryAdmission({
        orgId: requireOrgId(actor),
        userId: actor.userId,
        runId: first.runId,
      });
      expect(requests).toBe(1);
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with a tool on the same Bedrock profile",
      });
      await expect
        .poll(() => {
          return objects.has(
            `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`,
          );
        })
        .toBe(true);
      await flushWaitUntilForTest();
      await upsertOrgModelProvider(actor, {
        type: "aws-bedrock",
        authMethod: "api-key",
        secrets: {
          AWS_BEARER_TOKEN_BEDROCK: "rotated-bedrock-key",
          AWS_REGION: "us-west-2",
        },
      });
      await api.heartbeatRunner(runnerGroup);
      await api.requestClaimRunnerJob(true, second.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      const claim = await api.claimRunnerJob(second.runId, {
        capabilities: { piModelConfigGenerations: [4] },
      });
      const config = piModelConfigV4Schema.parse(claim.piModelConfig);
      expect(config).toMatchObject({
        route: "aws-bedrock",
        catalogModel: model,
        model: profile,
        region: "us-east-1",
        authMode: mode === "api-key" ? "bearer" : "sigv4",
      });
      for (const binding of config.credentialBindings) {
        expect(claimEnvironment(claim)[binding.environment]).toBe(
          PI_NATIVE_CREDENTIAL_PLACEHOLDER,
        );
      }
      for (const key of [
        "AWS_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
      ]) {
        expect(claimEnvironment(claim)).not.toHaveProperty(key);
      }
      expect(JSON.stringify(claim)).not.toMatch(
        /selected-bedrock-bearer|AKIASELECTED|selected-aws-secret|selected-session-token|rotated-bedrock-key/u,
      );
      const auth = piNativeFirewall(config).apis[0]?.auth;
      if (!auth || !claim.encryptedSecrets) {
        throw new Error("Expected exact Bedrock egress auth");
      }
      const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      const resolved = await createFirewallApi(context).requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: auth.headers ?? {},
          ...(auth.awsSigv4 ? { authAwsSigv4: auth.awsSigv4 } : {}),
        },
        [200],
      );
      expect(resolved.body).toMatchObject(
        mode === "api-key"
          ? { headers: { Authorization: "Bearer selected-bedrock-bearer" } }
          : {
              awsSigv4: {
                accessKeyId: "AKIASELECTED",
                secretAccessKey: "selected-aws-secret",
                ...(mode === "temporary-access-keys"
                  ? { sessionToken: "selected-session-token" }
                  : {}),
              },
            },
      );
      expect(requests).toBe(2);
      await expectNoBuiltInModelUsage(second.runId);
      await cancelChatRun(actor, second.runId, sandboxHeaders);
    },
    90_000,
  );

  it.each(["old-cli", "subscription-key", "wrong-region"] as const)(
    "rejects %s before native provider I/O",
    async (boundary) => {
      const { actor, agentId } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      const type =
        boundary === "wrong-region" ? "aws-bedrock" : "anthropic-api-key";
      const { providerId } = await upsertOrgModelProvider(
        actor,
        boundary === "wrong-region"
          ? {
              type: "aws-bedrock",
              authMethod: "api-key",
              selectedModel:
                "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/wrong-region",
              secrets: {
                AWS_BEARER_TOKEN_BEDROCK: "selected-bearer",
                AWS_REGION: "us-east-1",
              },
            }
          : {
              type: "anthropic-api-key",
              secret:
                boundary === "subscription-key"
                  ? "sk-ant-oat01-subscription-secret"
                  : "selected-native-key",
            },
      );
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      if (boundary === "old-cli") {
        mockEnv(
          "CLI_PKG_URL",
          `https://static.okou.io/okou-cli/${"b".repeat(40)}/package.tgz`,
        );
      }
      let calls = 0;
      server.use(
        http.post("https://api.anthropic.com/*", () => {
          calls += 1;
          return nativeMessagesResponse(model, "must not run");
        }),
        http.post("https://bedrock-runtime.us-east-1.amazonaws.com/*", () => {
          calls += 1;
          return nativeBedrockResponse();
        }),
      );
      const response = await chat.requestSendEvent(
        actor,
        {
          agentId,
          model,
          prompt: "reject the invalid native route",
          clientEventId: randomUUID(),
        },
        [201, 400, 422, 503],
      );
      await flushWaitUntilForTest();
      expect({ status: response.status, body: response.body }).toMatchObject({
        status: 400,
      });
      expect(calls).toBe(0);
    },
    90_000,
  );

  it.each(["in-flight", "late-result"] as const)(
    "keeps native cancellation and billing owned at the %s boundary",
    async (phase) => {
      const { actor, agentId } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      await configureBuiltInPiModel(actor, model);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      const pricing = await createPiApiFirstTurnUsagePricingResolution(model);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let requests = 0;
      server.use(
        http.post("https://api.anthropic.com/v1/messages", async () => {
          requests += 1;
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          return nativeMessagesResponse(
            model,
            "discard cancelled native output",
          );
        }),
      );
      const run = await sendChatRun(
        actor,
        { agentId, model, prompt: "cancel the native request" },
        pricing,
      );
      await entered.promise;
      if (phase === "late-result") {
        await cancelBeforeLatePiResult(
          actor,
          run.runId,
          () => {
            release.resolve(undefined);
          },
          pricing,
        );
      } else {
        await api.requestCancelRun(actor, run.runId, [200], pricing);
        release.resolve(undefined);
      }
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "cancelled");
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      if (phase === "late-result") {
        await expectPiApiUsage(run.runId, model, "", {
          input: 5,
          output: 3,
          cacheRead: 3,
          cacheCreation: 2,
        });
      } else {
        await expectNoBuiltInModelUsage(run.runId);
      }
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [4] },
      });
      expect(requests).toBe(1);
    },
    90_000,
  );

  it("rotates native Claude API Pi to personal Claude Code while preserving the logical model", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    configureNativeCliArtifact();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
      [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
      [FeatureSwitchKey.PersonalModelProviderAccounts]: false,
    });
    const model = "claude-sonnet-5";
    await api.updateOrgModelPolicies(actor, [
      {
        model,
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    let apiCalls = 0;
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () => {
        apiCalls += 1;
        return nativeMessagesResponse(
          model,
          "org API answer before personal connection",
        );
      }),
    );
    const first = await sendChatRun(actor, {
      agentId,
      model,
      prompt: "use the organization API",
    });
    await waitForRunStatus(actor, first.runId, "completed");
    await flushWaitUntilForTest();
    const original = await readThreadSessionBinding(context, first.threadId);
    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "claude-code-oauth-token",
        secret: "sk-ant-oat-personal-rotation",
      },
      [200, 201],
    );
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "use my subscription on the same model",
    });
    const claim = await claimChatRun(runnerGroup, second.runId);
    expect(claim.claim.cliAgentType).toBe("claude-code");
    expect(claim.claim.resumeSession).toBeNull();
    expect(
      (await readThreadSessionBinding(context, first.threadId))
        .agent_session_id,
    ).not.toBe(original.agent_session_id);
    expect(claimEnvironment(claim.claim).ANTHROPIC_MODEL).toBe(model);
    await expect(
      readRunModelSourceFixture(second.runId),
    ).resolves.toMatchObject({
      modelProvider: "claude-code-oauth-token",
      modelProviderCredentialScope: "member",
      selectedModel: model,
      creditAdmitted: false,
      builtInModelKeyId: null,
    });
    await expectNoThreadModelUpdateEvent(actor, first.threadId, model);
    await expectNoBuiltInModelUsage(second.runId);
    expect(apiCalls).toBe(1);
    await cancelChatRun(actor, second.runId, claim.sandboxHeaders);
  });

  it("does not switch the captured native route after a provider authentication failure", async () => {
    const { actor, agentId } = await entitledChatActor();
    configureNativeCliArtifact();
    const model = "claude-sonnet-4-6";
    await configureBuiltInPiModel(actor, model);
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
    });
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    let directCalls = 0;
    let alternateCalls = 0;
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () => {
        directCalls += 1;
        return HttpResponse.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "selected credential rejected",
            },
          },
          { status: 401 },
        );
      }),
      http.post("https://openrouter.ai/*", () => {
        alternateCalls += 1;
        return nativeMessagesResponse(model, "forbidden alternate");
      }),
    );
    const run = await sendChatRun(actor, {
      agentId,
      model,
      prompt: "retain the selected route on failure",
    });
    await waitForRunStatus(actor, run.runId, "failed");
    await flushWaitUntilForTest();
    expect(directCalls).toBe(1);
    expect(alternateCalls).toBe(0);
    await api.requestClaimRunnerJob(true, run.runId, [404], {
      capabilities: { piModelConfigGenerations: [4] },
    });
  }, 90_000);

  it.each([false, true])(
    "captures the managed OpenRouter Claude key with US switch %s and charges native categories once",
    async (usRoutingEnabled) => {
      const { actor, agentId } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      const withSelectedRoute = await configureBuiltInPiModelOnOpenRouter(
        actor,
        model,
      );
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.OpenRouterUsRouting]: usRoutingEnabled,
      });
      const pricing = await createPiApiFirstTurnUsagePricingResolution(model);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      let openRouterCalls = 0;
      let anthropicCalls = 0;
      server.use(
        http.post("https://api.anthropic.com/*", () => {
          anthropicCalls += 1;
          return nativeMessagesResponse(model, "unselected");
        }),
        http.post(
          `https://${usRoutingEnabled ? "us." : ""}openrouter.ai/api/v1/messages`,
          async ({ request }) => {
            openRouterCalls += 1;
            expect(request.headers.get("authorization")).toMatch(/^Bearer .+/u);
            expect(request.headers.get("x-api-key")).toBeNull();
            await expect(request.json()).resolves.toMatchObject({
              model: "anthropic/claude-sonnet-4.6",
            });
            return nativeMessagesResponse(
              "anthropic/claude-sonnet-4.6",
              "Managed native response",
            );
          },
        ),
      );
      const run = await withSelectedRoute(() => {
        return sendChatRun(
          actor,
          {
            agentId,
            model,
            prompt: "use the selected managed OpenRouter route",
          },
          pricing,
        );
      });
      await waitForRunStatus(actor, run.runId, "completed");
      await flushWaitUntilForTest();
      expect(openRouterCalls).toBe(1);
      expect(anthropicCalls).toBe(0);
      await expectPiApiUsage(run.runId, model, "", {
        input: 5,
        output: 3,
        cacheRead: 3,
        cacheCreation: 2,
      });
    },
    90_000,
  );
  it.each(["schedule", "event"] as const)(
    "uses the shared native %s Automation handoff and completion without owned memory",
    async (source) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor(
        {},
        source === "event" ? "team" : "pro",
      );
      configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: "anthropic-api-key",
        secret: "selected-automation-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      });
      const pricing = await createPiApiFirstTurnUsagePricingResolution(model);
      const workflows = createWorkflowsBddApi(context);
      const workflowId = await workflows.createWorkflow(actor, {
        agentId,
        name: `native-source-${source}`,
      });
      const created = await accept(
        threadPiAutomationsClient().create({
          headers: sessionHeaders(actor),
          params: { workflowId },
          body:
            source === "schedule"
              ? { schedule: { type: "loop", intervalSeconds: 3600 } }
              : { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      );
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const automation = created.body;
      let threadId: string;
      if (
        automation.kind === "event" &&
        automation.eventType === "webhook-received" &&
        automation.webhookUrl &&
        automation.webhookSecret &&
        automation.chatThreadId
      ) {
        const event = {
          webhookUrl: automation.webhookUrl,
          webhookSecret: automation.webhookSecret,
          payload: "native event",
          timestamp: Math.floor(now() / 1000),
          usagePricingResolution: pricing,
        };
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          { duplicate: false },
        );
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          { duplicate: true },
        );
        threadId = automation.chatThreadId;
      } else {
        const started = await accept(
          threadPiAutomationsClient().run({
            headers: sessionHeaders(actor),
            params: { id: automation.id },
          }),
          [201],
        );
        threadId = started.body.chatThreadId;
      }
      const runId = await lastThreadPiAutomationRun(actor, threadId);
      await flushWaitUntilForTest();
      await api.heartbeatRunner(runnerGroup);
      await api.requestClaimRunnerJob(true, runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      const claim = await api.claimRunnerJob(runId, {
        capabilities: { piModelConfigGenerations: [4] },
      });
      expect(claim.piModelConfig).toMatchObject({
        schemaVersion: 4,
        route: "anthropic-api-key",
        catalogModel: model,
        billingOwner: "user",
      });
      const ownedClaim = {
        claim,
        sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
      };
      await completeSandboxFirstPiRun({
        actor,
        run: { runId, threadId },
        claim: ownedClaim,
        checkpointObjects: objects,
        prompt: claim.prompt,
        answer: `owned native ${source} completion`,
        nativeModel: model,
        usagePricingResolution: pricing,
      });
      await expectThreadPiTerminal(actor, threadId, runId);
      // With PiMemory on, the native Automation completion is still skipped
      // as a non-interactive source and writes no owned memory candidate.
      await expect(
        readPiMemoryStage1CandidateFixture({
          orgId: requireOrgId(actor),
          userId: actor.userId,
        }),
      ).resolves.toBeNull();
      await expect(
        readmitPiMemoryStage1CandidateFixture(runId),
      ).resolves.toStrictEqual({
        outcome: "skipped",
        reason: "non_interactive_source",
      });
      await expectNoBuiltInModelUsage(runId);
    },
    90_000,
  );

  it("keeps official Claude member subscription credentials on Claude Code with Pi enabled", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const model = "claude-sonnet-4-6";
    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "claude-code-oauth-token",
        secret: "sk-ant-oat01-official-subscription",
      },
      [200, 201],
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model,
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
    });
    let nativeCalls = 0;
    server.use(
      http.post("https://api.anthropic.com/*", () => {
        nativeCalls += 1;
        return nativeMessagesResponse(model, "must not call Pi");
      }),
    );
    const run = await sendChatRun(actor, {
      agentId,
      model,
      prompt: "retain official Claude subscription ownership",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.cliAgentType).toBe("claude-code");
    expect(claim.piModelConfig).toBeUndefined();
    expect(claimEnvironment(claim).CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy();
    expect(nativeCalls).toBe(0);
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  }, 90_000);
});
