import { randomUUID } from "node:crypto";
import { getProviderRuntimeModel } from "@okouai/api-contracts/contracts/model-providers";
import {
  readGoalQueueStateFixture,
  seedGoalForRunFixture,
  setLegacyGoalRunOriginFixture,
} from "../../../test-fixtures/goal-queue";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  readmitPiMemoryStage1CandidateFixture,
  readPiConversationIdentityFixture,
  readPiMemoryStage1CandidateFixture,
  readPiMemoryStage1DayFixture,
} from "../../../test-fixtures/pi-memory-stage1-candidates";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { cronExtractPiMemoryStage1RoutesForTest } from "../cron-extract-pi-memory-stage1";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { readAgentRunState$ } from "./helpers/agent-run-callback";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  readRunLaunchSnapshotFixture,
  readThreadSessionBinding,
} from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  requireOrgId,
  expectPiApiUsage,
  expectNoBuiltInModelUsage,
  createPiApiFirstTurnUsagePricingResolution,
  expectExactPrivatePiMemoryAdmission,
} from "./helpers/chat-events-fixture";
import { piResponsesTextSse } from "./helpers/pi-responses";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  authDeviceSupport,
  runStateStore,
  entitledChatActor,
  seedBuiltInModelKey,
  configureBuiltInPiModel,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  waitForRunStatus,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  sessionHeaders,
  upsertOrgModelProvider,
  threadPiAutomationsClient,
  postThreadPiAutomationEvent,
  lastThreadPiAutomationRun,
  expectThreadPiTerminal,
  claimGptPiSandbox,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
} = createChatEventsFixture(context);

async function extractOwnedThreadPiMemory(
  actor: ApiTestUser,
  runId: string,
  agentId: string,
) {
  mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "true");
  const scope = { orgId: requireOrgId(actor), userId: actor.userId };
  const candidate = await readPiMemoryStage1CandidateFixture(scope);
  if (!candidate) {
    throw new Error("Expected completed source admission");
  }
  await seedBuiltInModelKey("gpt-5.6-terra");
  const requests: unknown[] = [];
  server.use(
    http.post(
      "https://api.openai.com/v1/responses",
      async ({ request }) => {
        requests.push(await request.json());
        return new HttpResponse(
          piResponsesTextSse(
            JSON.stringify({
              raw_memory: "The owner prefers concise progress reports.",
              rollout_summary: "Learned the owner's reporting preference.",
              rollout_slug: "owned-reporting-preference",
            }),
            100,
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { once: true },
    ),
  );
  // A later UTC day needs its own committed startup; a real queued Pi launch
  // exercises the common admission hook without making a foreground model call.
  const nextDay = new Date(candidate.sourceCompletedAt);
  nextDay.setUTCHours(24, 0, 0, 0);
  mockNow(
    Math.max(
      nextDay.getTime(),
      candidate.sourceCompletedAt.getTime() + 7 * 3_600_000,
    ),
  );
  mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
  await updateFeatureSwitchesForUser(context, scope, {
    [FeatureSwitchKey.PiMemory]: false,
    [FeatureSwitchKey.PiLoop]: false,
  });
  const anchor = await sendChatRun(actor, {
    agentId,
    prompt: "hold daily startup admission",
    model: "gpt-5.6-terra",
  });
  await flushWaitUntilForTest();
  await updateFeatureSwitchesForUser(context, scope, {
    [FeatureSwitchKey.PiMemory]: true,
    [FeatureSwitchKey.PiLoop]: true,
  });
  const startup = await sendChatRun(actor, {
    agentId,
    prompt: "request the daily Pi batch",
    model: "gpt-5.6-terra",
  });
  await waitForRunStatus(actor, startup.runId, "queued");
  await expect(
    readPiMemoryStage1DayFixture(actor.userId),
  ).resolves.toMatchObject({
    day: nowDate().toISOString().slice(0, 10),
    triggerThreadId: startup.threadId,
    consumedAt: null,
  });
  const extracted = await accept(
    setupApp({
      context,
      // Scope the existing cron worker to this source; no production API
      // exposes internal candidate extraction or its private output.
      routes: cronExtractPiMemoryStage1RoutesForTest({
        memoryStorageIds: [candidate.memoryStorageId],
        piSessionId: candidate.piSessionId,
      }),
    })(cronExtractPiMemoryStage1Contract).extract({
      headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
    }),
    [200],
  );
  expect(extracted.body).toMatchObject({ claimed: 1, succeeded: 1 });
  expect(requests).toHaveLength(1);
  await expect(
    readPiMemoryStage1CandidateFixture(scope),
  ).resolves.toMatchObject({
    sourceRunId: runId,
    piSessionId: candidate.piSessionId,
    sourceHistoryHash: candidate.sourceHistoryHash,
    status: "succeeded",
    rawMemory: "The owner prefers concise progress reports.",
  });
  await api.requestCancelRun(actor, startup.runId, [200]);
  await api.requestCancelRun(actor, anchor.runId, [200]);
}

describe("thread-bound Pi Automation and Goal execution", () => {
  it.each(
    (["gpt-5.6-terra", "deepseek-v4.1-flash"] as const).flatMap(
      (selectedModel) => {
        return (["schedule", "event"] as const).map((source) => {
          return { source, selectedModel };
        });
      },
    ),
  )(
    "rotates the $source $selectedModel Automation session into Pi and learns only from its user turns",
    async ({ source, selectedModel }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor(
        {},
        source === "event" ? "team" : "pro",
      );
      const orgId = requireOrgId(actor);
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      const workflows = createWorkflowsBddApi(context);
      const workflowId = await workflows.createWorkflow(actor, {
        agentId,
        name: `pi-source-${source}`,
      });
      if (source === "schedule") {
        await configureBuiltInPiModel(actor, selectedModel);
      }
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: false,
        },
      );
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
      const automation = created.body;
      const eventRoute =
        automation.kind === "event" &&
        automation.eventType === "webhook-received" &&
        automation.webhookUrl &&
        automation.webhookSecret
          ? {
              webhookUrl: automation.webhookUrl,
              webhookSecret: automation.webhookSecret,
            }
          : null;
      let threadId: string;
      if (eventRoute) {
        await postThreadPiAutomationEvent({
          ...eventRoute,
          payload: "legacy",
          timestamp: Math.floor(now() / 1000),
          usagePricingResolution,
        });
        if (!automation.chatThreadId) {
          throw new Error("Expected the event thread");
        }
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
      const legacyRunId = await lastThreadPiAutomationRun(actor, threadId);
      const legacyClaim = await claimChatRun(runnerGroup, legacyRunId);
      const legacyFramework = source === "schedule" ? "codex" : "claude-code";
      await completeChatRunOk(legacyRunId, legacyClaim.sandboxHeaders, {
        cliAgentType: legacyFramework,
      });
      await flushWaitUntilForTest();
      const legacyBinding = await readThreadSessionBinding(context, threadId);
      await expect(
        readRunLaunchSnapshotFixture(context, legacyRunId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: legacyFramework },
      });
      await expect(
        readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
      ).resolves.toBeNull();

      await configureBuiltInPiModel(actor, selectedModel);
      await chat.updateThreadModelSelection(actor, threadId, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.PiMemory]: true,
        },
      );

      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(
          selectedModel === "deepseek-v4.1-flash"
            ? "https://api.deepseek.com/responses"
            : "https://api.openai.com/v1/responses",
          async ({ request }) => {
            requests.push(await request.json());
            return new HttpResponse(
              piResponsesTextSse(
                `owned ${source} answer ${requests.length}`,
                requests.length,
              ),
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          },
        ),
      );
      if (eventRoute) {
        const event = {
          ...eventRoute,
          payload: "pi-event",
          timestamp: Math.floor(now() / 1000),
          usagePricingResolution,
        };
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          {
            duplicate: false,
          },
        );
        // A retry keeps the original signed envelope across clock seconds.
        mockNow(now() + 1000);
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          {
            duplicate: true,
          },
        );
      } else {
        const scheduled = await workflows.readAutomation(automation.id);
        if (!scheduled.nextRunAt) {
          throw new Error("Expected preserved recurrence");
        }
        mockNow(Date.parse(scheduled.nextRunAt) + 1000);
        await accept(
          setupApp({
            context,
            routes: testWorkflowAutomationExecutionRoutes,
            usagePricingResolution,
          })(testWorkflowAutomationExecutionContract).execute({
            body: { automation_id: automation.id },
          }),
          [200],
        );
      }
      const piRunId = await lastThreadPiAutomationRun(actor, threadId);
      expect(piRunId).not.toBe(legacyRunId);
      // Workflow slash input intentionally enters native AgentSession in the
      // Sandbox. Exercise the real runner claim/checkpoint/completion protocol.
      await flushWaitUntilForTest();
      const piClaim = await claimChatRun(runnerGroup, piRunId);
      expect(piClaim.claim).toMatchObject({
        piModelConfig: {
          model: getProviderRuntimeModel("built-in", selectedModel),
        },
      });
      const sandboxUsage = {
        idempotencyKey: randomUUID(),
        kind: "model" as const,
        provider: selectedModel,
        category: "tokens.output",
        quantity: 3,
      };
      for (const _receipt of [1, 2]) {
        await webhooks.requestAgentUsageEvent(
          { runId: piRunId, events: [sandboxUsage] },
          piClaim.sandboxHeaders,
          [200],
          usagePricingResolution,
        );
      }
      await completeSandboxFirstPiRun({
        actor,
        run: { runId: piRunId, threadId },
        claim: piClaim,
        checkpointObjects,
        prompt: piClaim.claim.prompt,
        answer: `owned ${source} answer`,
        outputTokens: 3,
        responsesModel: {
          provider:
            selectedModel === "deepseek-v4.1-flash" ? "deepseek" : "openai",
          model: getProviderRuntimeModel("built-in", selectedModel),
        },
        usagePricingResolution,
      });
      await expectThreadPiTerminal(actor, threadId, piRunId);
      const piBinding = await readThreadSessionBinding(context, threadId);
      expect(piBinding.agent_session_id).not.toBe(
        legacyBinding.agent_session_id,
      );
      const piHistory = await readPiConversationIdentityFixture(piRunId);
      // An Automation completion never produces memory (EPIC #33892
      // Decision 3): its owned Chat Thread is skipped as a non-interactive
      // source rather than a missing thread, and no candidate row is written.
      await expect(
        readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
      ).resolves.toBeNull();
      await expect(
        readmitPiMemoryStage1CandidateFixture(piRunId),
      ).resolves.toStrictEqual({
        outcome: "skipped",
        reason: "non_interactive_source",
      });
      const runState = await runStateStore.set(
        readAgentRunState$,
        { orgId, userId: actor.userId, runId: piRunId },
        context.signal,
      );
      expect(runState.agent_run).toMatchObject({
        triggerSource: `automation-${source}`,
      });
      await expectPiApiUsage(piRunId, selectedModel, "", {
        input: 0,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      await accept(
        setupApp({ context, routes: testWorkflowAutomationExecutionRoutes })(
          testWorkflowAutomationExecutionContract,
        ).dispatchCallbacks({
          body: { run_id: piRunId, status: "completed", dispatch_count: 2 },
        }),
        [200],
      );
      await expectThreadPiTerminal(actor, threadId, piRunId);
      expect(requests).toHaveLength(0);

      mockNow(now() + 1000);
      const user = await sendChatRun(
        actor,
        { agentId, threadId, prompt: "continue this Automation conversation" },
        usagePricingResolution,
      );
      await expectThreadPiTerminal(actor, threadId, user.runId);
      expect(
        (await readThreadSessionBinding(context, threadId)).agent_session_id,
      ).toBe(piBinding.agent_session_id);
      const userHistory = await readPiConversationIdentityFixture(user.runId);
      expect(userHistory.piSessionId).toBe(piHistory.piSessionId);
      expect(userHistory.sourceHistoryHash).not.toBe(
        piHistory.sourceHistoryHash,
      );
      // The user's turn in the same rotated session is this owner's first
      // admitted learning source, and its extraction succeeds.
      await expectExactPrivatePiMemoryAdmission({
        orgId,
        userId: actor.userId,
        runId: user.runId,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: getProviderRuntimeModel("built-in", selectedModel),
      });
      await expectPiApiUsage(user.runId, selectedModel, "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      if (selectedModel === "gpt-5.6-terra") {
        await extractOwnedThreadPiMemory(actor, user.runId, agentId);
      }
      clearMockNow();
    },
    90_000,
  );
});

describe("CHAT effort: automation launches", () => {
  async function startAutomation() {
    const scenario = await entitledChatActor({}, "pro");
    const { actor, agentId, runnerGroup } = scenario;
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.Effort]: true,
      [FeatureSwitchKey.PiLoop]: false,
    });
    const workflowId = await createWorkflowsBddApi(context).createWorkflow(
      actor,
      { agentId, name: "native-effort" },
    );
    const created = await accept(
      threadPiAutomationsClient().create({
        headers: sessionHeaders(actor),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    const started = await accept(
      threadPiAutomationsClient().run({
        headers: sessionHeaders(actor),
        params: { id: created.body.id },
      }),
      [201],
    );
    const threadId = started.body.chatThreadId;
    const runId = await lastThreadPiAutomationRun(actor, threadId);
    const claimed = await claimChatRun(runnerGroup, runId);
    expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "high",
    );
    return {
      ...scenario,
      threadId,
      runId,
      claimed,
      automationId: created.body.id,
    };
  }

  it.each([true, false])(
    "uses the latest thread effort and rollout state for a queued automation (enabled=%s)",
    async (enabled) => {
      const { actor, runnerGroup, threadId, runId, claimed, automationId } =
        await startAutomation();
      await chat.updateThreadModelSelection(
        actor,
        threadId,
        "claude-sonnet-5",
        {
          reasoningEffort: "extra",
        },
      );
      const queued = await accept(
        threadPiAutomationsClient().run({
          headers: sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      expect(queued.body.runId).toBeNull();
      await chat.updateThreadModelSelection(
        actor,
        threadId,
        "claude-sonnet-5",
        {
          reasoningEffort: "high",
        },
      );
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.Effort]: enabled,
      });
      await completeChatRunOk(runId, claimed.sandboxHeaders, {
        cliAgentType: "claude-code",
      });
      await flushWaitUntilForTest();
      const nextRunId = await lastThreadPiAutomationRun(actor, threadId);
      expect(nextRunId).not.toBe(runId);
      const next = await claimChatRun(runnerGroup, nextRunId);
      expect(next.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        enabled ? "high" : undefined,
      );
      await expect(
        chat.readThreadMetadata(actor, threadId),
      ).resolves.toMatchObject({
        modelSettings: { "claude-sonnet-5": { effort: "high" } },
      });
      await cancelChatRun(actor, nextRunId, next.sandboxHeaders);
    },
    90_000,
  );

  it("uses route defaults for unsupported effort at automation launch", async () => {
    const { actor, runnerGroup, threadId, runId, claimed, automationId } =
      await startAutomation();
    await completeChatRunOk(runId, claimed.sandboxHeaders, {
      cliAgentType: "claude-code",
    });
    await flushWaitUntilForTest();
    for (const route of [
      {
        model: "claude-sonnet-5",
        effort: "ultracode",
        pi: false,
        providerType: "anthropic-api-key",
        effectiveEffort: "high",
      },
      {
        model: "gpt-5.6-sol",
        effort: "high",
        pi: true,
        providerType: "openai-api-key",
        effectiveEffort: "high",
      },
    ] as const) {
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: route.providerType,
        secret: "test-workflow-effort-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model: route.model,
          isDefault: true,
          defaultProviderType: route.providerType,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: route.pi,
      });
      await chat.updateThreadModelSelection(actor, threadId, route.model, {
        reasoningEffort: route.effort,
      });
      if (route.pi) {
        mockPiCheckpointObjectStore();
      }
      const started = await accept(
        threadPiAutomationsClient().run({
          headers: sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      if (!started.body.runId) {
        throw new Error("Expected an automation run");
      }
      if (route.pi) {
        await flushWaitUntilForTest();
      }
      const next = await claimChatRun(runnerGroup, started.body.runId);
      expect(next.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        route.effectiveEffort,
      );
      if (route.pi) {
        expect(next.claim.piModelConfig).toMatchObject({
          thinkingLevel: route.effectiveEffort,
        });
      }
      await expect(
        chat.readThreadMetadata(actor, threadId),
      ).resolves.toMatchObject({
        modelSettings: { [route.model]: { effort: route.effort } },
      });
      await cancelChatRun(actor, started.body.runId, next.sandboxHeaders);
    }
  }, 90_000);
});

describe("thread-bound Pi terminal failures", () => {
  it.each([
    { source: "automation", status: "failed" },
    { source: "automation", status: "cancelled" },
    { source: "goal", status: "failed" },
    { source: "goal", status: "cancelled" },
  ] as const)(
    "settles $source $status once without learning or Built-in fallback",
    async ({ source, status }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      await configureSubscriptionPiModel(
        actor,
        { accountId: "terminal-owner" },
        "gpt-5.6-luna",
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      const requests: string[] = [];
      server.use(
        http.post(
          "https://chatgpt.com/backend-api/codex/responses",
          async ({ request }) => {
            requests.push(request.url);
            expect(request.headers.get("chatgpt-account-id")).toBe(
              "terminal-owner",
            );
            entered.resolve(undefined);
            await release.promise;
            return HttpResponse.json(
              {
                error: {
                  code: "invalid_api_key",
                  message: "subscription rejected",
                },
              },
              { status: 401 },
            );
          },
        ),
        http.post("https://api.openai.com/v1/responses", ({ request }) => {
          requests.push(request.url);
          return HttpResponse.json(
            { error: "unexpected Built-in fallback" },
            { status: 400 },
          );
        }),
      );
      let run: { readonly runId: string; readonly threadId: string };
      {
        const workflowId = await createWorkflowsBddApi(context).createWorkflow(
          actor,
          { agentId, name: "pi-terminal" },
        );
        const created = await accept(
          threadPiAutomationsClient().create({
            headers: sessionHeaders(actor),
            params: { workflowId },
            body: { schedule: { type: "loop", intervalSeconds: 3600 } },
          }),
          [201],
        );
        const started = await accept(
          threadPiAutomationsClient().run({
            headers: sessionHeaders(actor),
            params: { id: created.body.id },
          }),
          [201],
        );
        const threadId = started.body.chatThreadId;
        const runId = await lastThreadPiAutomationRun(actor, threadId);
        run = { runId, threadId };
        await flushWaitUntilForTest();
        await api.heartbeatRunner(runnerGroup);
        const claim = await claimGptPiSandbox(actor, runId, undefined);
        const claimed = {
          claim,
          sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
        };
        expect(claimed.claim.piModelConfig).toMatchObject({
          model: "gpt-5.6-luna",
        });
        if (source === "goal") {
          const goal = await seedGoalForRunFixture(runId, "in-flight Pi Goal");
          await setLegacyGoalRunOriginFixture(runId, goal.id);
        }
        if (status === "cancelled") {
          await cancelChatRun(actor, runId, claimed.sandboxHeaders);
        } else {
          await failChatRun(
            runId,
            claimed.sandboxHeaders,
            "subscription rejected",
          );
        }
        await failChatRun(
          runId,
          claimed.sandboxHeaders,
          "duplicate terminal delivery",
        );
      }
      await flushWaitUntilForTest();
      await accept(
        setupApp({ context, routes: testWorkflowAutomationExecutionRoutes })(
          testWorkflowAutomationExecutionContract,
        ).dispatchCallbacks({
          body: {
            run_id: run.runId,
            status: "failed",
            error:
              status === "cancelled"
                ? "Run cancelled"
                : "subscription rejected",
            dispatch_count: 2,
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      await expect(
        readRunLaunchSnapshotFixture(context, run.runId),
      ).resolves.toMatchObject({
        launch_snapshot: { schemaVersion: 3, framework: "pi" },
      });
      await expectNoBuiltInModelUsage(run.runId);
      await expect(
        readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
      ).resolves.toBeNull();
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events
          .filter((event) => {
            return (
              event.runId === run.runId &&
              isChatRunTerminalEventType(event.eventType)
            );
          })
          .map((event) => {
            return event.eventType;
          }),
      ).toStrictEqual([`run.${status}`]);
      expect(requests).toHaveLength(0);
      if (source === "goal") {
        expect(
          (await readGoalQueueStateFixture(run.threadId)).runIds,
        ).toStrictEqual([run.runId]);
        expect(
          (await readGoalQueueStateFixture(run.threadId)).eventIds,
        ).toStrictEqual([]);
      }
    },
    90_000,
  );
});
