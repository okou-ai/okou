import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import { createHash, randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  getSecretKmsClient,
  setSecretKmsClientForTests,
} from "../../../lib/secret-kms-client";

import {
  insertCatalogModelFixture,
  setModelPiRouteClassFixture,
} from "../../../test-fixtures/model-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";

import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

import {
  createChatEventsFixture,
  configureNativeCliArtifact,
  requireOrgId,
  createGptUsagePricingResolution,
  userMessages,
  eventBackedContents,
  occurrences,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  chatCallbacks,
  entitledChatActor,
  configureBuiltInPiModel,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  mockPiCheckpointObjectStore,
  completeSandboxFirstPiRun,
  piSandboxBaseSession,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

async function configureResponsesWithOwnedRuns(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly selectedModel: "okou-1.0" | "gpt-6-luna";
}): Promise<{
  readonly model: string;
  readonly sendChatRun: typeof sendChatRun;
  readonly claimChatRun: typeof claimChatRun;
  readonly cancelChatRun: typeof cancelChatRun;
}> {
  const model = args.selectedModel;

  await seedBuiltInModelCandidateKeys(context, model);
  const owned = new Map<
    string,
    {
      readonly actor: ApiTestUser;
      readonly usagePricingResolution: Parameters<typeof sendChatRun>[2];
      readonly restoreExternalState: () => void;
      sandboxToken?: string;
      finished: boolean;
    }
  >();

  async function cleanupOwnedRuns(): Promise<void> {
    const cleanupRuns = createRunsApi(context);
    const cleanupWebhooks = createWebhookCallbackApi(context);
    for (const [runId, run] of owned) {
      if (run.finished) {
        continue;
      }
      const current = await cleanupRuns.readRun(run.actor, runId);
      if (
        current.status === "pending" ||
        current.status === "running" ||
        current.status === "cancelled"
      ) {
        run.restoreExternalState();
        cleanupRuns.acceptTelemetryIngest();
        context.mocks.ably.publish.mockResolvedValue(undefined);
        if (current.status !== "cancelled") {
          await cleanupRuns.requestCancelRun(
            run.actor,
            runId,
            [200],
            run.usagePricingResolution,
          );
        }
        if (run.sandboxToken) {
          await cleanupWebhooks.requestAgentComplete(
            { runId, exitCode: 1, error: "Cancelled OpenRouter test Run" },
            { authorization: `Bearer ${run.sandboxToken}` },
            [200],
            undefined,
            run.usagePricingResolution,
          );
        }
      }
      await flushWaitUntilForTest();
      run.finished = true;
    }
  }

  // These selected callbacks own every main Run before its first claim. This
  // hook and the producer hook both finish Runs before releasing model state.
  onTestFinished(cleanupOwnedRuns);

  async function sendOwnedRun(...parameters: Parameters<typeof sendChatRun>) {
    const run = await sendChatRun(...parameters);
    const storage = context.mocks.s3.send.getMockImplementation();
    const signedUrl = context.mocks.s3.getSignedUrl.getMockImplementation();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    const kms = getSecretKmsClient();
    owned.set(run.runId, {
      actor: parameters[0],
      usagePricingResolution: parameters[2],
      finished: false,
      restoreExternalState() {
        mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
        mockOptionalEnv("SECRETS_KMS_KEY_ID", kmsKey);
        setSecretKmsClientForTests(kms);
        if (storage) {
          context.mocks.s3.send.mockImplementation(storage);
        }
        if (signedUrl) {
          context.mocks.s3.getSignedUrl.mockImplementation(signedUrl);
        }
      },
    });
    return run;
  }

  async function claimOwnedRun(...parameters: Parameters<typeof claimChatRun>) {
    const claim = await claimChatRun(...parameters);
    const run = owned.get(parameters[1]);
    if (!run) {
      throw new Error("Expected to own the claimed OpenRouter test Run");
    }
    run.sandboxToken = claim.claim.sandboxToken;
    return claim;
  }

  async function cancelOwnedRun(
    ...parameters: Parameters<typeof cancelChatRun>
  ): Promise<void> {
    const run = owned.get(parameters[1]);
    if (!run?.sandboxToken) {
      throw new Error("Expected a claimed OpenRouter test Run to cancel");
    }
    await cancelChatRun(
      parameters[0],
      parameters[1],
      parameters[2] ?? { authorization: `Bearer ${run.sandboxToken}` },
    );
    run.finished = true;
  }

  await (model === "okou-1.0"
    ? configureBuiltInPiModel(args.actor, model)
    : configureSubscriptionPiModel(args.actor, {}, model));
  // DeepSeek's direct candidate is ineligible for managed routing, so its
  // ordinary launch already selects OpenRouter. GPT first reports the actual
  // primary through a separate claimed Run on this test-owned mirror.

  return {
    model,
    sendChatRun: sendOwnedRun,
    claimChatRun: claimOwnedRun,
    cancelChatRun: cancelOwnedRun,
  };
}

describe("CHAT-02: model-first provider policies", () => {
  it.each(
    [false, true].map((usRoutingEnabled) => {
      return { selectedModel: "okou-1.0" as const, usRoutingEnabled };
    }),
  )(
    "runs built-in $selectedModel OpenRouter Responses with US switch $usRoutingEnabled",
    async ({ selectedModel, usRoutingEnabled }) => {
      configureNativeCliArtifact();
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const { model, sendChatRun, claimChatRun, cancelChatRun } =
        await configureResponsesWithOwnedRuns({
          actor,
          agentId,
          runnerGroup,
          selectedModel,
        });
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
        baseUrl: "https://openrouter.ai/api/v1",
        model: "@preset/okou-1-0",
      });
      await expectThreadModelCredits(context, actor, run.threadId, 0);
      await cancelChatRun(actor, run.runId);
    },
    90_000,
  );

  it("launches a model on the runtime its catalog Pi route class selects", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const { model, sendChatRun, claimChatRun, cancelChatRun } =
      await configureResponsesWithOwnedRuns({
        actor,
        agentId,
        runnerGroup,
        selectedModel: "okou-1.0",
      });
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
    expect(vendor.claim.cliAgentType).toBe("pi");

    // The seeded `gpt-codex` class launches the same route on Pi.
    const pi = await launch("run on Pi");
    expect(pi.claim.cliAgentType).toBe("pi");
    expect(pi.claim.piModelConfig).toMatchObject({
      provider: "openrouter",
      model: "@preset/okou-1-0",
    });
  });

  it("does not admit a catalog-only platform model or replace fixed Auto", async () => {
    const { actor, agentId } = await entitledChatActor();
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
    const models = await api.listRunModels(actor);
    expect(models.models).not.toContainEqual(
      expect.objectContaining({ model }),
    );
    expect(
      models.models
        .filter((entry) => {
          return entry.defaultProviderType === "built-in";
        })
        .map((entry) => {
          return entry.model;
        }),
    ).toStrictEqual(["okou-1.0"]);
    const rejected = await chat.requestCreateThread(
      actor,
      { agentId, model },
      [400],
    );
    expect(rejected.status).toBe(400);
  });

  it("transfers pre-migration OpenRouter Chat JSONL by reference", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const usagePricingResolution = await createGptUsagePricingResolution();
    const { model, sendChatRun, claimChatRun, cancelChatRun } =
      await configureResponsesWithOwnedRuns({
        actor,
        agentId,
        runnerGroup,
        selectedModel: "okou-1.0",
      });

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
      const { model, sendChatRun, claimChatRun } =
        await configureResponsesWithOwnedRuns({
          actor,
          agentId,
          runnerGroup,
          selectedModel,
        });

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
        responsesModel: { provider: "openai-codex", model: selectedModel },
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
        responsesModel: { provider: "openai-codex", model: selectedModel },
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
        responsesModel: { provider: "openai-codex", model: selectedModel },
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
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      // The anchor must stay on the native Runner while the queued target
      // proves Pi promotion; Sonnet 5 would itself run through Pi.
      await api.updateUserModelPreference(actor, "claude-fable-5-1");
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the thread before queued fast Luna",
        model: "claude-fable-5-1",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

      await configureSubscriptionPiModel(actor, {}, selectedModel);

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
        responsesModel: { provider: "openai-codex", model: selectedModel },
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
});
