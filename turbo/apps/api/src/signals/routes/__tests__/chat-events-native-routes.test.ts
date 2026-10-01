import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";
import {
  PI_NATIVE_CREDENTIAL_PLACEHOLDER,
  piModelConfigV4Schema,
  piNativeInferenceUrl,
} from "@okouai/api-contracts/contracts/pi-native";
import { piNativeFirewall } from "@okouai/api-contracts/contracts/pi-native-firewall";
import { createHash, randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { SEEDED_MODEL_CATALOG } from "@okouai/core/__tests__/seeded-model-catalog";
import { piCatalogModel } from "@okouai/core/pi-execution";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { stagePreAddabilityModelPolicyFixture } from "../../../test-fixtures/org-model-policies";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import { loadPiCatalogModelFixture } from "../../../test-fixtures/model-catalog";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  requireOrgId,
  createGptUsagePricingResolution,
  createPiUsagePricingResolution,
  claimEnvironment,
  expectExactPrivatePiMemoryAdmission,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  misc,
  authDeviceSupport,
  entitledChatActor,
  configureBuiltInPiModel,
  sendChatRun,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForRunStatus,
  cancelChatRun,
  waitForThreadMessages,
  modelProviderConnectionsClient,
  sessionHeaders,
  upsertOrgModelProvider,
  threadPiAutomationsClient,
  postThreadPiAutomationEvent,
  lastThreadPiAutomationRun,
  expectThreadPiTerminal,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
  completeChatRunOk,
  piSandboxBaseSession,
} = createChatEventsFixture(context);

async function completeNativeToolRun({
  actor,
  agentId,
  runnerGroup,
  run,
  claim,
  objects,
  model,
  surfaceId,
}: {
  actor: ApiTestUser;
  agentId: string;
  runnerGroup: string;
  run: Awaited<ReturnType<typeof sendChatRun>>;
  claim: Awaited<ReturnType<typeof api.claimRunnerJob>>;
  objects: Map<string, Buffer>;
  model: "claude-sonnet-5";
  surfaceId: string | null;
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
  await expect(
    api.nextSteerableInput(claim.sandboxToken, run.runId),
  ).resolves.toStrictEqual({
    input: { eventId: activeInputEventId, prompt: activeInput },
  });
  await expect(
    api.declareSteeredInput(claim.sandboxToken, run.runId, activeInputEventId),
  ).resolves.toStrictEqual({ outcome: "steered" });
  const h0 = piSandboxBaseSession(claim, objects);
  // The sandbox runs the whole native turn: a tool call with an image result,
  // the delivered active input, and the final answer.
  const history = MemoryPiSession.fromJsonl(h0.toString("utf8"));
  const assistant = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as const;
  const toolCallId = randomUUID();
  history.appendMessage({ role: "user", content: claim.prompt, timestamp: 1 });
  history.appendMessage({
    ...assistant,
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: "read",
        arguments: { path: "/home/user/workspace/AGENTS.md" },
      },
    ],
    stopReason: "toolUse",
    timestamp: 2,
  });
  history.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName: "read",
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
  await webhooks.requestAgentEvents(
    {
      runId: run.runId,
      events: [
        {
          type: "assistant",
          sequenceNumber: 1,
          message: {
            content: [{ type: "text", text: "Native sandbox completion" }],
          },
        },
        {
          type: "result",
          sequenceNumber: 2,
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
      lastEventSequence: 2,
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
      preferred: true,
      defaultProviderType: "custom-anthropic-messages",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
    },
  ]);

  const resumed = await sendChatRun(actor, {
    agentId,
    threadId: run.threadId,
    prompt: "continue with the native tool image and accepted input",
  });
  await flushWaitUntilForTest();
  const resumedClaim = await claimChatRun(runnerGroup, resumed.runId);
  const resumeSession = resumedClaim.claim.resumeSession;
  expect(resumeSession).toMatchObject({
    sessionId: run.threadId,
    historyRef: { kind: "blob", hash },
  });
  if (!resumeSession || !("historyRef" in resumeSession)) {
    throw new Error("Expected referenced native tool history");
  }
  expect(new URL(resumeSession.historyRef.url).searchParams.get("object")).toBe(
    `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${hash}.blob`,
  );
  expect(
    piSandboxBaseSession(resumedClaim.claim, objects).toString("utf8"),
  ).toBe(h2);
  await cancelChatRun(actor, resumed.runId, resumedClaim.sandboxHeaders);
}

/** The upstream model of the model's catalog route for a provider type. */
async function catalogUpstreamModel(
  type: string,
  model: string,
): Promise<string> {
  const upstreamModel = (await loadPiCatalogModelFixture(model))?.own.get(
    type,
  )?.upstreamModel;
  if (upstreamModel === undefined) {
    throw new Error(`Expected a ${type} catalog route for ${model}`);
  }
  return upstreamModel;
}

describe("shared native Pi route activation", () => {
  it.each([
    { type: "openrouter-codex", model: "deepseek-v4.1-flash" },
    { type: "deepseek", model: "deepseek-v4-flash" },
    { type: "openrouter-codex", model: "deepseek-v4-flash" },
  ] as const)(
    "launches canonical $type $model Responses and continues the owned Pi session",
    async ({ type, model }) => {
      if (model === "deepseek-v4.1-flash") {
        configureNativeCliArtifact();
      }
      const upstreamModel = await catalogUpstreamModel(type, model);
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const { providerId } = await upsertOrgModelProvider(actor, {
        type,
        secret: "selected-deepseek-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          preferred: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      const pricing = await createGptUsagePricingResolution();

      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const first = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "remember the selected DeepSeek route",
      });
      await flushWaitUntilForTest();
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim).toMatchObject({
        piSessionId: first.threadId,
        resumeSession: null,
        piModelConfig: { model: upstreamModel },
      });
      await completeSandboxFirstPiRun({
        actor,
        run: first,
        claim: firstClaim,
        checkpointObjects: objects,
        prompt: "remember the selected DeepSeek route",
        answer: "DeepSeek BYOK answer",
        responsesModel: {
          provider: "deepseek",
          model: upstreamModel,
        },
        usagePricingResolution: pricing,
      });
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with the same history",
      });
      await expectThreadModelCredits(context, actor, first.threadId, 0);
      await expectThreadModelCredits(context, actor, second.threadId, 0);
      await flushWaitUntilForTest();
      const secondClaim = await claimChatRun(runnerGroup, second.runId);
      expect(secondClaim.claim).toMatchObject({
        piSessionId: first.threadId,
        piModelConfig: { model: upstreamModel },
        resumeSession: {
          sessionId: first.threadId,
          historyRef: { kind: "blob", hash: expect.any(String) },
        },
      });
      await cancelChatRun(actor, second.runId, secondClaim.sandboxHeaders);
    },
    90_000,
  );

  // The frozen Gen4 reader vocabulary is deliberately wider than Pi admission:
  // `claude-fable-5-1` is still read from persisted native config, but the
  // Fable frontier line runs on the Claude Code vendor harness, so it has no
  // native Pi run to assert here. Enumerate from the admission decision.
  it.each(
    piNativeCatalogModelSchema.options.filter((model) => {
      return (
        piCatalogModel(SEEDED_MODEL_CATALOG, model)?.piRouteClass ===
        "claude-native"
      );
    }),
  )(
    "runs built-in %s in the sandbox with the route effort and exact session continuation",
    async (model) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      configureNativeCliArtifact();
      if (model === "claude-opus-5-5" || model === "claude-sonnet-5-5") {
        await stagePreAddabilityModelPolicyFixture({
          orgId: requireOrgId(actor),
          userId: actor.userId,
          model,
        });
      }
      await configureBuiltInPiModel(actor, model);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiMemory]: true,
      });
      const pricing = await createPiUsagePricingResolution(model);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
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
      await flushWaitUntilForTest();
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim).toMatchObject({
        cliAgentType: "pi",
        piSessionId: first.threadId,
        piModelConfig: {
          schemaVersion: 4,
          catalogModel: model,
          billingOwner: "builtin",
        },
      });
      expect(firstClaim.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        "low",
      );
      await completeSandboxFirstPiRun({
        actor,
        answer: "Native Claude sandbox answer",
        checkpointObjects: objects,
        claim: firstClaim,
        prompt: "retain this Claude native preference",
        run: first,
        nativeModel: model,
        usagePricingResolution: pricing,
      });
      await expectExactPrivatePiMemoryAdmission({
        orgId: requireOrgId(actor),
        userId: actor.userId,
        runId: first.runId,
      });
      await chat.updateThreadModelSelection(actor, first.threadId, model, {
        reasoningEffort: "extra",
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
      await flushWaitUntilForTest();
      const secondClaim = await claimChatRun(runnerGroup, second.runId);
      await completeSandboxFirstPiRun({
        actor,
        answer: "Native Claude sandbox continuation",
        checkpointObjects: objects,
        claim: secondClaim,
        prompt: "continue the native session",
        run: second,
        nativeModel: model,
        usagePricingResolution: pricing,
      });
      await expect(
        chat.readThreadMetadata(actor, first.threadId),
      ).resolves.toMatchObject({
        modelSettings: { [model]: { effort: "extra" } },
      });
      await expectThreadModelCredits(context, actor, first.threadId, 0);
      await expectThreadModelCredits(context, actor, second.threadId, 0);
      for (const run of [first, second]) {
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
      const model = "claude-sonnet-5";
      const secret = "selected-native-key";
      const upstreamModel =
        type === "azure-foundry" || type === "custom-anthropic-messages"
          ? "production-deployment"
          : await catalogUpstreamModel(type, model);
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
          preferred: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: providerId,
          modelProviderSurfaceId: surfaceId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
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
      const run = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "read the workspace with the selected native route",
      });
      await flushWaitUntilForTest();
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
      await expectThreadModelCredits(context, actor, run.threadId, 0);
      const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      if (type === "custom-anthropic-messages") {
        await completeNativeToolRun({
          actor,
          agentId,
          runnerGroup,
          run,
          claim,
          objects,
          model,
          surfaceId,
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
      await expectThreadModelCredits(context, actor, run.threadId, 0);
    },
    90_000,
  );
  it.each(["api-key", "access-keys", "temporary-access-keys"] as const)(
    "uses only the configured Bedrock %s region, profile and credential bundle",
    async (mode) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = "claude-sonnet-5";
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
          preferred: true,
          defaultProviderType: "aws-bedrock",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiMemory]: true,
      });
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const first = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "use the explicit Bedrock profile",
      });
      await flushWaitUntilForTest();
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      await completeSandboxFirstPiRun({
        actor,
        run: first,
        claim: firstClaim,
        checkpointObjects: objects,
        prompt: "use the explicit Bedrock profile",
        answer: "Exact Bedrock deployment answer",
        nativeModel: model,
        usagePricingResolution: await createGptUsagePricingResolution(),
      });
      await expectThreadModelCredits(context, actor, first.threadId, 0);
      await expectExactPrivatePiMemoryAdmission({
        orgId: requireOrgId(actor),
        userId: actor.userId,
        runId: first.runId,
      });
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with a tool on the same Bedrock profile",
      });
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
      await expectThreadModelCredits(context, actor, second.threadId, 0);
      await cancelChatRun(actor, second.runId, sandboxHeaders);
    },
    90_000,
  );

  it.each(["old-cli", "subscription-key", "wrong-region"] as const)(
    "rejects %s before native provider I/O",
    async (boundary) => {
      const { actor, agentId } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = "claude-sonnet-5";
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
          preferred: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);

      if (boundary === "old-cli") {
        mockEnv(
          "CLI_PKG_URL",
          `https://static.okou.io/okou-cli/${"b".repeat(40)}/package.tgz`,
        );
      }
      const clientEventId = randomUUID();
      const response = await chat.requestSendEvent(
        actor,
        {
          agentId,
          model,
          prompt: "reject the invalid native route",
          clientEventId,
        },
        [201],
      );
      if (response.status !== 201) {
        throw new Error("Expected the send to be accepted");
      }
      expect(response.body.runId).toBeNull();
      // The pick rejects the route in the thread instead of launching a run.
      const messages = await waitForThreadMessages(
        actor,
        response.body.threadId,
        (events) => {
          return events.some((event) => {
            return event.eventType === "output.error";
          });
        },
      );
      expect(
        userMessages(messages.events).filter((event) => {
          return event.revokesEventId === clientEventId;
        }),
      ).toStrictEqual([
        expect.objectContaining({
          eventType: "input.rejected",
          error: expect.any(String),
        }),
      ]);
      await flushWaitUntilForTest();
    },
    90_000,
  );

  it("resets native Claude API Pi to personal Claude Code while preserving the session and logical model", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    configureNativeCliArtifact();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: false,
    });
    const model = "claude-sonnet-5";
    await api.updateOrgModelPolicies(actor, [
      {
        model,
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    mockPiResourceArchiveDownloads();
    const objects = mockPiCheckpointObjectStore();
    const first = await sendChatRun(actor, {
      agentId,
      model,
      prompt: "use the organization API",
    });
    await flushWaitUntilForTest();
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.cliAgentType).toBe("pi");
    await completeSandboxFirstPiRun({
      actor,
      run: first,
      claim: firstClaim,
      checkpointObjects: objects,
      prompt: "use the organization API",
      answer: "org API answer before personal connection",
      nativeModel: model,
      usagePricingResolution: await createGptUsagePricingResolution(),
    });
    const originalSession = await readCompletedRunSessionId(
      context,
      actor,
      first.runId,
    );
    mockClaudeCodeTokenEndpoint();
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
    expect(claimEnvironment(claim.claim).ANTHROPIC_MODEL).toBe(model);
    await expect(api.readRun(actor, second.runId)).resolves.toMatchObject({
      source: {
        providerType: "claude-code-oauth-token",
        credentialScope: "member",
        model,
      },
    });
    await expectNoThreadModelUpdateEvent(actor, first.threadId, model);
    await completeChatRunOk(second.runId, claim.sandboxHeaders);
    await expect(
      readCompletedRunSessionId(context, actor, second.runId),
    ).resolves.toBe(originalSession);
    await expectThreadModelCredits(context, actor, second.threadId, 0);
  });

  it.each(["schedule", "event"] as const)(
    "uses the shared native %s Automation handoff and completion without owned memory",
    async (source) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor(
        {},
        source === "event" ? "team" : "pro",
      );
      configureNativeCliArtifact();
      const model = "claude-sonnet-5";
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: "anthropic-api-key",
        secret: "selected-automation-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          preferred: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiMemory]: true,
      });
      const pricing = await createGptUsagePricingResolution();
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
      await expectThreadModelCredits(context, actor, threadId, 0);
    },
    90_000,
  );

  it("keeps official Claude member subscription credentials on Claude Code with Pi enabled", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const model = "claude-sonnet-5";
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
        preferred: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

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
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  }, 90_000);
});
