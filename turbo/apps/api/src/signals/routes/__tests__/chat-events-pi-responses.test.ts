import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import { createHash, randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import {
  insertCatalogModelFixture,
  setModelPiRouteClassFixture,
} from "../../../test-fixtures/model-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  GPT_API_KEY_BDD_ROUTES,
  requireOrgId,
  createGptUsagePricingResolution,
  claimEnvironment,
  userMessages,
  eventBackedContents,
  modelProviderSecretPlaceholder,
  occurrences,
} from "./helpers/chat-events-fixture";

const context = testContext({ connectorCatalog: true });
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
  upsertOrgModelProvider,
  claimGptPiSandbox,
  mockPiCheckpointObjectStore,
  completeSandboxFirstPiRun,
  piSandboxBaseSession,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

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

async function expectApiKeyGptSandboxCredential(
  claim: Awaited<ReturnType<typeof api.claimRunnerJob>>,
  sandboxHeaders: { readonly authorization: string },
  route: (typeof GPT_API_KEY_BDD_ROUTES)[number],
  secret: string,
): Promise<void> {
  if (!claim.encryptedSecrets) {
    throw new Error("Expected API-key claim credentials");
  }
  const credential = await createFirewallApi(context).requestFirewallAuth(
    sandboxHeaders,
    {
      encryptedSecrets: claim.encryptedSecrets,
      authHeaders: {
        Authorization: `Bearer ${secretTemplate(route.secretName)}`,
      },
      secretConnectorMap: claim.secretConnectorMap ?? undefined,
      secretConnectorMetadataMap: claim.secretConnectorMetadataMap ?? undefined,
    },
    [200],
  );
  if (credential.status !== 200) {
    throw new Error("Expected API-key firewall credential");
  }
  expect(credential.body.headers.Authorization).toBe(`Bearer ${secret}`);
  expect(credential.body.resolvedSecrets).toStrictEqual([route.secretName]);
}

describe("CHAT-02: model-first provider policies", () => {
  it.each(
    (
      [
        "deepseek-v4-flash",
        "deepseek-v4.1-flash",
        "gpt-6-luna",
        "gpt-5.6-sol",
      ] as const
    ).flatMap((selectedModel) => {
      // The other DeepSeek US-on routes are covered per model by the
      // provider-policy matrix; v4-flash still exercises the fallback route.
      const usSwitchValues =
        selectedModel === "deepseek-v4.1-flash" ? [false] : [false, true];
      return usSwitchValues.map((usRoutingEnabled) => {
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
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const model = await configureBuiltInPiModelOnOpenRouter(
        actor,
        selectedModel,
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.OpenRouterUsRouting]: usRoutingEnabled,
        },
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();

      const run = await sendChatRun(actor, {
        agentId,
        prompt: `run ${selectedModel} on its managed fallback`,
        model,
      });
      await flushWaitUntilForTest();

      const { claim } = await claimChatRun(runnerGroup, run.runId);
      expect(claim.cliAgentType).toBe("pi");
      // Only the approved Sol route uses the US endpoint; the GPT 6 pair
      // stays on the global OpenRouter endpoint even when enabled.
      expect(claim.piModelConfig).toMatchObject({
        provider: "openrouter",
        baseUrl:
          selectedModel === "gpt-5.6-sol" && usRoutingEnabled
            ? "https://us.openrouter.ai/api/v1"
            : "https://openrouter.ai/api/v1",
        model: `${selectedModel.startsWith("deepseek") ? "deepseek" : "openai"}/${selectedModel}`,
      });
      await expectThreadModelCredits(context, actor, run.threadId, 0);
      await cancelChatRun(actor, run.runId);
    },
    90_000,
  );

  it("launches a model on the runtime its catalog Pi route class selects", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const model = await configureBuiltInPiModelOnOpenRouter(
      actor,
      "gpt-6-luna",
    );
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const launch = async (prompt: string) => {
      const run = await sendChatRun(actor, {
        agentId,
        prompt,
        model,
      });
      await flushWaitUntilForTest();
      const { claim } = await claimChatRun(runnerGroup, run.runId);
      await cancelChatRun(actor, run.runId);
      return { claim };
    };

    // An operator takes the model off Pi: it launches on its vendor harness.
    const restore = await setModelPiRouteClassFixture(model, null);
    const vendor = await launch("run on the vendor harness");
    await restore();
    expect(vendor.claim.cliAgentType).toBe("codex");

    // The seeded `gpt-codex` class launches the same route on Pi.
    const pi = await launch("run on Pi");
    expect(pi.claim.cliAgentType).toBe("pi");
    expect(pi.claim.piModelConfig).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-6-luna",
    });
  });

  it("launches a catalog-only model on Pi through its route's upstream model", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    // Only run_model_catalog and model_routes rows exist for this model: no
    // static list names it. Its Built-in route reuses the OpenRouter Codex
    // protocol and an upstream model the pinned Pi runtime resolves.
    const model = `catalog-pi-${randomUUID()}`;
    const restore = await insertCatalogModelFixture({
      model,
      displayName: "Catalog Pi",
      sortOrder: 100_000,
      piRouteClass: "gpt-codex",
      builtInRoutes: [
        {
          concreteProviderType: "openrouter-codex",
          upstreamModel: "openai/gpt-6-luna",
          priority: 0,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
      ],
    });
    onTestFinished(restore);
    await seedBuiltInModelCandidateKeys(context, model);
    await api.updateOrgModelPolicies(actor, [
      {
        model,
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run the catalog-only model on Pi",
      model,
      runOptions: { reasoningEffort: "high" },
    });
    await flushWaitUntilForTest();

    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      source: {
        providerType: "built-in",
        runtimeProviderType: "openrouter-codex",
        model,
      },
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    expect(claim).toMatchObject({
      cliAgentType: "pi",
      // Built-in usage is billed under the route's pricing link
      // (`usage_pricing` provider = the model ID).
      modelUsageProvider: model,
    });
    expect(claim.piModelConfig).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-6-luna",
      thinkingLevel: "high",
    });
    await cancelChatRun(actor, run.runId);
  });

  it("transfers pre-migration OpenRouter Chat JSONL by reference", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const usagePricingResolution = await createGptUsagePricingResolution();
    const model = await configureBuiltInPiModelOnOpenRouter(
      actor,
      "gpt-6-luna",
    );

    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const seedPrompt = "seed the canonical Pi binding";
    const first = await sendChatRun(
      actor,
      {
        agentId,
        prompt: seedPrompt,
        model,
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
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
      model: "openai/gpt-6-luna",
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
      model: "openai/gpt-6-luna",
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
    const legacyHash = createHash("sha256").update(legacyJsonl).digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: first.runId,
        hash: legacyHash,
        rawSize: Buffer.byteLength(legacyJsonl),
        encodedSize: Buffer.byteLength(legacyJsonl),
        encoding: "identity",
      },
      firstClaim.sandboxHeaders,
      [200],
    );
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${legacyHash}.blob`,
      Buffer.from(legacyJsonl, "utf8"),
    );
    await webhooks.requestAgentEvents(
      {
        runId: first.runId,
        events: [
          {
            type: "result",
            sequenceNumber: 1,
            result: "legacy API tool conclusion",
          },
        ],
      },
      firstClaim.sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: first.runId,
        exitCode: 0,
        lastEventSequence: 1,
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: first.threadId,
          cliAgentSessionHistoryHash: legacyHash,
        },
      },
      firstClaim.sandboxHeaders,
      [200],
      undefined,
      usagePricingResolution,
    );
    await waitForRunStatus(actor, first.runId, "completed");
    await flushWaitUntilForTest();

    const prompt = "continue the migrated OpenRouter session";
    const second = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt,
        model,
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    const claim = await claimChatRun(runnerGroup, second.runId);
    const resumeSession = claim.claim.resumeSession;
    if (!resumeSession || !("historyRef" in resumeSession)) {
      throw new Error("Expected referenced historical Pi session");
    }
    expect(resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: {
        kind: "blob",
        hash: legacyHash,
        encoding: "identity",
        rawSize: Buffer.byteLength(legacyJsonl),
      },
    });
    expect(
      new URL(resumeSession.historyRef.url).searchParams.get("object"),
    ).toBe(`${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${legacyHash}.blob`);
    expect(
      piSandboxBaseSession(claim.claim, checkpointObjects).toString("utf8"),
    ).toBe(legacyJsonl);
    for (const marker of [
      "legacy API user context",
      "legacy API reasoning context",
      "legacy API tool output",
      "legacy API tool conclusion",
    ]) {
      expect(occurrences(legacyJsonl, marker)).toBe(1);
    }
    await cancelChatRun(actor, second.runId, claim.sandboxHeaders);
  }, 90_000);

  it.each(["gpt-6-luna"] as const)(
    "reuses one OpenRouter Responses Pi session across standard, fast, and standard turns for %s",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      const model = await configureBuiltInPiModelOnOpenRouter(
        actor,
        selectedModel,
      );

      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const prompts = [
        "start standard Luna in the canonical Pi session",
        "continue fast Luna in the same Pi session",
        "return to standard Luna in the same Pi session",
      ] as const;
      const answers = [
        "first standard Luna answer",
        "fast Luna answer",
        "returned standard Luna answer",
      ] as const;

      const first = await sendChatRun(
        actor,
        {
          agentId,
          prompt: prompts[0],
          model,
        },
        usagePricingResolution,
      );
      await flushWaitUntilForTest();
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.piModelConfig).toMatchObject({
        model: `openai/${selectedModel}`,
      });
      expect(firstClaim.claim.piModelConfig).not.toHaveProperty("serviceTier");
      await completeSandboxFirstPiRun({
        actor,
        answer: answers[0],
        checkpointObjects,
        claim: firstClaim,
        prompt: prompts[0],
        run: first,
        responsesModel: { provider: "openai", model: selectedModel },
        usagePricingResolution,
      });
      const firstSessionId = await readCompletedRunSessionId(
        context,
        actor,
        first.runId,
      );

      const fast = await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt: prompts[1],
          model,
          runOptions: { codexServiceTier: "fast" },
        },
        usagePricingResolution,
      );
      await flushWaitUntilForTest();
      const fastClaim = await claimChatRun(runnerGroup, fast.runId);
      expect(fastClaim.claim.piModelConfig).toMatchObject({
        model: `openai/${selectedModel}`,
        serviceTier: "priority",
      });
      await completeSandboxFirstPiRun({
        actor,
        answer: answers[1],
        checkpointObjects,
        claim: fastClaim,
        prompt: prompts[1],
        run: fast,
        responsesModel: { provider: "openai", model: selectedModel },
        usagePricingResolution,
      });
      await expect(
        readCompletedRunSessionId(context, actor, fast.runId),
      ).resolves.toBe(firstSessionId);

      await chat.updateThreadModelSelection(actor, first.threadId, model, {
        codexServiceTier: null,
      });
      const returned = await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt: prompts[2],
          model,
        },
        usagePricingResolution,
      );
      await flushWaitUntilForTest();
      const returnedClaim = await claimChatRun(runnerGroup, returned.runId);
      expect(returnedClaim.claim.piModelConfig).toMatchObject({
        model: `openai/${selectedModel}`,
      });
      expect(returnedClaim.claim.piModelConfig).not.toHaveProperty(
        "serviceTier",
      );
      await completeSandboxFirstPiRun({
        actor,
        answer: answers[2],
        checkpointObjects,
        claim: returnedClaim,
        prompt: prompts[2],
        run: returned,
        responsesModel: { provider: "openai", model: selectedModel },
        usagePricingResolution,
      });
      await expect(
        readCompletedRunSessionId(context, actor, returned.runId),
      ).resolves.toBe(firstSessionId);

      for (const run of [first, fast, returned]) {
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

      await expectThreadModelCredits(context, actor, first.threadId, 0);
      await expectThreadModelCredits(context, actor, fast.threadId, 0);
      await expectThreadModelCredits(context, actor, returned.threadId, 0);

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

  it.each(["gpt-6-luna"] as const)(
    "promotes queued fast %s to a priority Pi Sandbox run",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup, providerId } =
        await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      // The anchor must stay on the native Runner while the queued target
      // proves Pi promotion; Sonnet 5 would itself run through Pi.
      await api.updateOrgModelPolicies(actor, [
        {
          model: "claude-fable-5-1",
          preferred: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the thread before queued fast Luna",
        model: "claude-fable-5-1",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

      await configureBuiltInPiModel(actor, selectedModel);

      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const prompt = "promote queued fast Luna through the callback";
      const answer = "queued fast Luna Sandbox answer";

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
        throw new Error("Expected queued fast Luna to enter the chat queue");
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
        throw new Error("Expected queued fast Luna to create a run");
      }
      const promotedRunId = promoted.runId;
      await flushWaitUntilForTest();

      const promotedClaim = await claimChatRun(runnerGroup, promotedRunId);
      expect(promotedClaim.claim.cliAgentType).toBe("pi");
      expect(promotedClaim.claim.piModelConfig).toMatchObject({
        model: selectedModel,
        serviceTier: "priority",
      });
      await completeSandboxFirstPiRun({
        actor,
        answer,
        checkpointObjects,
        claim: promotedClaim,
        prompt,
        run: { runId: promotedRunId, threadId: anchor.threadId },
        responsesModel: { provider: "openai", model: selectedModel },
        usagePricingResolution,
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

  const outcomeRepresentativeModels = {
    "openai-api-key": {
      standard: "gpt-6-luna",
      failed: "gpt-5.6-sol",
      cancelled: "gpt-5.6-luna",
    },
    "openrouter-codex": {
      standard: "gpt-5.6-sol",
      failed: "gpt-5.6-luna",
      cancelled: "gpt-6-luna",
    },
    "vercel-ai-gateway-codex": {
      standard: "gpt-5.6-luna",
      failed: "gpt-5.6-sol",
      cancelled: "gpt-5.6-luna",
    },
  } as const;

  it.each(
    GPT_API_KEY_BDD_ROUTES.flatMap((route) => {
      const representative = outcomeRepresentativeModels[route.type];
      return (
        [
          { ...route, tier: undefined, generation: 2, outcome: "completed" },
          { ...route, tier: "fast", generation: 3, outcome: "completed" },
          { ...route, tier: "fast", generation: 3, outcome: "failed" },
          { ...route, tier: "fast", generation: 3, outcome: "cancelled" },
        ] as const
      ).filter(({ tier, outcome }) => {
        return (
          (tier === "fast" && outcome === "completed") ||
          (tier === undefined &&
            route.selectedModel === representative.standard) ||
          (outcome === "failed" &&
            route.selectedModel === representative.failed) ||
          (outcome === "cancelled" &&
            route.selectedModel === representative.cancelled)
        );
      });
    }),
  )(
    "runs $name API-key $tier through the generation-$generation Sandbox with $outcome and credential rotation",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const initialSecret = `${route.type}-initial-secret`;
      const providerId = await configureApiKeyGptPiModel(
        actor,
        route,
        initialSecret,
      );
      const usagePricingResolution = await createGptUsagePricingResolution();
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();

      const firstPrompt = `use ${route.name} in the Sandbox`;
      const first = await sendChatRun(actor, {
        agentId,
        prompt: firstPrompt,
        model: route.selectedModel,
        runOptions: { codexServiceTier: route.tier },
      });
      await flushWaitUntilForTest();
      await expectThreadModelCredits(context, actor, first.threadId, 0);

      await api.heartbeatRunner(runnerGroup);
      const claim = await claimGptPiSandbox(actor, first.runId, route.tier);
      const sandboxHeaders = {
        authorization: `Bearer ${claim.sandboxToken}`,
      };
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piSessionId).toBe(first.threadId);
      expect(claim.resumeSession).toBeNull();
      expectApiKeyGptSandboxCarrier(claim, route, route.tier);
      expect(JSON.stringify(claim)).not.toContain(initialSecret);
      await expectApiKeyGptSandboxCredential(
        claim,
        sandboxHeaders,
        route,
        initialSecret,
      );

      const h0Bytes = piSandboxBaseSession(claim, checkpointObjects);
      const h2Session = MemoryPiSession.fromJsonl(h0Bytes.toString("utf8"));
      const sandboxAnswer = `${route.name} Sandbox completion`;
      h2Session.appendMessage({
        role: "user",
        content: firstPrompt,
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
      expect(h0Bytes.toString("utf8")).not.toMatch(/serviceTier|service_tier/);
      expect(h0Bytes.toString("utf8")).not.toContain(initialSecret);
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
      await webhooks.requestAgentEvents(
        {
          runId: first.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 1,
              message: {
                content: [{ type: "text", text: sandboxAnswer }],
              },
            },
            {
              type: "result",
              sequenceNumber: 2,
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
          lastEventSequence: 2,
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
      await expectThreadModelCredits(context, actor, first.threadId, 0);
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
      const firstSession = await readCompletedRunSessionId(
        context,
        actor,
        first.runId,
      );

      const followUpPrompt = `continue the same ${route.name} credential`;
      const followUp = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: followUpPrompt,
        model: route.selectedModel,
        runOptions: { codexServiceTier: route.tier },
      });
      await flushWaitUntilForTest();
      const followUpClaim = await claimChatRun(runnerGroup, followUp.runId);
      expect(followUpClaim.claim.resumeSession).toMatchObject({
        sessionId: first.threadId,
        historyRef: { kind: "blob", hash: h2Hash },
      });
      expectApiKeyGptSandboxCarrier(followUpClaim.claim, route, route.tier);
      await completeSandboxFirstPiRun({
        actor,
        run: followUp,
        claim: followUpClaim,
        checkpointObjects,
        prompt: followUpPrompt,
        answer: `${route.name} Sandbox follow-up`,
        responsesModel: {
          provider: "openai",
          model: route.runtimeModel,
        },
        usagePricingResolution,
      });
      await expect(
        readCompletedRunSessionId(context, actor, followUp.runId),
      ).resolves.toBe(firstSession);
      await expectThreadModelCredits(context, actor, followUp.threadId, 0);

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
      await flushWaitUntilForTest();
      const rotatedClaim = await claimChatRun(runnerGroup, rotated.runId);
      expectApiKeyGptSandboxCarrier(rotatedClaim.claim, route, route.tier);
      await expectApiKeyGptSandboxCredential(
        rotatedClaim.claim,
        rotatedClaim.sandboxHeaders,
        route,
        rotatedSecret,
      );
      await completeSandboxFirstPiRun({
        actor,
        run: rotated,
        claim: rotatedClaim,
        checkpointObjects,
        prompt: `continue after rotating the ${route.name} credential`,
        answer: `${route.name} rotated Sandbox completion`,
        responsesModel: {
          provider: "openai",
          model: route.runtimeModel,
        },
        usagePricingResolution,
      });
      await expect(
        readCompletedRunSessionId(context, actor, rotated.runId),
      ).resolves.toBe(firstSession);
      await expectThreadModelCredits(context, actor, rotated.threadId, 0);
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
});
