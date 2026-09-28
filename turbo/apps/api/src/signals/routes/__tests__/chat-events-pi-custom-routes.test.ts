import { createHash, randomUUID } from "node:crypto";
import { modelProviderConnectionsByIdContract } from "@okouai/api-contracts/contracts/model-provider-gateways";
import {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  getProviderRuntimeModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { DEFAULT_PROFILE } from "@okouai/api-contracts/contracts/runners";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { holdAgentRunPiExecutionSnapshotFixture } from "../../../test-fixtures/thread-bound-run-admission";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import {
  readRunLaunchSnapshotFixture,
  readThreadSessionConversation,
} from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  GPT_PI_BDD_MODELS,
  requireOrgId,
  expectNoBuiltInModelUsage,
  createGptUsagePricingResolution,
  createPiUsagePricingResolution,
  claimEnvironment,
  userMessages,
  assistantMessages,
} from "./helpers/chat-events-fixture";

const context = testContext({ connectorCatalog: true });
const {
  api,
  chat,
  webhooks,
  chatCallbacks,
  entitledChatActor,
  configureBuiltInPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  modelProviderConnectionsClient,
  sessionHeaders,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
  expectPiSandboxHandoff,
} = createChatEventsFixture(context);

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

  return {
    connection: created.body,
    surfaceId,
    surface,
    secret,
    upstreamModel,
    endpoint: `${surface.apiBaseUrl}/responses`,
  };
}

/** S3 reads issued so far, used to prove resume transfers history by reference. */
function s3GetObjectCommandCalls(): readonly unknown[] {
  return context.mocks.s3.send.mock.calls.filter(([command]) => {
    return (
      (command as { readonly constructor?: { readonly name?: string } })
        .constructor?.name === "GetObjectCommand"
    );
  });
}

describe("CHAT-02: model-first provider policies", () => {
  it.each([
    "deepseek-v4-flash",
    "deepseek-v4.1-flash",
    ...GPT_PI_BDD_MODELS,
  ] as const)(
    "hands the first %s Pi turn to the Sandbox and resumes canonical JSONL by reference",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      // Generic usage pricing for the Sandbox completion webhook.
      const usagePricingResolution =
        await createPiUsagePricingResolution(selectedModel);
      await configureBuiltInPiModel(actor, selectedModel);

      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const runtimeModel = getProviderRuntimeModel("built-in", selectedModel);
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
      const firstHandoff = expectPiSandboxHandoff(
        first.runId,
        checkpointObjects,
      );
      expect(firstHandoff.manifest.schemaVersion).toBe(3);
      expect(firstHandoff.session).toBeDefined();
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim).toMatchObject({
        cliAgentType: "pi",
        piSessionId: first.threadId,
        piModelConfig: {
          model: runtimeModel,
          ...(selectedModel.startsWith("gpt-") ? { thinkingLevel: "max" } : {}),
        },
      });
      await completeSandboxFirstPiRun({
        actor,
        run: first,
        claim: firstClaim,
        checkpointObjects,
        prompt: firstPrompt,
        answer: `first Sandbox answer for ${selectedModel}`,
        responsesModel: {
          provider: selectedModel.startsWith("gpt-") ? "openai" : "deepseek",
          model: runtimeModel,
        },
        usagePricingResolution,
      });
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

      await chat.updateThreadModelSelection(
        actor,
        first.threadId,
        selectedModel,
        selectedModel === "deepseek-v4.1-flash"
          ? {}
          : { reasoningEffort: "high" },
      );
      const readsBeforeResume = s3GetObjectCommandCalls().length;
      const second = await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt: "continue the same Pi session",
        },
        usagePricingResolution,
      );
      await flushWaitUntilForTest();
      const metadata = await chat.readThreadMetadata(actor, first.threadId);
      if (selectedModel === "deepseek-v4.1-flash") {
        expect(metadata.modelSettings).not.toHaveProperty(selectedModel);
      } else {
        expect(metadata.modelSettings).toMatchObject({
          [selectedModel]: { effort: "high" },
        });
      }
      // Blob-backed continuation transfers by reference without API H0 reads.
      expect(s3GetObjectCommandCalls()).toHaveLength(readsBeforeResume);
      const secondHandoff = expectPiSandboxHandoff(
        second.runId,
        checkpointObjects,
      );
      expect(secondHandoff.manifest).toMatchObject({
        schemaVersion: 4,
        baseSession: { sessionId: first.threadId },
      });
      const storedHistoryHashes = [...checkpointObjects.entries()]
        .filter(([key]) => {
          return key.includes("/blobs/");
        })
        .map(([, bytes]) => {
          return createHash("sha256").update(bytes).digest("hex");
        });
      expect(storedHistoryHashes).toContain(
        secondHandoff.manifest.baseSession.sha256,
      );
      const secondClaim = await claimChatRun(runnerGroup, second.runId);
      expect(secondClaim.claim).toMatchObject({
        piSessionId: first.threadId,
        piModelConfig: { model: runtimeModel },
      });
      await cancelChatRun(actor, second.runId, secondClaim.sandboxHeaders);
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
    ...GPT_PI_BDD_MODELS.map((selectedModel) => {
      return {
        selectedModel,
        upstreamModel: `company-${selectedModel}-production`,
      };
    }),
  ] as const)(
    "runs custom Responses gateway $selectedModel through the Pi Sandbox without built-in model billing",
    async ({ selectedModel, upstreamModel }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      await configureCustomPiModel(actor, selectedModel, upstreamModel);
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();

      const prompt = `route ${selectedModel} through the custom Pi gateway`;
      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt,
          model: selectedModel,
        },
        usagePricingResolution,
      );
      const firstClaim = await claimChatRun(runnerGroup, run.runId);
      expect(firstClaim.claim.piModelConfig).toMatchObject({
        model: upstreamModel,
        ...(selectedModel.startsWith("gpt-") ? { thinkingLevel: "max" } : {}),
      });
      expect(firstClaim.claim.piModelConfig).not.toHaveProperty("serviceTier");
      await completeSandboxFirstPiRun({
        actor,
        run,
        claim: firstClaim,
        checkpointObjects,
        prompt,
        answer: `custom gateway sandbox answer for ${selectedModel}`,
        responsesModel: { provider: "openai", model: upstreamModel },
        usagePricingResolution,
      });

      await expect(
        readRunLaunchSnapshotFixture(context, run.runId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: "pi" },
      });
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
          const claim = await claimChatRun(runnerGroup, continuation.runId);
          expect(claim.claim.piModelConfig).toMatchObject({
            model: upstreamModel,
            thinkingLevel: "max",
          });
          if (tier === "fast") {
            expect(claim.claim.piModelConfig).toMatchObject({
              serviceTier: "priority",
            });
          } else {
            expect(claim.claim.piModelConfig).not.toHaveProperty("serviceTier");
          }
          await completeSandboxFirstPiRun({
            actor,
            run: continuation,
            claim,
            checkpointObjects,
            prompt: `continue the custom session with ${tier ?? "standard"}`,
            answer: `custom gateway sandbox answer for ${selectedModel}`,
            responsesModel: { provider: "openai", model: upstreamModel },
            usagePricingResolution,
          });
          await expect(
            readThreadSessionConversation(context, run.threadId),
          ).resolves.toMatchObject({
            agent_session_id: firstSession.agent_session_id,
            conversation_run_id: continuation.runId,
          });
          await expectNoBuiltInModelUsage(continuation.runId);
        }
      }
    },
    90_000,
  );

  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return (
        [
          { selectedModel, tier: undefined, outcome: "completed" },
          { selectedModel, tier: "fast", outcome: "completed" },
          { selectedModel, tier: "fast", outcome: "failed" },
          { selectedModel, tier: "fast", outcome: "cancelled" },
        ] as const
      ).filter(({ tier, outcome }) => {
        return (
          (tier === "fast" && outcome === "completed") ||
          (selectedModel === "gpt-5.6-terra" && tier === undefined) ||
          (selectedModel === "gpt-5.6-sol" && outcome === "failed") ||
          (selectedModel === "gpt-5.6-luna" && outcome === "cancelled")
        );
      });
    }),
  )(
    "keeps custom $selectedModel $tier captured policy and $outcome Sandbox settlement unbilled",
    async ({ selectedModel, tier, outcome }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const firewall = createFirewallApi(context);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const prompt = "hand off the custom gateway run exactly once";
      const run = await sendChatRun(
        actor,
        {
          agentId,
          model: selectedModel,
          prompt,
          runOptions: { codexServiceTier: tier },
        },
        usagePricingResolution,
      );
      const { manifest, session: h0 } = expectPiSandboxHandoff(
        run.runId,
        objects,
      );
      if (!h0) {
        throw new Error("Expected the synthesized first-turn Pi session");
      }
      expect(h0.toString("utf8")).not.toMatch(/serviceTier|service_tier/);
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
      // Mutating current settings after run admission cannot rewrite the captured claim.

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

      const history = MemoryPiSession.fromJsonl(h0.toString("utf8"));
      history.appendMessage({ role: "user", content: prompt, timestamp: 1 });
      history.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "custom Sandbox completion" }],
        api: "openai-responses",
        provider: "openai",
        model: gateway.upstreamModel,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
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
      await expectNoBuiltInModelUsage(run.runId);
      expect(
        JSON.stringify({
          h2,
          events: (await chat.listThreadEvents(actor, run.threadId)).events,
        }),
      ).not.toContain(gateway.secret);
    },
    90_000,
  );

  it.each([
    { selectedModel: "gpt-5.6-terra", removed: "mapping" },
    { selectedModel: "gpt-5.6-terra", removed: "connection" },
    { selectedModel: "gpt-5.6-sol", removed: "mapping" },
    { selectedModel: "gpt-5.6-luna", removed: "connection" },
    { selectedModel: "deepseek-v4.1-flash", removed: "mapping" },
  ] as const)(
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
      const clientEventId = randomUUID();
      const sent = await chat.requestSendEvent(
        actor,
        {
          agentId,
          clientEventId,
          model: selectedModel,
          prompt: "fail the unavailable custom route before any model call",
          ...(selectedModel === "deepseek-v4.1-flash"
            ? {}
            : { runOptions: { codexServiceTier: "fast" as const } }),
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the custom route send to be accepted");
      }
      expect(sent.body.runId).toBeNull();
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
      await flushWaitUntilForTest();
      const rejected = await waitForThreadMessages(
        actor,
        sent.body.threadId,
        (items) => {
          return (
            userMessages(items).some((message) => {
              return (
                message.eventType === "input.rejected" &&
                message.revokesEventId === clientEventId
              );
            }) &&
            assistantMessages(items).some((message) => {
              return message.eventType === "output.error";
            })
          );
        },
      );
      expect(
        userMessages(rejected.events).filter((message) => {
          return message.revokesEventId === clientEventId;
        }),
      ).toStrictEqual([
        expect.objectContaining({
          eventType: "input.rejected",
          error: "provider_unavailable",
        }),
      ]);
      expect(
        assistantMessages(rejected.events).filter((message) => {
          return message.eventType === "output.error";
        }),
      ).toStrictEqual([
        expect.objectContaining({ error: "provider_unavailable" }),
      ]);
    },
    90_000,
  );

  it.each(["gpt-5.6-terra", "deepseek-v4.1-flash"] as const)(
    "preserves captured custom %s credentials after gateway removal without substitution",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const firewall = createFirewallApi(context);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const prompt = "retain the captured custom credential authority";
      const run = await sendChatRun(
        actor,
        {
          agentId,
          model: selectedModel,
          prompt,
          ...(selectedModel === "deepseek-v4.1-flash"
            ? {}
            : { runOptions: { codexServiceTier: "fast" as const } }),
        },
        usagePricingResolution,
      );
      await accept(
        setupApp({ context, routes: modelProviderGatewayRoutes })(
          modelProviderConnectionsByIdContract,
        ).delete({
          headers: sessionHeaders(actor),
          params: { id: gateway.connection.id },
        }),
        [204],
      );
      const claim = await claimChatRun(runnerGroup, run.runId);
      expect(claim.claim.piModelConfig).toMatchObject({
        model: gateway.upstreamModel,
        ...(selectedModel === "deepseek-v4.1-flash"
          ? {}
          : { serviceTier: "priority" }),
      });
      expect(JSON.stringify(claim.claim)).not.toContain(gateway.secret);
      if (!claim.claim.encryptedSecrets) {
        throw new Error("Expected captured custom credentials");
      }
      const resolved = await firewall.requestFirewallAuth(
        claim.sandboxHeaders,
        {
          encryptedSecrets: claim.claim.encryptedSecrets,
          authHeaders: {
            "x-api-key": `Key ${secretTemplate("OKOU_MODEL_PROVIDER_API_KEY")}`,
          },
          secretConnectorMap: claim.claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      expect(resolved.body).toMatchObject({
        headers: { "x-api-key": `Key ${gateway.secret}` },
      });
      await completeSandboxFirstPiRun({
        actor,
        run,
        claim,
        checkpointObjects: objects,
        prompt,
        answer: "captured custom credential",
        responsesModel: { provider: "openai", model: gateway.upstreamModel },
        usagePricingResolution,
      });
      await expectNoBuiltInModelUsage(run.runId);
      for (const bytes of objects.values()) {
        expect(bytes.toString("utf8")).not.toContain(gateway.secret);
      }
    },
    90_000,
  );

  it.each(["gpt-5.6-terra"] as const)(
    "promotes queued custom %s Fast with the admitted tier and switch snapshot",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup, providerId } =
        await entitledChatActor();
      // The anchor must stay on the native Runner while the queued target
      // proves Pi promotion; Sonnet 5 would itself run through Pi.
      await api.updateOrgModelPolicies(actor, [
        {
          model: "claude-fable-5-1",
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the target thread",
        model: "claude-fable-5-1",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
      const gateway = await configureCustomPiModel(actor, selectedModel);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
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
      const claim = await claimChatRun(runnerGroup, promoted.runId);
      expect(claim.claim.cliAgentType).toBe("pi");
      expect(claim.claim.piModelConfig).toMatchObject({
        model: gateway.upstreamModel,
        serviceTier: "priority",
        thinkingLevel: "max",
      });
      await expect(
        readRunLaunchSnapshotFixture(context, promoted.runId),
      ).resolves.toMatchObject({ launch_snapshot: { framework: "pi" } });
      await cancelChatRun(actor, promoted.runId, claim.sandboxHeaders);
      await expectNoBuiltInModelUsage(promoted.runId);
    },
    90_000,
  );

  it.each([
    { selectedModel: "gpt-6-astra", tier: undefined },
    { selectedModel: "gpt-6-astra", tier: "fast" },
  ] as const)(
    "keeps custom $selectedModel $tier inside its existing runtime boundary",
    async ({ selectedModel, tier }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
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
});
