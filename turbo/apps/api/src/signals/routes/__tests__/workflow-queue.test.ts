import { randomUUID } from "node:crypto";

import { chatInputStatusContract } from "@okouai/api-contracts/contracts/chat-input-status";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  webhookCompleteContract,
  webhookWorkflowAutomationContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatInputStatusRoutes } from "../chat-input-status";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import {
  chatEventAutomationPart,
  chatEventDisplayText,
} from "./helpers/chat-event";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const runsApi = createRunsApi(context);
const workflowsBdd = createWorkflowsBddApi(context);
const chatApi = createChatFilesBddApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const WORKFLOW_NAME = "workflow-queue-workflow";

const appFor = setupApp({
  context,
  routes: [
    ...workflowsRoutes,
    ...workflowAutomationsRoutes,
    ...webhooksWorkflowAutomationsRoutes,
    ...chatInputStatusRoutes,
    ...meModelProvidersDeleteRoutes,
    ...webhooksAgentCompleteRoutes,
  ],
});
const workflowsApi = appFor(workflowsCollectionContract);
const automationsApi = appFor(workflowAutomationsContract);
const workflowWebhookApi = appFor(webhookWorkflowAutomationContract);
const inputStatusApi = appFor(chatInputStatusContract);
const providersByTypeApi = appFor(personalModelProvidersByTypeContract);
const completeApi = appFor(webhookCompleteContract);

function asUser(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return AUTH_HEADERS;
}

function installExecutionBoundaries() {
  installWorkflowVolumeS3Fixture(context);
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
}

function pendingAutomationEvents(events: readonly ChatEvent[]) {
  const revokedIds = new Set(
    events.flatMap((event) => {
      return event.revokesEventId ? [event.revokesEventId] : [];
    }),
  );
  return events.filter((event) => {
    return event.eventType === "input.automation" && !revokedIds.has(event.id);
  });
}

function launchedPromptEvents(events: readonly ChatEvent[]) {
  return events.filter((event) => {
    return event.eventType === "input.prompt" && event.runId !== undefined;
  });
}

async function cleanupDispatchedRuns(
  actor: ApiTestUser,
  runnerGroup: string,
): Promise<void> {
  await flushWaitUntilForTest();
  for (let round = 0; round < 6; round++) {
    const dispatches = runsApi.receivedDispatches(runnerGroup);
    let cleanedAny = false;
    for (const envelope of dispatches) {
      const { runId, sandboxToken } = envelope.executionContext;
      const read = await runsApi.requestReadRun(actor, runId, [200, 404]);
      if (
        read.status === 200 &&
        (read.body.status === "pending" || read.body.status === "running")
      ) {
        await runsApi.requestCancelRun(actor, runId, [200]);
        await webhooksApi.requestAgentComplete(
          { runId, exitCode: 1, error: "Cancelled by test cleanup" },
          { authorization: `Bearer ${sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
        cleanedAny = true;
      }
    }
    if (!cleanedAny) {
      break;
    }
  }
}

async function setupWebhookAutomation(
  options: {
    readonly concurrentRunLimitCap?: number;
  } = {},
) {
  if (options.concurrentRunLimitCap !== undefined) {
    mockOptionalEnv(
      "CONCURRENT_RUN_LIMIT_CAP",
      String(options.concurrentRunLimitCap),
    );
  }
  const { actor } = await workflowsBdd.setupWorkflowOrg({ tier: "team" });
  installExecutionBoundaries();
  const runnerGroup = await runsApi.configureRunnerGroup({ maxConcurrent: 4 });

  const workflowId = await workflowsBdd.createWorkflow(actor, {
    name: WORKFLOW_NAME,
    visibility: "private",
  });
  const created = await accept(
    automationsApi.create({
      headers: asUser(actor),
      params: { workflowId },
      body: { kind: "event", eventType: "webhook-received" },
    }),
    [201],
  );
  const automation = created.body;
  if (
    automation.kind !== "event" ||
    automation.eventType !== "webhook-received" ||
    !automation.webhookUrl ||
    !automation.webhookSecret ||
    !automation.chatThreadId
  ) {
    throw new Error("Expected a thread-bound webhook automation");
  }
  const rawToken = new URL(automation.webhookUrl).pathname.split("/").at(-1);
  if (!rawToken) {
    throw new Error("Expected webhook URL token");
  }
  const token: string = rawToken;
  const webhookSecret = automation.webhookSecret;
  const threadId = automation.chatThreadId;

  async function postSignedWebhook(
    rawBody: string,
    timestampOffsetSeconds = 0,
  ) {
    const timestamp = Math.floor(now() / 1000) + timestampOffsetSeconds;
    const response = await accept(
      workflowWebhookApi.post({
        params: { token },
        body: rawBody,
        extraHeaders: {
          "content-type": "application/json",
          "x-okou-timestamp": String(timestamp),
          "x-okou-signature": computeHmacSignature(
            rawBody,
            webhookSecret,
            timestamp,
          ),
        },
      }),
      [200],
    );
    return response.body;
  }

  async function completeRun(
    runId: string,
    args: {
      readonly assistantText?: string;
      readonly sessionId?: string;
    } = {},
  ) {
    const execution = await runsApi.executionInput(runId);
    const sandboxHeaders = {
      authorization: `Bearer ${execution.sandboxToken}`,
    };
    const sessionId = args.sessionId ?? `workflow-queue-cli-${runId}`;
    if (args.assistantText !== undefined) {
      await webhooksApi.requestAgentEvents(
        {
          runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: sessionId,
              sequenceNumber: 0,
            },
            {
              type: "assistant",
              sequenceNumber: 1,
              message: {
                content: [{ type: "text", text: args.assistantText }],
              },
            },
            { type: "result", sequenceNumber: 2, result: args.assistantText },
          ],
        },
        sandboxHeaders,
        [200],
      );
    }
    await webhooksApi.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        ...(args.assistantText === undefined ? {} : { lastEventSequence: 2 }),
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: sessionId,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
  }

  const firstWebhook = await postSignedWebhook(
    JSON.stringify({ event: "initial", id: 1 }),
  );
  expect(firstWebhook).toStrictEqual({ success: true, duplicate: false });
  await flushWaitUntilForTest();

  const initialEvents = await workflowsBdd.readThreadEvents(threadId);
  const firstRunId = launchedPromptEvents(initialEvents)[0]?.runId;
  if (!firstRunId) {
    throw new Error("Expected first webhook to launch a Run");
  }

  return {
    actor,
    runnerGroup,
    workflowId,
    automationId: automation.id,
    webhookSecret,
    threadId,
    firstRunId,
    postSignedWebhook,
    completeRun,
  };
}

describe("workflow queue", () => {
  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      const warmupUser = createBddApi(context).user();
      await runsApi.grantProEntitlement(warmupUser);
      await runsApi.configureRunnerGroup();
      await Promise.all([
        accept(
          workflowsApi.create({
            headers: {},
            body: { name: "warmup-queue", visibility: "private" },
          }),
          [401],
        ),
        accept(
          automationsApi.get({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          inputStatusApi.get({
            headers: {},
            params: { threadId: warmupId, eventId: warmupId },
          }),
          [401],
        ),
        accept(
          completeApi.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
      ]);
    });
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  it(
    "workflow-queue-007 executes an admitted automation event after the automation is paused",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupWebhookAutomation();
      onTestFinished(async () => {
        await cleanupDispatchedRuns(setup.actor, setup.runnerGroup);
      });

      await setup.postSignedWebhook(JSON.stringify({ event: "admitted" }));
      await flushWaitUntilForTest();

      const paused = await accept(
        automationsApi.disable({
          headers: asUser(setup.actor),
          params: { id: setup.automationId },
        }),
        [200],
      );
      expect(paused.body.enabled).toBeFalsy();

      await setup.completeRun(setup.firstRunId);

      const events = await workflowsBdd.readThreadEvents(setup.threadId);
      expect(launchedPromptEvents(events)).toHaveLength(2);
      expect(pendingAutomationEvents(events)).toStrictEqual([]);
      expect(
        events.filter((event) => {
          return event.eventType === "output.error";
        }),
      ).toStrictEqual([]);
    },
  );

  it(
    "workflow-queue-008 keeps automation events queued until cancellation recovery completes",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupWebhookAutomation();
      onTestFinished(async () => {
        await cleanupDispatchedRuns(setup.actor, setup.runnerGroup);
      });

      const firstExec = await runsApi.executionInput(setup.firstRunId);
      await setup.postSignedWebhook(JSON.stringify({ event: "after-cancel" }));
      await flushWaitUntilForTest();

      const cancelled = await runsApi.requestCancelRun(
        setup.actor,
        setup.firstRunId,
        [200],
      );
      expect(cancelled.status).toBe(200);
      await flushWaitUntilForTest();

      const beforeAck = await workflowsBdd.readThreadEvents(setup.threadId);
      expect(launchedPromptEvents(beforeAck)).toHaveLength(1);
      expect(pendingAutomationEvents(beforeAck)).toHaveLength(1);

      const acked = await webhooksApi.requestAgentComplete(
        { runId: setup.firstRunId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${firstExec.sandboxToken}` },
        [200],
      );
      expect(acked.status).toBe(200);
      await flushWaitUntilForTest();

      const afterAck = await workflowsBdd.readThreadEvents(setup.threadId);
      expect(launchedPromptEvents(afterAck)).toHaveLength(2);
      expect(pendingAutomationEvents(afterAck)).toStrictEqual([]);
    },
  );

  it(
    "workflow-queue-010 revokes a deleted automation's queued event and drains the next automation",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const frozenIso = "2026-07-20T12:00:00.000Z";
      mockNow(new Date(frozenIso));
      const setup = await setupWebhookAutomation();

      onTestFinished(async () => {
        await cleanupDispatchedRuns(setup.actor, setup.runnerGroup);
        clearMockNow();
      });
      await setup.postSignedWebhook(JSON.stringify({ event: "to-revoke" }));
      await flushWaitUntilForTest();

      const scheduleAuto = await accept(
        automationsApi.create({
          headers: asUser(setup.actor),
          params: { workflowId: setup.workflowId },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 3600 },
          },
        }),
        [201],
      );
      expect(scheduleAuto.body.chatThreadId).toBe(setup.threadId);

      const manualRunNow = await accept(
        automationsApi.run({
          headers: asUser(setup.actor),
          params: { id: scheduleAuto.body.id },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      expect(manualRunNow.body).toStrictEqual({
        runId: null,
        chatThreadId: setup.threadId,
      });

      const beforeDelete = await workflowsBdd.readThreadEvents(setup.threadId);
      const pendingBeforeDelete = pendingAutomationEvents(beforeDelete);
      expect(pendingBeforeDelete).toHaveLength(2);
      const queuedWebhookEvent = pendingBeforeDelete[0];
      const queuedManualEvent = pendingBeforeDelete[1];
      if (!queuedWebhookEvent || !queuedManualEvent) {
        throw new Error("Expected queued webhook and manual events");
      }
      expect(chatEventDisplayText(queuedManualEvent)).toBe(
        "A manual run of this workflow was requested.",
      );

      await accept(
        automationsApi.delete({
          headers: asUser(setup.actor),
          params: { id: setup.automationId },
        }),
        [204],
      );
      await flushWaitUntilForTest();

      const afterDelete = await workflowsBdd.readThreadEvents(setup.threadId);
      expect(afterDelete).toContainEqual(
        expect.objectContaining({
          eventType: "control.revoke",
          revokesEventId: queuedWebhookEvent.id,
        }),
      );
      expect(
        pendingAutomationEvents(afterDelete).map((event) => {
          return event.id;
        }),
      ).toStrictEqual([queuedManualEvent.id]);

      const revokedStatus = await accept(
        inputStatusApi.get({
          headers: asUser(setup.actor),
          params: {
            threadId: setup.threadId,
            eventId: queuedWebhookEvent.id,
          },
        }),
        [200],
      );
      expect(revokedStatus.body).toMatchObject({
        status: "revoked",
        runId: null,
        terminal: null,
      });

      await setup.completeRun(setup.firstRunId);

      const afterComplete = await workflowsBdd.readThreadEvents(setup.threadId);
      expect(
        afterComplete.filter((event) => {
          return event.eventType === "output.error";
        }),
      ).toStrictEqual([]);
      const secondPrompt = launchedPromptEvents(afterComplete).find((event) => {
        return event.revokesEventId === queuedManualEvent.id;
      });
      if (!secondPrompt?.runId) {
        throw new Error("Expected second Run to claim manual event");
      }
      expect(chatEventDisplayText(secondPrompt)).toBe(
        "A manual run of this workflow was requested.",
      );

      const secondExec = await runsApi.executionInput(secondPrompt.runId);
      expect(secondExec.prompt).toContain("Type: manual");
      expect(secondExec.prompt).toContain(
        `Summary: manual run requested at ${frozenIso}.`,
      );
      expect(secondExec.prompt).toContain(scheduleAuto.body.id);
      expect(secondExec.prompt).toContain(`"trigger": "manual"`);
      expect(secondExec.prompt).toContain(frozenIso);
      expect(secondExec.prompt).toContain(queuedManualEvent.id);
    },
  );

  it(
    "workflow-queue-014 rejects only the failed webhook trigger and accepts the next event",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixedIso = "2026-07-25T12:00:00.000Z";
      mockNow(new Date(fixedIso));
      const setup = await setupWebhookAutomation();

      onTestFinished(async () => {
        await cleanupDispatchedRuns(setup.actor, setup.runnerGroup);
        clearMockNow();
      });
      await setup.postSignedWebhook(
        JSON.stringify({ event: "rejected-trigger" }),
      );
      await flushWaitUntilForTest();

      const beforeRemoval = await workflowsBdd.readThreadEvents(setup.threadId);
      const queuedEvent = pendingAutomationEvents(beforeRemoval)[0];
      if (!queuedEvent) {
        throw new Error("Expected queued webhook event");
      }

      await accept(
        providersByTypeApi.delete({
          headers: asUser(setup.actor),
          params: { type: "claude-code-oauth-token" },
        }),
        [204],
      );

      const firstExec = await runsApi.executionInput(setup.firstRunId);
      await runsApi.requestCancelRun(setup.actor, setup.firstRunId, [200]);
      await webhooksApi.requestAgentComplete(
        { runId: setup.firstRunId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${firstExec.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      const afterReject = await workflowsBdd.readThreadEvents(setup.threadId);
      expect(pendingAutomationEvents(afterReject)).toStrictEqual([]);
      const rejected = afterReject.find((event) => {
        return (
          event.eventType === "input.rejected" &&
          event.revokesEventId === queuedEvent.id
        );
      });
      if (!rejected || rejected.eventType !== "input.rejected") {
        throw new Error("Expected input.rejected revoking queued webhook");
      }
      expect(typeof rejected.error).toBe("string");
      expect(chatEventDisplayText(rejected)).toBe(
        "A signed webhook request was received.",
      );
      expect(chatEventAutomationPart(rejected)).toMatchObject({
        type: "automation",
        workflowName: WORKFLOW_NAME,
        workflowId: setup.workflowId,
      });

      await runsApi.ensurePersonalSubscriptionModel(setup.actor);
      const recoveredWebhook = await setup.postSignedWebhook(
        JSON.stringify({ event: "recovered-trigger" }),
      );
      expect(recoveredWebhook).toStrictEqual({
        success: true,
        duplicate: false,
      });
      await flushWaitUntilForTest();

      const afterRecovery = await workflowsBdd.readThreadEvents(setup.threadId);
      const launched = launchedPromptEvents(afterRecovery);
      expect(launched).toHaveLength(2);
      const recoveredRunId = launched[1]?.runId;
      if (!recoveredRunId) {
        throw new Error("Expected recovered webhook to launch a Run");
      }
      const recoveredExec = await runsApi.executionInput(recoveredRunId);
      expect(recoveredExec.prompt).toContain("Type: webhook-received");
      expect(recoveredExec.prompt).toContain(setup.automationId);
      expect(recoveredExec.prompt).toContain(
        `Summary: signed workflow webhook received an HTTP POST at ${fixedIso} (delivery `,
      );
    },
  );

  it(
    "workflow-queue-015 drains chat and automation input in admission order in one canonical session",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupWebhookAutomation();
      onTestFinished(async () => {
        await cleanupDispatchedRuns(setup.actor, setup.runnerGroup);
      });

      await setup.postSignedWebhook(JSON.stringify({ event: "second-hook" }));
      await flushWaitUntilForTest();

      const interjectionEventId = randomUUID();
      await chatApi.requestSendEvent(
        setup.actor,
        {
          threadId: setup.threadId,
          prompt: "user interjection",
          clientEventId: interjectionEventId,
        },
        [201],
      );
      await flushWaitUntilForTest();

      await setup.completeRun(setup.firstRunId, {
        assistantText: "done",
        sessionId: `workflow-queue-cli-${setup.firstRunId}`,
      });

      const afterFirst = await workflowsBdd.readThreadEvents(setup.threadId);
      const promptsAfterFirst = launchedPromptEvents(afterFirst);
      expect(promptsAfterFirst).toHaveLength(2);
      const secondRunId = promptsAfterFirst[1]?.runId;
      if (!secondRunId) {
        throw new Error("Expected queued automation event to start second Run");
      }
      expect(
        promptsAfterFirst.some((event) => {
          return event.revokesEventId === interjectionEventId;
        }),
      ).toBeFalsy();

      const secondExec = await runsApi.executionInput(secondRunId);
      expect(secondExec.nativeContinuation.sessionId).toBe(
        `workflow-queue-cli-${setup.firstRunId}`,
      );

      await setup.completeRun(secondRunId, {
        assistantText: "done",
        sessionId: `workflow-queue-cli-${secondRunId}`,
      });

      const afterSecond = await workflowsBdd.readThreadEvents(setup.threadId);
      const userPrompt = launchedPromptEvents(afterSecond).find((event) => {
        return event.revokesEventId === interjectionEventId;
      });
      if (!userPrompt?.runId) {
        throw new Error("Expected user interjection to start third Run");
      }
      const thirdRunId = userPrompt.runId;
      const thirdExec = await runsApi.executionInput(thirdRunId);
      expect(thirdExec.nativeContinuation.sessionId).toBe(
        `workflow-queue-cli-${secondRunId}`,
      );

      await setup.completeRun(thirdRunId, {
        assistantText: "done",
        sessionId: `workflow-queue-cli-${thirdRunId}`,
      });

      const [run1, run2, run3] = await Promise.all([
        runsApi.readRun(setup.actor, setup.firstRunId),
        runsApi.readRun(setup.actor, secondRunId),
        runsApi.readRun(setup.actor, thirdRunId),
      ]);
      expect(run1.result?.frameworkSessionId).toBe(
        `workflow-queue-cli-${setup.firstRunId}`,
      );
      expect(run2.result?.frameworkSessionId).toBe(
        `workflow-queue-cli-${secondRunId}`,
      );
      expect(run3.result?.frameworkSessionId).toBe(
        `workflow-queue-cli-${thirdRunId}`,
      );
    },
  );

  it(
    "workflow-queue-016 revokes one pending automation event with the caller's client event id",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupWebhookAutomation();
      onTestFinished(async () => {
        await cleanupDispatchedRuns(setup.actor, setup.runnerGroup);
      });

      await setup.postSignedWebhook(JSON.stringify({ event: "pending-1" }));
      await setup.postSignedWebhook(JSON.stringify({ event: "pending-2" }));
      await flushWaitUntilForTest();

      const beforeRevoke = await workflowsBdd.readThreadEvents(setup.threadId);
      const pending = pendingAutomationEvents(beforeRevoke);
      expect(pending).toHaveLength(2);
      const targetEvent = pending[0];
      const survivingEvent = pending[1];
      if (!targetEvent || !survivingEvent) {
        throw new Error("Expected two pending automation events");
      }

      const revokeClientEventId = randomUUID();
      await chatApi.requestSendEvent(
        setup.actor,
        {
          threadId: setup.threadId,
          revokesEventId: targetEvent.id,
          clientEventId: revokeClientEventId,
        },
        [201],
      );
      await flushWaitUntilForTest();

      const afterRevoke = await workflowsBdd.readThreadEvents(setup.threadId);
      expect(
        pendingAutomationEvents(afterRevoke).map((event) => {
          return event.id;
        }),
      ).toStrictEqual([survivingEvent.id]);
      expect(afterRevoke).toContainEqual(
        expect.objectContaining({
          eventType: "control.revoke",
          id: revokeClientEventId,
          revokesEventId: targetEvent.id,
        }),
      );

      await setup.completeRun(setup.firstRunId);
      const afterFirstComplete = await workflowsBdd.readThreadEvents(
        setup.threadId,
      );
      const prompts = launchedPromptEvents(afterFirstComplete);
      expect(prompts).toHaveLength(2);
      const secondRunId = prompts[1]?.runId;
      if (!secondRunId) {
        throw new Error("Expected surviving event to launch second Run");
      }
      await setup.completeRun(secondRunId);

      const finalEvents = await workflowsBdd.readThreadEvents(setup.threadId);
      expect(launchedPromptEvents(finalEvents)).toHaveLength(2);
    },
  );

  it(
    "workflow-queue-017 queues manual Run now behind the active run and existing backlog",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupWebhookAutomation();
      onTestFinished(async () => {
        await cleanupDispatchedRuns(setup.actor, setup.runnerGroup);
      });

      await setup.postSignedWebhook(JSON.stringify({ event: "backlog-hook" }));
      await flushWaitUntilForTest();

      const scheduleAuto = await accept(
        automationsApi.create({
          headers: asUser(setup.actor),
          params: { workflowId: setup.workflowId },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 3600 },
          },
        }),
        [201],
      );
      expect(scheduleAuto.body.chatThreadId).toBe(setup.threadId);

      const manualRunNow = await accept(
        automationsApi.run({
          headers: asUser(setup.actor),
          params: { id: scheduleAuto.body.id },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      expect(manualRunNow.body).toStrictEqual({
        runId: null,
        chatThreadId: setup.threadId,
      });

      const beforeDrain = await workflowsBdd.readThreadEvents(setup.threadId);
      expect(
        pendingAutomationEvents(beforeDrain).map((event) => {
          return chatEventDisplayText(event);
        }),
      ).toStrictEqual([
        "A signed webhook request was received.",
        "A manual run of this workflow was requested.",
      ]);
      expect(launchedPromptEvents(beforeDrain)).toHaveLength(1);

      await setup.completeRun(setup.firstRunId);
      const afterFirst = await workflowsBdd.readThreadEvents(setup.threadId);
      const secondRunId = launchedPromptEvents(afterFirst)[1]?.runId;
      if (!secondRunId) {
        throw new Error("Expected backlog webhook to start second Run");
      }
      const secondExec = await runsApi.executionInput(secondRunId);
      expect(secondExec.prompt).toContain("Type: webhook-received");
      expect(secondExec.prompt).toContain(setup.automationId);

      await setup.completeRun(secondRunId);
      const afterSecond = await workflowsBdd.readThreadEvents(setup.threadId);
      const thirdRunId = launchedPromptEvents(afterSecond)[2]?.runId;
      if (!thirdRunId) {
        throw new Error("Expected manual request to start third Run");
      }
      const thirdExec = await runsApi.executionInput(thirdRunId);
      expect(thirdExec.prompt).toContain("Type: manual");
      expect(thirdExec.prompt).toContain(scheduleAuto.body.id);

      await setup.completeRun(thirdRunId);
    },
  );
});
