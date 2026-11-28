import { randomUUID } from "node:crypto";

import { chatThreadMuteContract } from "@okouai/api-contracts/contracts/chat-threads";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatThreadMuteRoutes } from "../chat-threads-mute";
import { feedRoutes } from "../feed";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const bdd = createBddApi(context);
const runsApi = createRunsApi(context);
const workflowsBdd = createWorkflowsBddApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const FIXED_TIME_ISO = "2030-01-01T12:00:00.000Z";

const appFor = setupApp({
  context,
  routes: [
    ...workflowsRoutes,
    ...workflowAutomationsRoutes,
    ...feedRoutes,
    ...chatThreadMuteRoutes,
    ...webhooksAgentCompleteRoutes,
  ],
});
const workflowsApi = appFor(workflowsCollectionContract);
const automationsApi = appFor(workflowAutomationsContract);
const feedApi = appFor(feedContract);
const chatMuteApi = appFor(chatThreadMuteContract);
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

async function cleanupDispatchedRuns(
  actor: ApiTestUser,
  runnerGroup: string,
): Promise<void> {
  await flushWaitUntilForTest();
  for (let round = 0; round < 5; round++) {
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

async function triggerAndFailManualRun(args: {
  readonly actor: ApiTestUser;
  readonly automationId: string;
  readonly error?: string;
  readonly failureReason?: "insufficient_credits";
  readonly onBeforeComplete?: (chatThreadId: string) => Promise<void>;
  readonly redeliverCompletion?: boolean;
}) {
  const triggered = await accept(
    automationsApi.run({
      headers: asUser(args.actor),
      params: { id: args.automationId },
    }),
    [201],
  );
  await flushWaitUntilForTest();

  const events = await workflowsBdd.readThreadEvents(
    triggered.body.chatThreadId,
  );
  const launched = [...events].reverse().find((event) => {
    return event.eventType === "input.prompt" && event.runId !== undefined;
  });
  if (!launched?.runId) {
    throw new Error("Expected manual automation run to launch a Run");
  }

  if (args.onBeforeComplete) {
    await args.onBeforeComplete(triggered.body.chatThreadId);
  }

  const execution = await runsApi.executionInput(launched.runId);
  const body = {
    runId: launched.runId,
    exitCode: 1,
    error: args.error ?? "Scheduled execution failed",
    ...(args.failureReason === undefined
      ? {}
      : { failureReason: args.failureReason }),
  };
  const sandboxHeaders = { authorization: `Bearer ${execution.sandboxToken}` };
  await webhooksApi.requestAgentComplete(body, sandboxHeaders, [200]);
  await flushWaitUntilForTest();
  if (args.redeliverCompletion) {
    await webhooksApi.requestAgentComplete(body, sandboxHeaders, [200]);
    await flushWaitUntilForTest();
  }
  return {
    runId: launched.runId,
    chatThreadId: triggered.body.chatThreadId,
  };
}

describe("recurring automation auto-disable platform feed events", () => {
  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      const warmupUser = bdd.user();
      await runsApi.grantProEntitlement(warmupUser);
      await runsApi.configureRunnerGroup();
      await Promise.all([
        accept(
          workflowsApi.create({
            headers: {},
            body: { name: "warmup-feed", visibility: "private" },
          }),
          [401],
        ),
        accept(
          automationsApi.get({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(feedApi.list({ headers: {}, query: {} }), [401]),
        accept(
          completeApi.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 1 },
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
    "automation-disabled-feed-events-001 keeps platform events intact when an Agent reuses their identity for a suggestion",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(new Date(FIXED_TIME_ISO));
      const { actor: owner } = await workflowsBdd.setupWorkflowOrg({
        tier: "pro",
      });
      if (!owner.orgId) {
        throw new Error("Expected org-scoped owner");
      }
      installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      onTestFinished(async () => {
        await cleanupDispatchedRuns(owner, runnerGroup);
        clearMockNow();
      });
      const workflowName = `cron-feed-${randomUUID().slice(0, 8)}`;
      const workflowId = await workflowsBdd.createWorkflow(owner, {
        name: workflowName,
        visibility: "private",
        description: "Monitors recurring pipeline health",
      });
      const automation = await accept(
        automationsApi.create({
          headers: asUser(owner),
          params: { workflowId },
          body: {
            kind: "schedule",
            schedule: {
              type: "cron",
              cronExpression: "* * * * *",
              timezone: "UTC",
            },
          },
        }),
        [201],
      );

      for (let attempt = 0; attempt < 3; attempt++) {
        await triggerAndFailManualRun({
          actor: owner,
          automationId: automation.body.id,
        });
      }

      const initialEvents = await accept(
        feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
        [200],
      );
      expect(initialEvents.body.items).toHaveLength(1);
      const platformEvent = initialEvents.body.items[0];
      if (!platformEvent || platformEvent.type !== "event") {
        throw new Error("Expected automation-disabled platform event");
      }

      const chatRun = await runsApi.createThreadRun(owner, {
        prompt: "Check feed suggestions",
      });
      const chatExec = await runsApi.executionInput(chatRun.runId);
      const okouToken = okouTokenFromExecution(chatExec);

      const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
      const otherWorkspaceUser = bdd.user({ userId: owner.userId });

      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      await accept(
        feedApi.create({
          headers: { authorization: `Bearer ${okouToken}` },
          body: {
            id: platformEvent.id,
            type: "suggestion",
            priority: 0,
            content: {
              title: "Reused identity",
              rationale: "Should not overwrite platform event",
              options: [
                {
                  id: "opt-1",
                  label: "Proceed",
                  description: "Continue task",
                  threadId: null,
                  draft: {
                    draftAttachments: [],
                    draftUserMessage: {
                      version: 1,
                      parts: [{ type: "text", text: "Continue task" }],
                    },
                  },
                },
              ],
              customOption: {
                id: "custom",
                threadId: null,
                draft: {
                  draftAttachments: [],
                  draftUserMessage: {
                    version: 1,
                    parts: [
                      {
                        type: "feedback",
                        quote: "Platform event",
                        note: [],
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
        [409],
      );

      const afterConflict = await accept(
        feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
        [200],
      );
      expect(afterConflict.body.items).toStrictEqual([platformEvent]);

      for (const unauthorized of [peer, otherWorkspaceUser]) {
        const listRes = await accept(
          feedApi.list({
            headers: asUser(unauthorized),
            query: { type: "event" },
          }),
          [200],
        );
        expect(listRes.body.items).toStrictEqual([]);
        await accept(
          feedApi.dismiss({
            headers: asUser(unauthorized),
            params: { id: platformEvent.id },
          }),
          [404],
        );
      }

      await accept(
        feedApi.dismiss({
          headers: asUser(owner),
          params: { id: platformEvent.id },
        }),
        [204],
      );

      const afterDismiss = await accept(
        feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
        [200],
      );
      expect(afterDismiss.body.items).toStrictEqual([]);

      const automationAfter = await accept(
        automationsApi.get({
          headers: asUser(owner),
          params: { id: automation.body.id },
        }),
        [200],
      );
      expect(automationAfter.body).toMatchObject({
        enabled: false,
        nextRunAt: null,
      });
    },
  );

  it(
    "automation-disabled-feed-events-002 excludes credit failures and deduplicates the runtime disable feed event",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(new Date(FIXED_TIME_ISO));
      const { actor: owner } = await workflowsBdd.setupWorkflowOrg({
        tier: "pro",
      });
      if (!owner.orgId) {
        throw new Error("Expected org-scoped owner");
      }
      installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      onTestFinished(async () => {
        await cleanupDispatchedRuns(owner, runnerGroup);
        clearMockNow();
      });
      const workflowName = `loop-feed-${randomUUID().slice(0, 8)}`;
      const workflowDescription = "Syncs metrics every minute";
      const workflowId = await workflowsBdd.createWorkflow(owner, {
        name: workflowName,
        visibility: "private",
        description: workflowDescription,
      });
      const automation = await accept(
        automationsApi.create({
          headers: asUser(owner),
          params: { workflowId },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 60 },
          },
        }),
        [201],
      );

      await triggerAndFailManualRun({
        actor: owner,
        automationId: automation.body.id,
        onBeforeComplete: async (chatThreadId) => {
          await accept(
            chatMuteApi.mute({
              headers: asUser(owner),
              params: { id: chatThreadId },
              query: {},
            }),
            [204],
          );
        },
      });
      await triggerAndFailManualRun({
        actor: owner,
        automationId: automation.body.id,
      });
      await triggerAndFailManualRun({
        actor: owner,
        automationId: automation.body.id,
        error: "Insufficient credits",
        failureReason: "insufficient_credits",
      });

      const beforeFourth = await accept(
        automationsApi.get({
          headers: asUser(owner),
          params: { id: automation.body.id },
        }),
        [200],
      );
      expect(beforeFourth.body.enabled).toBeTruthy();
      const eventsBeforeFourth = await accept(
        feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
        [200],
      );
      expect(eventsBeforeFourth.body.items).toStrictEqual([]);

      await triggerAndFailManualRun({
        actor: owner,
        automationId: automation.body.id,
        redeliverCompletion: true,
      });

      const afterFourth = await accept(
        automationsApi.get({
          headers: asUser(owner),
          params: { id: automation.body.id },
        }),
        [200],
      );
      expect(afterFourth.body).toMatchObject({
        enabled: false,
        nextRunAt: null,
      });

      const eventsAfterFourth = await accept(
        feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
        [200],
      );
      expect(eventsAfterFourth.body.items).toHaveLength(1);
      const event = eventsAfterFourth.body.items[0];
      if (!event || event.type !== "event") {
        throw new Error("Expected automation-disabled platform event");
      }
      expect(event).toMatchObject({
        type: "event",
        sourceType: "platform-event",
        expiresAt: null,
        state: { status: "active" },
        content: {
          eventType: "automation-disabled",
          automationId: automation.body.id,
          workflowId,
          workspaceId: owner.orgId,
          automationName: workflowName,
          automationDescription: workflowDescription,
          disabledAt: FIXED_TIME_ISO,
          consecutiveFailures: 3,
          recoveryScheduled: false,
        },
      });

      await accept(
        feedApi.updateSources({
          headers: asUser(owner),
          body: { suggestions: false, whatsNew: false, offers: false },
        }),
        [200],
      );
      const summaryWithSystemOn = await accept(
        feedApi.summary({ headers: asUser(owner) }),
        [200],
      );
      expect(summaryWithSystemOn.body.hasUnread).toBeTruthy();

      await accept(
        feedApi.updateSources({
          headers: asUser(owner),
          body: { systemUpdates: false },
        }),
        [200],
      );
      const [summaryWithSystemOff, eventsWithSystemOff] = await Promise.all([
        accept(feedApi.summary({ headers: asUser(owner) }), [200]),
        accept(
          feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
          [200],
        ),
      ]);
      expect(summaryWithSystemOff.body.hasUnread).toBeFalsy();
      expect(eventsWithSystemOff.body.items).toStrictEqual([event]);

      await accept(
        feedApi.updateSources({
          headers: asUser(owner),
          body: { suggestions: true, offers: true },
        }),
        [200],
      );
      const [sourcesAfterOtherReenable, summaryStillOff] = await Promise.all([
        accept(feedApi.sources({ headers: asUser(owner) }), [200]),
        accept(feedApi.summary({ headers: asUser(owner) }), [200]),
      ]);
      expect(sourcesAfterOtherReenable.body.systemUpdates).toBeFalsy();
      expect(summaryStillOff.body.hasUnread).toBeFalsy();

      await accept(
        feedApi.updateSources({
          headers: asUser(owner),
          body: { systemUpdates: true },
        }),
        [200],
      );
      const summaryRestored = await accept(
        feedApi.summary({ headers: asUser(owner) }),
        [200],
      );
      expect(summaryRestored.body.hasUnread).toBeTruthy();

      await accept(
        feedApi.markRead({
          headers: asUser(owner),
          params: { id: event.id },
        }),
        [200],
      );
      const summaryAfterRead = await accept(
        feedApi.summary({ headers: asUser(owner) }),
        [200],
      );
      expect(summaryAfterRead.body.hasUnread).toBeFalsy();

      const finalAutomation = await accept(
        automationsApi.get({
          headers: asUser(owner),
          params: { id: automation.body.id },
        }),
        [200],
      );
      expect(finalAutomation.body.enabled).toBeFalsy();
    },
  );

  it(
    "automation-disabled-feed-events-003 stops future system update deliveries until enabled again without changing automation failure handling",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(new Date(FIXED_TIME_ISO));
      const { actor: owner } = await workflowsBdd.setupWorkflowOrg({
        tier: "pro",
      });
      if (!owner.orgId) {
        throw new Error("Expected org-scoped owner");
      }
      installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      onTestFinished(async () => {
        await cleanupDispatchedRuns(owner, runnerGroup);
        clearMockNow();
      });
      const workflowName = `sys-updates-${randomUUID().slice(0, 8)}`;
      const workflowDescription = "Checks queue latency";
      const workflowId = await workflowsBdd.createWorkflow(owner, {
        name: workflowName,
        visibility: "private",
        description: workflowDescription,
      });
      const automation = await accept(
        automationsApi.create({
          headers: asUser(owner),
          params: { workflowId },
          body: {
            kind: "schedule",
            schedule: {
              type: "cron",
              cronExpression: "* * * * *",
              timezone: "UTC",
            },
          },
        }),
        [201],
      );

      const updatedSources = await accept(
        feedApi.updateSources({
          headers: asUser(owner),
          body: { systemUpdates: false },
        }),
        [200],
      );
      expect(updatedSources.body).toStrictEqual({
        suggestions: true,
        whatsNew: true,
        offers: true,
        systemUpdates: false,
      });

      for (let attempt = 0; attempt < 3; attempt++) {
        await triggerAndFailManualRun({
          actor: owner,
          automationId: automation.body.id,
        });
      }

      const disabledFirst = await accept(
        automationsApi.get({
          headers: asUser(owner),
          params: { id: automation.body.id },
        }),
        [200],
      );
      expect(disabledFirst.body.enabled).toBeFalsy();

      const emptyFeedOff = await accept(
        feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
        [200],
      );
      expect(emptyFeedOff.body.items).toStrictEqual([]);

      await accept(
        feedApi.updateSources({
          headers: asUser(owner),
          body: { systemUpdates: true },
        }),
        [200],
      );
      const noBackfill = await accept(
        feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
        [200],
      );
      expect(noBackfill.body.items).toStrictEqual([]);

      await accept(
        automationsApi.enable({
          headers: asUser(owner),
          params: { id: automation.body.id },
        }),
        [200],
      );

      for (let attempt = 0; attempt < 3; attempt++) {
        await triggerAndFailManualRun({
          actor: owner,
          automationId: automation.body.id,
        });
      }

      const disabledSecond = await accept(
        automationsApi.get({
          headers: asUser(owner),
          params: { id: automation.body.id },
        }),
        [200],
      );
      expect(disabledSecond.body.enabled).toBeFalsy();

      const eventsAfterSecond = await accept(
        feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
        [200],
      );
      expect(eventsAfterSecond.body.items).toHaveLength(1);
      expect(eventsAfterSecond.body.items[0]).toMatchObject({
        type: "event",
        sourceType: "platform-event",
        expiresAt: null,
        state: { status: "active" },
        content: {
          eventType: "automation-disabled",
          automationId: automation.body.id,
          workflowId,
          workspaceId: owner.orgId,
          automationName: workflowName,
          automationDescription: workflowDescription,
          disabledAt: FIXED_TIME_ISO,
          consecutiveFailures: 3,
          recoveryScheduled: false,
        },
      });
    },
  );

  it(
    "automation-disabled-feed-events-004 does not emit for a manual disable and can emit again after re-enabling",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(new Date(FIXED_TIME_ISO));
      const { actor: owner } = await workflowsBdd.setupWorkflowOrg({
        tier: "pro",
      });
      installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      onTestFinished(async () => {
        await cleanupDispatchedRuns(owner, runnerGroup);
        clearMockNow();
      });
      const workflowId = await workflowsBdd.createWorkflow(owner, {
        name: `manual-disable-${randomUUID().slice(0, 8)}`,
        visibility: "private",
      });
      const automation = await accept(
        automationsApi.create({
          headers: asUser(owner),
          params: { workflowId },
          body: {
            kind: "schedule",
            schedule: {
              type: "cron",
              cronExpression: "* * * * *",
              timezone: "UTC",
            },
          },
        }),
        [201],
      );

      await accept(
        automationsApi.disable({
          headers: asUser(owner),
          params: { id: automation.body.id },
        }),
        [200],
      );
      const afterManualDisable = await accept(
        feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
        [200],
      );
      expect(afterManualDisable.body.items).toStrictEqual([]);

      for (const expectedCount of [1, 2]) {
        await accept(
          automationsApi.enable({
            headers: asUser(owner),
            params: { id: automation.body.id },
          }),
          [200],
        );
        for (let attempt = 0; attempt < 3; attempt++) {
          await triggerAndFailManualRun({
            actor: owner,
            automationId: automation.body.id,
          });
        }
        const events = await accept(
          feedApi.list({ headers: asUser(owner), query: { type: "event" } }),
          [200],
        );
        expect(events.body.items).toHaveLength(expectedCount);
      }
    },
  );
});
