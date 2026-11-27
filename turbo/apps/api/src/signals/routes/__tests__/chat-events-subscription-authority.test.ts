import { randomUUID } from "node:crypto";

import { chatThreadModelSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import {
  clearMockedEnv,
  env,
  mockEnv,
  mockOptionalEnv,
  optionalEnv,
} from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadModelSelectionRoutes } from "../chat-threads-model-selection";
import { logsRoutes } from "../logs";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { usageRecordRoutes } from "../usage-record";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  makeCodexAuthJson,
  mockClaudeCodeTokenEndpoint,
} from "./helpers/api-bdd-auth-device";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
  userMessages,
} from "./helpers/chat-events-fixture";
import { expectThreadModelCredits } from "./helpers/public-thread-usage";

const LUNA_MODEL = "gpt-6-luna";
const FABLE_MODEL = "claude-fable-5-1";
const WARMUP_UUID = "00000000-0000-4000-8000-000000000001";

const WARMUP_ROUTES = Object.freeze([
  ...webhooksClerkRoutes,
  ...onboardingCompleteRoutes,
  ...runnersRoutes,
  ...meModelProvidersUpsertRoutes,
  ...meModelProviderAccountRoutes,
  ...chatEventsRoutes,
  ...chatThreadRoutes,
  ...chatThreadModelSelectionRoutes,
  ...webhooksAgentCompleteRoutes,
  ...webhooksAgentFirewallAuthRoutes,
  ...usageRecordRoutes,
  ...runsRoutes,
  ...runsCancelRoutes,
  ...logsRoutes,
]);

describe("chat-events-subscription-authority", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const fixture = createChatEventsFixture(context);
  const firewall = createFirewallApi(context);
  const runReads = createRunReadsApi(context);

  const warmupApp = setupAppWithRoutes({
    context,
    routes: WARMUP_ROUTES,
  });

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup_sub_auth");
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );

    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(
          warmupApp(webhookClerkContract).post({
            body: "{}",
            extraHeaders: {},
          }),
          [401],
        ),
        accept(
          warmupApp(onboardingCompleteContract).complete({
            headers: {},
            body: {},
          }),
          [401],
        ),
        accept(
          warmupApp(runnersHeartbeatContract).heartbeat({
            headers: {},
            body: {
              runnerId: WARMUP_UUID,
              group: "vm0/warmup",
              snapshotGeneration: 1,
              snapshotSequence: 1,
              totalVcpu: 8,
              totalMemoryMb: 16_384,
              maxConcurrent: 2,
              allocatedVcpu: 0,
              allocatedMemoryMb: 0,
              runningCount: 0,
              admittableProfiles: ["vm0/default"],
              heldSandboxStates: [],
              heldHomeStates: [],
              activeReuseProducers: [],
              mode: "running",
            },
          }),
          [401],
        ),
        accept(
          warmupApp(personalModelProvidersMainContract).upsert({
            headers: {},
            body: {
              type: "claude-code-oauth-token",
              secret: "warmup",
            },
          }),
          [401],
        ),
        accept(
          warmupApp(personalModelProviderAccountsByIdContract).delete({
            headers: {},
            params: { id: WARMUP_UUID },
          }),
          [401],
        ),
        accept(
          fixture.chatEventsClient().send({
            headers: {},
            body: {
              prompt: "warmup",
              hasTextContent: true,
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "warmup" }],
              },
            },
          }),
          [401],
        ),
        accept(
          fixture.chatThreadsClient().snapshot({
            headers: {},
          }),
          [401],
        ),
        accept(
          warmupApp(chatThreadModelSelectionContract).update({
            headers: {},
            params: { id: WARMUP_UUID },
            body: { model: LUNA_MODEL },
          }),
          [401],
        ),
        accept(
          warmupApp(webhookCompleteContract).complete({
            headers: {},
            body: { runId: WARMUP_UUID, exitCode: 0 },
          }),
          [401],
        ),
        accept(
          warmupApp(runWebhookContract).firewallAuth({
            headers: {},
            body: { authHeaders: {} },
          }),
          [401],
        ),
        accept(
          warmupApp(usageRecordContract).get({
            headers: {},
            query: {
              scope: "mine",
              range: "24h",
              tz: "UTC",
              page: 1,
              pageSize: 10,
            },
          }),
          [401],
        ),
        accept(
          warmupApp(runsByIdContract).getById({
            headers: {},
            params: { id: WARMUP_UUID },
          }),
          [401],
        ),
        accept(
          warmupApp(runsCancelContract).cancel({
            headers: {},
            params: { id: WARMUP_UUID },
          }),
          [401],
        ),
        accept(
          warmupApp(logsListContract).list({
            headers: {},
            query: { limit: 1 },
          }),
          [401],
        ),
      ]);
    });
    clearMockedEnv();
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  function createRunTracker(actor: ApiTestUser) {
    const activeRuns = new Map<string, string | undefined>();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    const runnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");

    onTestFinished(async () => {
      if (activeRuns.size === 0) {
        return;
      }
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
      mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
      if (runnerGroup) {
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", runnerGroup);
      }
      context.mocks.ably.publish.mockResolvedValue(undefined);
      await settleIncludingAbort(flushWaitUntilForTest);
      for (const [runId, sandboxToken] of activeRuns) {
        const run = await fixture.api.readRun(actor, runId);
        if (["queued", "pending", "running"].includes(run.status)) {
          await fixture.api.requestCancelRun(actor, runId, [200]);
        }
        if (
          sandboxToken &&
          !["completed", "failed", "timeout"].includes(run.status)
        ) {
          await fixture.webhooks.requestAgentComplete(
            { runId, exitCode: 1, error: "Run cancelled" },
            { authorization: `Bearer ${sandboxToken}` },
            [200],
          );
        }
      }
      await settleIncludingAbort(flushWaitUntilForTest);
    });

    return {
      track(runId: string, sandboxToken?: string): void {
        activeRuns.set(runId, sandboxToken);
      },
      finish(runId: string): void {
        activeRuns.delete(runId);
      },
    };
  }

  async function prepareSubscriptionMember(options: {
    readonly withClaude?: boolean;
    readonly entitled?: boolean;
    readonly codexAccountId?: string;
  }) {
    const actor = fixture.bdd.user();
    fixture.chatCallbacks.acceptChatObjectStorage();
    fixture.api.acceptStorageDownloads();
    fixture.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    fixture.chatCallbacks.disableVapid();

    const codexAccountId = options.codexAccountId ?? `acct_${randomUUID()}`;
    if (options.withClaude) {
      mockClaudeCodeTokenEndpoint();
    }
    const [codexProvider] = await Promise.all([
      fixture.api.createPersonalModelProvider(actor, {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accountId: codexAccountId,
            refreshToken: `rt_${randomUUID()}`,
          }),
        },
      }),
      fixture.api.configureRunnerGroup(),
      options.entitled
        ? fixture.api.grantProEntitlement(actor)
        : bdd.bootstrapLimitedFreeOnboarding(actor),
      options.withClaude
        ? fixture.api.createPersonalModelProvider(actor, {
            type: "claude-code-oauth-token",
            secret: "bdd-personal-claude-token",
          })
        : Promise.resolve(undefined),
    ]);

    const tracker = createRunTracker(actor);
    return {
      actor,
      codexProviderId: codexProvider.providerId,
      tracker,
    };
  }

  async function completePiRun(args: {
    readonly runId: string;
    readonly threadId: string;
    readonly sandboxToken: string;
    readonly tracker: ReturnType<typeof createRunTracker>;
  }): Promise<void> {
    await fixture.completeChatRunOk(
      args.runId,
      { authorization: `Bearer ${args.sandboxToken}` },
      {
        cliAgentType: "pi",
        cliAgentSessionId: args.threadId,
      },
    );
    args.tracker.finish(args.runId);
    await flushWaitUntilForTest();
  }

  async function completeClaudeRun(args: {
    readonly runId: string;
    readonly sandboxToken: string;
    readonly tracker: ReturnType<typeof createRunTracker>;
  }): Promise<void> {
    await fixture.completeChatRunOk(
      args.runId,
      { authorization: `Bearer ${args.sandboxToken}` },
      { cliAgentType: "claude-code" },
    );
    args.tracker.finish(args.runId);
    await flushWaitUntilForTest();
  }

  it(
    "chat-events-subscription-authority-007 (1/2) promotes queued agent-bearer Fast gpt-6-luna into Runner execution after busy Claude Fable completes",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tracker } = await prepareSubscriptionMember({
        withClaude: true,
      });

      const [busy, source] = await Promise.all([
        fixture.sendChatRun(actor, {
          model: FABLE_MODEL,
          prompt: "Busy Claude Fable target thread",
        }),
        fixture.sendChatRun(actor, {
          model: FABLE_MODEL,
          prompt: "Active source Claude Run holding bearer token",
        }),
      ]);
      const [busyExecution, sourceExecution] = await Promise.all([
        fixture.api.executionInput(busy.runId),
        fixture.api.executionInput(source.runId),
      ]);
      tracker.track(busy.runId, busyExecution.sandboxToken);
      tracker.track(source.runId, sourceExecution.sandboxToken);
      const agentBearerToken = okouTokenFromExecution(sourceExecution);

      const clientEventId = randomUUID();
      const sent = await fixture.requestSendEventWithBearer(
        agentBearerToken,
        {
          threadId: busy.threadId,
          model: LUNA_MODEL,
          runOptions: { codexServiceTier: "fast" },
          clientEventId,
          prompt: "Queued Fast Luna from agent bearer token",
        },
        [201],
      );
      expect(sent.status).toBe(201);
      await flushWaitUntilForTest();

      await completeClaudeRun({
        runId: busy.runId,
        sandboxToken: busyExecution.sandboxToken,
        tracker,
      });

      const events = await fixture.chat.listThreadEvents(actor, busy.threadId);
      const replacement = userMessages(events.events).find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === clientEventId &&
          event.runId !== undefined
        );
      });
      expect(replacement?.runId).toBeDefined();
      if (!replacement?.runId) {
        throw new Error(
          "Expected queued agent-bearer Fast Luna to launch a Run",
        );
      }

      const lunaExecution = await fixture.api.executionInput(replacement.runId);
      tracker.track(replacement.runId, lunaExecution.sandboxToken);
      expect(lunaExecution.cliAgentType).toBe("pi");
      expect(lunaExecution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        model: LUNA_MODEL,
        serviceTier: "fast",
      });

      await Promise.all([
        completePiRun({
          runId: replacement.runId,
          threadId: busy.threadId,
          sandboxToken: lunaExecution.sandboxToken,
          tracker,
        }),
        completeClaudeRun({
          runId: source.runId,
          sandboxToken: sourceExecution.sandboxToken,
          tracker,
        }),
      ]);
      await expectThreadModelCredits(context, actor, busy.threadId, 0);
    },
  );

  it(
    "chat-events-subscription-authority-005 reuses one subscription gpt-6-luna Pi session across standard, Fast, and standard turns",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tracker } = await prepareSubscriptionMember({});
      const historyObjects = fixture.mockPiObjectStore();

      const first = await fixture.sendChatRun(actor, {
        model: LUNA_MODEL,
        prompt: "First standard Luna turn",
      });
      const firstExecution = await fixture.api.executionInput(first.runId);
      tracker.track(first.runId, firstExecution.sandboxToken);
      expect(firstExecution.cliAgentType).toBe("pi");
      expect(firstExecution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        model: LUNA_MODEL,
      });
      expect(
        firstExecution.piModelConfig &&
          "serviceTier" in firstExecution.piModelConfig
          ? firstExecution.piModelConfig.serviceTier
          : undefined,
      ).toBeUndefined();
      await completePiRun({
        runId: first.runId,
        threadId: first.threadId,
        sandboxToken: firstExecution.sandboxToken,
        tracker,
      });

      const second = await fixture.sendChatRun(actor, {
        threadId: first.threadId,
        model: LUNA_MODEL,
        runOptions: { codexServiceTier: "fast" },
        prompt: "Second fast Luna turn",
      });
      const secondExecution = await fixture.api.executionInput(second.runId);
      tracker.track(second.runId, secondExecution.sandboxToken);
      expect(secondExecution.cliAgentType).toBe("pi");
      expect(secondExecution.piSessionId).toBe(firstExecution.piSessionId);
      expect(secondExecution.nativeContinuation).toMatchObject({
        sessionId: first.threadId,
        generationRunId: first.runId,
      });
      expect(secondExecution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        model: LUNA_MODEL,
        serviceTier: "fast",
      });
      await completePiRun({
        runId: second.runId,
        threadId: first.threadId,
        sandboxToken: secondExecution.sandboxToken,
        tracker,
      });

      await fixture.chat.updateThreadModelSelection(
        actor,
        first.threadId,
        LUNA_MODEL,
        { codexServiceTier: null },
      );

      const third = await fixture.sendChatRun(actor, {
        threadId: first.threadId,
        prompt: "Third standard Luna turn after clearing tier",
      });
      const thirdExecution = await fixture.api.executionInput(third.runId);
      tracker.track(third.runId, thirdExecution.sandboxToken);
      expect(thirdExecution.cliAgentType).toBe("pi");
      expect(thirdExecution.piSessionId).toBe(firstExecution.piSessionId);
      expect(thirdExecution.nativeContinuation).toMatchObject({
        sessionId: first.threadId,
        generationRunId: second.runId,
      });
      expect(thirdExecution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        model: LUNA_MODEL,
      });
      expect(
        thirdExecution.piModelConfig &&
          "serviceTier" in thirdExecution.piModelConfig
          ? thirdExecution.piModelConfig.serviceTier
          : undefined,
      ).toBeUndefined();
      await completePiRun({
        runId: third.runId,
        threadId: first.threadId,
        sandboxToken: thirdExecution.sandboxToken,
        tracker,
      });

      const logs = await runReads.requestListLogs(actor, { limit: 10 }, [200]);
      for (const runId of [first.runId, second.runId, third.runId]) {
        const entry = logs.body.data.find((item) => {
          return item.id === runId;
        });
        expect(entry).toMatchObject({
          status: "completed",
          sessionId: first.threadId,
        });
      }
      expect(historyObjects.size).toBe(0);
      expect(context.sessionHistoryBlobs.size).toBe(0);
      await expectThreadModelCredits(context, actor, first.threadId, 0);
    },
  );

  it(
    "chat-events-subscription-authority-001 rejects a personal Luna account disconnected while its input is queued",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", 1);
      const { actor, codexProviderId, tracker } =
        await prepareSubscriptionMember({ withClaude: true, entitled: true });

      const blocker = await fixture.sendChatRun(actor, {
        model: FABLE_MODEL,
        prompt: "Occupy the only org concurrency slot",
      });
      const blockerExecution = await fixture.api.executionInput(blocker.runId);
      tracker.track(blocker.runId, blockerExecution.sandboxToken);

      const queuedClientEventId = randomUUID();
      const queued = await fixture.chat.requestSendEvent(
        actor,
        {
          model: LUNA_MODEL,
          clientEventId: queuedClientEventId,
          prompt: "Queued personal Luna prompt",
        },
        [201],
      );
      if (queued.status !== 201) {
        throw new Error("Expected queued personal Luna prompt to return 201");
      }
      const queuedThreadId = queued.body.threadId;
      await flushWaitUntilForTest();

      const waitingEvents = await fixture.chat.listThreadEvents(
        actor,
        queuedThreadId,
      );
      const originalInput = waitingEvents.events.find((event) => {
        return event.id === queuedClientEventId;
      });
      expect(originalInput?.eventType).toBe("input.prompt");
      expect(originalInput?.runId).toBeUndefined();

      await fixture.authDeviceSupport.deletePersonalModelProviderAccount(
        actor,
        codexProviderId,
      );

      await completeClaudeRun({
        runId: blocker.runId,
        sandboxToken: blockerExecution.sandboxToken,
        tracker,
      });

      const afterEvents = await fixture.chat.listThreadEvents(
        actor,
        queuedThreadId,
      );
      expect(
        afterEvents.events.some((event) => {
          return event.runId !== undefined;
        }),
      ).toBeFalsy();

      const rejections = afterEvents.events.filter((event) => {
        return event.revokesEventId === queuedClientEventId;
      });
      expect(rejections).toHaveLength(1);
      const rejection = rejections[0];
      expect(rejection).toBeDefined();
      if (!rejection || rejection.eventType !== "input.rejected") {
        throw new Error("Expected a single input.rejected conflict event");
      }
      expect(rejection.runId).toBeUndefined();
      expect(rejection.error).toBe("conflict");

      const nextEvent = afterEvents.events.find((event) => {
        return event.seqId === rejection.seqId + 1;
      });
      expect(nextEvent).toBeDefined();
      if (!nextEvent || nextEvent.eventType !== "output.error") {
        throw new Error("Expected an output.error event at the next sequence");
      }
      expect(nextEvent.runId).toBeUndefined();
      expect(nextEvent.error).toBe("conflict");
      expect(
        Date.parse(nextEvent.createdAt) - Date.parse(rejection.createdAt),
      ).toBe(1);
      expect(nextEvent.content).toMatch(/reconnect/i);
      expect(nextEvent.content).toMatch(/unavailable/i);
    },
  );

  it(
    "chat-events-subscription-authority-004 rejects a prepared fast Luna subscription when forced refresh returns 401 refresh_token_invalidated",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tracker } = await prepareSubscriptionMember({});

      const run = await fixture.sendChatRun(actor, {
        model: LUNA_MODEL,
        runOptions: { codexServiceTier: "fast" },
        prompt: "Run fast Luna before forced refresh fails",
      });
      const execution = await fixture.api.executionInput(run.runId);
      tracker.track(run.runId, execution.sandboxToken);
      expect(execution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        model: LUNA_MODEL,
        serviceTier: "fast",
      });

      firewall.mockCodexTokenRefresh(() => {
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_invalidated",
              message: "Refresh token has been invalidated",
            },
          },
          { status: 401 },
        );
      });

      const resolved = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
            "ChatGPT-Account-ID": secretTemplate("CHATGPT_ACCOUNT_ID"),
          },
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
          forceRefresh: true,
        },
        [502],
      );

      expect(resolved.status).toBe(502);
      if (!("error" in resolved.body)) {
        throw new Error("Expected 502 error body from firewall auth");
      }
      expect(resolved.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
        connectors: ["codex-oauth-token"],
      });

      await completePiRun({
        runId: run.runId,
        threadId: run.threadId,
        sandboxToken: execution.sandboxToken,
        tracker,
      });
      await expectThreadModelCredits(context, actor, run.threadId, 0);
    },
  );

  it(
    "chat-events-subscription-authority-006 (1/2) promotes queued Web Fast gpt-6-luna into Runner execution after busy Claude Fable completes",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tracker } = await prepareSubscriptionMember({
        withClaude: true,
      });

      const busy = await fixture.sendChatRun(actor, {
        model: FABLE_MODEL,
        prompt: "Keep thread busy with Claude Fable",
      });
      const busyExecution = await fixture.api.executionInput(busy.runId);
      tracker.track(busy.runId, busyExecution.sandboxToken);

      const clientEventId = randomUUID();
      const sent = await fixture.chat.requestSendEvent(
        actor,
        {
          threadId: busy.threadId,
          model: LUNA_MODEL,
          runOptions: { codexServiceTier: "fast" },
          clientEventId,
          prompt: "Queued Fast Luna from Web",
        },
        [201],
      );
      expect(sent.status).toBe(201);
      await flushWaitUntilForTest();

      await completeClaudeRun({
        runId: busy.runId,
        sandboxToken: busyExecution.sandboxToken,
        tracker,
      });

      const events = await fixture.chat.listThreadEvents(actor, busy.threadId);
      const replacement = userMessages(events.events).find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === clientEventId &&
          event.runId !== undefined
        );
      });
      expect(replacement?.runId).toBeDefined();
      if (!replacement?.runId) {
        throw new Error("Expected queued Web Fast Luna to launch a Run");
      }

      const lunaExecution = await fixture.api.executionInput(replacement.runId);
      tracker.track(replacement.runId, lunaExecution.sandboxToken);
      expect(lunaExecution.cliAgentType).toBe("pi");
      expect(lunaExecution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        model: LUNA_MODEL,
        serviceTier: "fast",
      });

      await completePiRun({
        runId: replacement.runId,
        threadId: busy.threadId,
        sandboxToken: lunaExecution.sandboxToken,
        tracker,
      });
      await expectThreadModelCredits(context, actor, busy.threadId, 0);
    },
  );

  it(
    "chat-events-subscription-authority-006 (2/2) launches immediate Web Fast gpt-6-luna on a new idle thread without model credits",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tracker } = await prepareSubscriptionMember({});

      const clientEventId = randomUUID();
      const sent = await fixture.chat.requestSendEvent(
        actor,
        {
          model: LUNA_MODEL,
          runOptions: { codexServiceTier: "fast" },
          clientEventId,
          prompt: "Immediate Fast Luna from Web",
        },
        [201],
      );
      expect(sent.status).toBe(201);
      if (sent.status !== 201) {
        throw new Error("Expected immediate Web Fast Luna send to return 201");
      }
      const sentThreadId = sent.body.threadId;
      await flushWaitUntilForTest();

      const events = await fixture.chat.listThreadEvents(actor, sentThreadId);
      const replacement = userMessages(events.events).find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === clientEventId &&
          event.runId !== undefined
        );
      });
      expect(replacement?.runId).toBeDefined();
      if (!replacement?.runId) {
        throw new Error("Expected immediate Web Fast Luna to launch a Run");
      }

      const lunaExecution = await fixture.api.executionInput(replacement.runId);
      tracker.track(replacement.runId, lunaExecution.sandboxToken);
      expect(lunaExecution.cliAgentType).toBe("pi");
      expect(lunaExecution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        model: LUNA_MODEL,
        serviceTier: "fast",
      });

      await completePiRun({
        runId: replacement.runId,
        threadId: sentThreadId,
        sandboxToken: lunaExecution.sandboxToken,
        tracker,
      });
      await expectThreadModelCredits(context, actor, sentThreadId, 0);
    },
  );

  it(
    "chat-events-subscription-authority-007 (2/2) launches immediate agent-bearer Fast gpt-6-luna on a new idle thread without model credits",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tracker } = await prepareSubscriptionMember({
        withClaude: true,
      });

      const source = await fixture.sendChatRun(actor, {
        model: FABLE_MODEL,
        prompt: "Active source Claude Run holding bearer token",
      });
      const sourceExecution = await fixture.api.executionInput(source.runId);
      tracker.track(source.runId, sourceExecution.sandboxToken);
      const agentBearerToken = okouTokenFromExecution(sourceExecution);

      const clientEventId = randomUUID();
      const sent = await fixture.requestSendEventWithBearer(
        agentBearerToken,
        {
          model: LUNA_MODEL,
          runOptions: { codexServiceTier: "fast" },
          clientEventId,
          prompt: "Immediate Fast Luna from agent bearer token",
        },
        [201],
      );
      expect(sent.status).toBe(201);
      if (sent.status !== 201) {
        throw new Error(
          "Expected immediate agent-bearer Fast Luna send to return 201",
        );
      }
      const sentThreadId = sent.body.threadId;
      await flushWaitUntilForTest();

      const events = await fixture.chat.listThreadEvents(actor, sentThreadId);
      const replacement = userMessages(events.events).find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === clientEventId &&
          event.runId !== undefined
        );
      });
      expect(replacement?.runId).toBeDefined();
      if (!replacement?.runId) {
        throw new Error(
          "Expected immediate agent-bearer Fast Luna to launch a Run",
        );
      }

      const lunaExecution = await fixture.api.executionInput(replacement.runId);
      tracker.track(replacement.runId, lunaExecution.sandboxToken);
      expect(lunaExecution.cliAgentType).toBe("pi");
      expect(lunaExecution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        model: LUNA_MODEL,
        serviceTier: "fast",
      });

      await Promise.all([
        completePiRun({
          runId: replacement.runId,
          threadId: sentThreadId,
          sandboxToken: lunaExecution.sandboxToken,
          tracker,
        }),
        completeClaudeRun({
          runId: source.runId,
          sandboxToken: sourceExecution.sandboxToken,
          tracker,
        }),
      ]);
      await expectThreadModelCredits(context, actor, sentThreadId, 0);
    },
  );
});
