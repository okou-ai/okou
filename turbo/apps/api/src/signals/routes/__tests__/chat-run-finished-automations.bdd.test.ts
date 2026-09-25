import {
  setHistoricalGoalStatusFixture,
  historicalGoalStatusFixture,
  readGoalQueueStateFixture,
  seedGoalForRunFixture,
  setLegacyGoalRunOriginFixture,
} from "../../../test-fixtures/goal-queue";

import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { removeSnapshottedRunEvents } from "../../../test-fixtures/goal-schema-contraction";
import { installFakeChatEventR2 } from "./helpers/fake-chat-event-r2";

import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { installTerminalCallbackFailureFixture } from "../../../test-fixtures/chat-terminal-retry";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  readLatestWorkflowAutomationRunFixture,
  readWorkflowAutomationAutonomyFixture,
  setRunAutonomyBudgetFixture,
  setWorkflowAutomationAutonomyBudgetFixture,
} from "./helpers/runtime-state";

/**
 * chat-run-finished workflow automations: creation validation and dispatch
 * from the terminal chat callback (real sandbox complete webhooks).
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const misc = createMiscRoutesApi(context);
const wf = createWorkflowsBddApi(context);
const integrations = createBddIntegrationApi(context);
const WATCHED_THREAD_TITLE = "Watched chat run";

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

interface ChatAutomationFixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly providerId: string;
  readonly workflowId: string;
  readonly runnerGroup: string;
}

async function setupChatAutomationFixture(): Promise<ChatAutomationFixture> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensureOrgModelProvider(actor);
  // Completion and queue fixtures use the retained native Claude route.
  await api.updateOrgModelPolicies(actor, [
    {
      model: "claude-fable-5-1",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
    {
      model: "claude-sonnet-5",
      isDefault: false,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat run finished automation agent",
    description: "Exercises chat-run-finished automation dispatch.",
    visibility: "private",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: "chat-run-finished-workflow",
  });
  context.mocks.s3.send.mockResolvedValue({});
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId: agent.agentId,
    providerId,
    workflowId,
    runnerGroup,
  };
}

/**
 * Each automation gets its own workflow so it also gets its own automation
 * chat thread; automations sharing a workflow queue behind each other and
 * would not record `lastRunAt` until the prior automation run completes.
 */
async function createChatRunFinishedAutomation(
  fixture: ChatAutomationFixture,
  eventConfig: {
    readonly chatThreadId: string;
    readonly runStatuses?: readonly ("completed" | "failed" | "cancelled")[];
    readonly outputPattern?: string;
  },
  options: { readonly workflowChatThreadId?: string } = {},
): Promise<string> {
  const workflowId = await wf.createWorkflow(fixture.actor, {
    agentId: fixture.agentId,
    name: `crf-${randomUUID().slice(0, 8)}`,
    ...(options.workflowChatThreadId
      ? { chatThreadId: options.workflowChatThreadId }
      : {}),
  });
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId },
      body: {
        kind: "event",
        eventType: "chat-run-finished",
        eventConfig: {
          provider: "chat",
          event: "run_finished",
          chatThreadId: eventConfig.chatThreadId,
          ...(eventConfig.runStatuses
            ? { runStatuses: [...eventConfig.runStatuses] }
            : {}),
          ...(eventConfig.outputPattern
            ? { outputPattern: eventConfig.outputPattern }
            : {}),
        },
      },
    }),
    [201],
  );
  expect(created.body).toMatchObject({
    kind: "event",
    eventType: "chat-run-finished",
    enabled: true,
  });
  return created.body.id;
}

async function automationLastRunAt(automationId: string): Promise<unknown> {
  const automation = await accept(
    automationsClient().get({
      headers: authHeaders(),
      params: { id: automationId },
    }),
    [200],
  );
  return automation.body.lastRunAt;
}

async function startWatchedChatRun(
  fixture: ChatAutomationFixture,
  prompt: string,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(
    fixture.actor,
    {
      agentId: fixture.agentId,
      prompt,
      clientEventId: randomUUID(),
      model: "claude-fable-5-1",
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the chat send to create a run");
  }
  await chat.renameThread(
    fixture.actor,
    sent.body.threadId,
    WATCHED_THREAD_TITLE,
  );
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function createGoalForRun(
  actor: ApiTestUser,
  runId: string,
  objective: string,
): Promise<string> {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor for goal workflows");
  }
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: actor.userId,
      orgId: actor.orgId,
      orgRole: actor.orgRole,
    },
    {},
  );
  const goal = await seedGoalForRunFixture(runId, objective);
  return goal.objectiveBrief;
}

async function expectGoalStatus(
  actor: ApiTestUser,
  runId: string,
  status: "active" | "paused" | "blocked" | "complete",
): Promise<void> {
  await expect
    .poll(async () => {
      return await historicalGoalStatusFixture(runId);
    })
    .toBe(status);
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{ readonly authorization: string }> {
  await api.heartbeatRunner(runnerGroup);
  let claim: Awaited<ReturnType<typeof api.requestClaimRunnerJob>> | undefined;
  await expect
    .poll(
      async () => {
        claim = await api.requestClaimRunnerJob(true, runId, [200, 404]);
        return claim.status;
      },
      { interval: 100, timeout: 10_000 },
    )
    .toBe(200);
  if (!claim || claim.status !== 200) {
    throw new Error("Expected the chat run to be claimable");
  }
  return { authorization: `Bearer ${claim.body.sandboxToken}` };
}

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  options: { readonly lastEventSequence?: number } = {},
): Promise<void> {
  const stagedOutputEvents = chatCallbacks.consumeMockChatOutputEvents();
  if (stagedOutputEvents.length > 0) {
    await webhooks.requestAgentEvents(
      { runId, events: stagedOutputEvents },
      sandboxHeaders,
      [200],
    );
  }
  const historyHash = createHash("sha256")
    .update(`bdd chat session history ${runId}`)
    .digest("hex");
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      ...(options.lastEventSequence === undefined
        ? stagedOutputEvents.length === 0
          ? {}
          : {
              lastEventSequence: Math.max(
                ...stagedOutputEvents.map((event) => {
                  return event.sequenceNumber;
                }),
              ),
            }
        : { lastEventSequence: options.lastEventSequence }),
    },
    sandboxHeaders,
    [200],
  );
}

async function expectAutomationFired(automationId: string): Promise<void> {
  await expect
    .poll(
      () => {
        return automationLastRunAt(automationId);
      },
      { interval: 100, timeout: 10_000 },
    )
    .toBeTruthy();
}

async function expectAutomationSourceAnnotation(
  fixture: ChatAutomationFixture,
  automationId: string,
  sourceRun: { readonly runId: string; readonly threadId: string },
): Promise<string | null> {
  const automation = await accept(
    automationsClient().get({
      headers: authHeaders(),
      params: { id: automationId },
    }),
    [200],
  );
  const automationThreadId = automation.body.chatThreadId;
  if (!automationThreadId) {
    throw new Error("Expected the automation chat thread");
  }
  const automationRun = await readLatestWorkflowAutomationRunFixture(
    context,
    automationId,
  );
  if (!automationRun) {
    throw new Error("Expected the triggered automation run");
  }
  const automationEvents = await chat.listThreadEvents(
    fixture.actor,
    automationThreadId,
  );
  const automationInput = automationEvents.events.find((event) => {
    return (
      event.eventType === "input.prompt" && event.runId === automationRun.runId
    );
  });
  if (!automationInput || automationInput.eventType !== "input.prompt") {
    throw new Error("Expected the triggered automation input");
  }
  expect(
    automationInput.userMessage.parts.filter((part) => {
      return (
        part.type === "source" ||
        part.type === "automation" ||
        part.type === "goal"
      );
    }),
  ).toStrictEqual([
    {
      type: "source",
      kind: "agent",
      runId: sourceRun.runId,
      threadId: sourceRun.threadId,
      agentId: fixture.agentId,
      titleSnapshot: WATCHED_THREAD_TITLE,
      href: `/chats/${sourceRun.threadId}#run-${sourceRun.runId}`,
    },
  ]);
  return chatEventDisplayText(automationInput);
}

async function archiveAutomationThreadForRetry(
  threadId: string,
): Promise<void> {
  const previous = context.mocks.s3.send.getMockImplementation();
  installFakeChatEventR2(context);
  const snapshot = context.mocks.s3.send.getMockImplementation();
  if (!previous || !snapshot) {
    throw new Error("Expected object storage fixtures");
  }
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      (command instanceof GetObjectCommand ||
        command instanceof PutObjectCommand) &&
      command.input.Key?.startsWith("chat-events/")
    ) {
      return snapshot(command);
    }
    return previous(command);
  });
  await accept(
    setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
      testChatEventSearchProjectionContract,
    ).project({ body: { chat_thread_ids: [threadId] } }),
    [200],
  );
  await accept(
    setupApp({ context, routes: testChatEventSnapshotRoutes })(
      testChatEventSnapshotContract,
    ).snapshot({ body: { chat_thread_ids: [threadId], r2_object_keys: [] } }),
    [200],
  );
  // Retention is infrastructure-only. The existing fixture refuses deletion
  // unless this thread has a durable snapshot covering the removed events.
  await removeSnapshottedRunEvents(threadId);
}

type SplitTerminalStatus = "completed" | "failed" | "cancelled";

interface SplitSlackWatchedRun {
  readonly fixture: ChatAutomationFixture;
  readonly runId: string;
  readonly threadId: string;
  readonly headers: { readonly authorization: string };
  readonly automationId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly nextInputId: string;
}

/**
 * Starts a claimed Slack-originated run whose thread is watched for `status`,
 * with a queued follow-up input and a registered push subscription.
 */
async function startSplitSlackWatchedRun(
  status: SplitTerminalStatus,
): Promise<SplitSlackWatchedRun> {
  const fixture = await setupChatAutomationFixture();
  integrations.configureSlackAppMocks();
  const slackUserId = `U_${randomUUID().replaceAll("-", "")}`;
  const { teamId, botUserId } = await integrations.installSlackWorkspace(
    fixture.actor,
    { installerSlackUserId: slackUserId },
  );
  const channelId = `C_${randomUUID().replaceAll("-", "")}`;
  const threadTs = "3000.000100";
  await integrations.postSlackEvent(teamId, {
    type: "app_mention",
    user: slackUserId,
    text: `<@${botUserId}> exercise ${status} retry`,
    channel: channelId,
    ts: threadTs,
  });
  await api.heartbeatRunner(fixture.runnerGroup);
  let watchedRunId: string | undefined;
  await expect
    .poll(async () => {
      watchedRunId = (await api.pollRunner(fixture.runnerGroup)).body.job
        ?.runId;
      return watchedRunId;
    })
    .toBeTruthy();
  if (!watchedRunId) {
    throw new Error("Expected the Slack run to be admitted");
  }
  const runId = watchedRunId;
  const claim = await api.claimRunnerJob(runId);
  const headers = { authorization: `Bearer ${claim.sandboxToken}` };
  const threadId = claim.platformEnvironment.OKOU_CHAT_THREAD_ID;
  if (!threadId) {
    throw new Error("Expected the runner's canonical chat thread identity");
  }
  const automationId = await createChatRunFinishedAutomation(fixture, {
    chatThreadId: threadId,
    runStatuses: [status],
  });
  const watchedThread = await chat.readThreadMetadata(fixture.actor, threadId);
  const nextInputId = randomUUID();
  const queued = await chat.requestSendEvent(
    fixture.actor,
    {
      agentId: watchedThread.agentId,
      threadId,
      prompt: "Continue after the retried callback",
      clientEventId: nextInputId,
    },
    [201],
  );
  if (queued.status !== 201) {
    throw new Error("Expected the follow-up input to be accepted");
  }
  expect(queued.body.runId).toBeNull();
  await chatCallbacks.registerPushSubscription(fixture.actor);
  chatCallbacks.enableVapid();
  return {
    fixture,
    runId,
    threadId,
    headers,
    automationId,
    channelId,
    threadTs,
    nextInputId,
  };
}

async function splitTerminalCompletion(
  run: SplitSlackWatchedRun,
  status: SplitTerminalStatus,
) {
  if (status !== "completed") {
    return {
      runId: run.runId,
      exitCode: 1,
      error:
        status === "cancelled" ? "Run cancelled" : "Synthetic runner failure",
    };
  }
  await webhooks.requestAgentEvents(
    {
      runId: run.runId,
      events: [
        {
          type: "assistant",
          sequenceNumber: 0,
          message: {
            id: `msg_${run.runId}`,
            content: [{ type: "text", text: "The watched task is complete." }],
          },
        },
      ],
    },
    run.headers,
    [200],
  );
  return {
    runId: run.runId,
    exitCode: 0,
    lastEventSequence: 0,
    checkpoint: {
      cliAgentType: "claude-code" as const,
      cliAgentSessionId: `bdd-cli-${run.runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`bdd chat session history ${run.runId}`)
        .digest("hex"),
    },
  };
}

/** Runs `work` while one forced persistence failure is armed for the run. */
async function withTerminalCallbackFault(
  runId: string,
  boundary: Parameters<typeof installTerminalCallbackFailureFixture>[1],
  work: () => Promise<void>,
): Promise<void> {
  const removeFault = await installTerminalCallbackFailureFixture(
    runId,
    boundary,
  );
  const attempt = await settleIncludingAbort(work());
  const cleanup = await settleIncludingAbort(removeFault());
  if (!attempt.ok) {
    throw attempt.error;
  }
  if (!cleanup.ok) {
    throw cleanup.error;
  }
}

async function lifecycleMarkerCount(
  run: SplitSlackWatchedRun,
  status: SplitTerminalStatus,
): Promise<number> {
  const events = await chat.listThreadEvents(run.fixture.actor, run.threadId);
  return events.events.filter((event) => {
    return event.eventType === `run.${status}` && event.runId === run.runId;
  }).length;
}

function slackThreadDeliveryCount(run: SplitSlackWatchedRun): number {
  return context.mocks.slack.chat.postMessage.mock.calls.filter(([message]) => {
    const delivered = z
      .object({ channel: z.string(), thread_ts: z.string().optional() })
      .parse(message);
    return (
      delivered.channel === run.channelId &&
      delivered.thread_ts === run.threadTs
    );
  }).length;
}

/** Terminal push notifications are post-marker deferred completion work. */
function threadPushNotificationCount(run: SplitSlackWatchedRun): number {
  return context.mocks.webpush.sendNotification.mock.calls.filter((call) => {
    const payload = z
      .object({ url: z.url() })
      .parse(JSON.parse(z.string().parse(call[1])));
    return new URL(payload.url).pathname === `/chats/${run.threadId}`;
  }).length;
}

async function automationInputsForSourceRun(run: SplitSlackWatchedRun) {
  const automation = await accept(
    automationsClient().get({
      headers: authHeaders(),
      params: { id: run.automationId },
    }),
    [200],
  );
  const automationThreadId = automation.body.chatThreadId;
  if (!automationThreadId) {
    throw new Error("Expected the admitted automation thread");
  }
  const automationEvents = await chat.listThreadEvents(
    run.fixture.actor,
    automationThreadId,
  );
  return {
    automationThreadId,
    events: automationEvents.events,
    inputs: automationEvents.events.filter((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.userMessage.parts.some((part) => {
          return (
            part.type === "source" &&
            part.kind === "agent" &&
            part.runId === run.runId
          );
        })
      );
    }),
  };
}

describe("chat-run-finished workflow automations", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "retries a split %s callback through delivery and watched automation admission once",
    { timeout: 120_000 },
    async (status) => {
      const run = await startSplitSlackWatchedRun(status);
      const { fixture, runId, threadId, headers, automationId } = run;
      const completion = await splitTerminalCompletion(run, status);
      await withTerminalCallbackFault(
        runId,
        "delivery-registration",
        async () => {
          const failedCompletion = await webhooks.requestAgentComplete(
            completion,
            headers,
            [200, 500],
          );
          expect(failedCompletion.status).toBe(500);
          await expect(lifecycleMarkerCount(run, status)).resolves.toBe(1);
          await expect(automationLastRunAt(automationId)).resolves.toBeNull();
          await flushWaitUntilForTest();
          expect(threadPushNotificationCount(run)).toBe(0);
        },
      );

      // The next attempt replays the committed marker, admits the automation
      // and finishes its deferred completion work, but loses its final
      // callback acknowledgement. Retrying that source must not admit again.
      await withTerminalCallbackFault(
        runId,
        "source-acknowledgement",
        async () => {
          const failedAcknowledgement = await webhooks.requestAgentComplete(
            completion,
            headers,
            [200, 500],
          );
          expect(failedAcknowledgement.status).toBe(500);
          await expectAutomationFired(automationId);
          await flushWaitUntilForTest();
          expect(threadPushNotificationCount(run)).toBe(1);
        },
      );
      const admitted = await automationInputsForSourceRun(run);
      expect(admitted.inputs).toHaveLength(1);
      const [automationInput] = admitted.inputs;
      const cursor = admitted.events.at(-1);
      if (!automationInput?.runId || !cursor) {
        throw new Error(
          "Expected the triggered automation to own a run and cursor",
        );
      }
      await archiveAutomationThreadForRetry(admitted.automationThreadId);
      await webhooks.requestAgentComplete(completion, headers, [200]);
      await webhooks.requestAgentComplete(completion, headers, [200]);
      const afterRetry = await chat.listThreadEvents(
        fixture.actor,
        admitted.automationThreadId,
        {
          sinceSeqId: cursor.seqId,
          sinceEventId: cursor.id,
        },
      );
      expect(
        afterRetry.events.filter((event) => {
          return (
            event.eventType === "input.prompt" ||
            event.eventType === "input.automation"
          );
        }),
      ).toHaveLength(0);
      const triggered = await api.claimRunnerJob(automationInput.runId);
      expect(triggered.prompt).toContain(status);
      let nextRunId: string | undefined;
      await expect
        .poll(async () => {
          const events = await chat.listThreadEvents(fixture.actor, threadId);
          nextRunId =
            events.events.find((event) => {
              return (
                event.eventType === "input.prompt" &&
                event.revokesEventId === run.nextInputId
              );
            })?.runId ?? undefined;
          return nextRunId;
        })
        .toBeTruthy();
      expect(nextRunId).not.toBe(runId);
      await expect(lifecycleMarkerCount(run, status)).resolves.toBe(1);
      expect(slackThreadDeliveryCount(run)).toBe(1);
    },
  );

  it(
    "finishes deferred completion work when a split callback retries failed automation admission",
    { timeout: 120_000 },
    async () => {
      const run = await startSplitSlackWatchedRun("completed");
      const completion = await splitTerminalCompletion(run, "completed");
      await withTerminalCallbackFault(
        run.runId,
        "automation-admission",
        async () => {
          const failedAdmission = await webhooks.requestAgentComplete(
            completion,
            run.headers,
            [200, 500],
          );
          expect(failedAdmission.status).toBe(500);
          await flushWaitUntilForTest();
          await expect(lifecycleMarkerCount(run, "completed")).resolves.toBe(1);
          await expect(
            automationLastRunAt(run.automationId),
          ).resolves.toBeNull();
          expect(slackThreadDeliveryCount(run)).toBe(1);
          expect(threadPushNotificationCount(run)).toBe(0);
        },
      );

      await webhooks.requestAgentComplete(completion, run.headers, [200]);
      await expectAutomationFired(run.automationId);
      await flushWaitUntilForTest();
      expect(threadPushNotificationCount(run)).toBe(1);

      await webhooks.requestAgentComplete(completion, run.headers, [200]);
      await flushWaitUntilForTest();
      await expect(automationInputsForSourceRun(run)).resolves.toMatchObject({
        inputs: [expect.anything()],
      });
      await expect(lifecycleMarkerCount(run, "completed")).resolves.toBe(1);
      expect(slackThreadDeliveryCount(run)).toBe(1);
      expect(threadPushNotificationCount(run)).toBe(1);
    },
  );

  it(
    "redrives an unfinished split cancellation callback from the cancel route once",
    { timeout: 120_000 },
    async () => {
      const run = await startSplitSlackWatchedRun("cancelled");
      await withTerminalCallbackFault(
        run.runId,
        "delivery-registration",
        async () => {
          await api.requestCancelRun(run.fixture.actor, run.runId, [200]);
          await flushWaitUntilForTest();
          await expect(lifecycleMarkerCount(run, "cancelled")).resolves.toBe(1);
          await expect(
            automationLastRunAt(run.automationId),
          ).resolves.toBeNull();
          expect(slackThreadDeliveryCount(run)).toBe(0);
          expect(threadPushNotificationCount(run)).toBe(0);
        },
      );
      const cancelledThread = await chat.readThread(
        run.fixture.actor,
        run.threadId,
      );
      expect(cancelledThread.cancellationRecoveryPending).toBeTruthy();

      // Repeating the cancel request is the recovery redrive owner. The
      // marker already exists, but its source callback is still undelivered.
      await api.requestCancelRun(run.fixture.actor, run.runId, [200]);
      await flushWaitUntilForTest();
      await expectAutomationFired(run.automationId);
      expect(slackThreadDeliveryCount(run)).toBe(1);
      expect(threadPushNotificationCount(run)).toBe(1);

      await api.requestCancelRun(run.fixture.actor, run.runId, [200]);
      await flushWaitUntilForTest();
      const admitted = await automationInputsForSourceRun(run);
      expect(admitted.inputs).toHaveLength(1);
      await expect(lifecycleMarkerCount(run, "cancelled")).resolves.toBe(1);
      expect(slackThreadDeliveryCount(run)).toBe(1);
      expect(threadPushNotificationCount(run)).toBe(1);
    },
  );

  it("requires the watched chat thread to belong to the automation owner", async () => {
    const fixture = await setupChatAutomationFixture();

    const missingThread = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: fixture.workflowId },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: randomUUID(),
          },
        },
      }),
      [400],
    );
    expect(missingThread.body.error.message).toContain("Chat thread not found");

    const otherUser = bdd.user({
      orgId: fixture.actor.orgId ?? undefined,
      orgRole: "org:member",
    });
    const otherAgent = await bdd.createAgent(otherUser, {
      displayName: "Other member agent",
      visibility: "private",
    });
    const otherThread = await chat.createThread(otherUser, {
      agentId: otherAgent.agentId,
      model: "claude-sonnet-5",
    });
    // Restore the fixture actor's session after acting as the other member.
    await bdd.readMe(fixture.actor);
    const foreignThread = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: fixture.workflowId },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: otherThread.id,
          },
        },
      }),
      [400],
    );
    expect(foreignThread.body.error.message).toContain("Chat thread not found");
  });

  it("prevents a workflow from watching its own chat thread", async () => {
    const fixture = await setupChatAutomationFixture();
    const workflowThread = await chat.createThread(fixture.actor, {
      agentId: fixture.agentId,
      model: "claude-sonnet-5",
    });
    const workflowId = await wf.createWorkflow(fixture.actor, {
      agentId: fixture.agentId,
      name: `self-watching-${randomUUID().slice(0, 8)}`,
      chatThreadId: workflowThread.id,
    });

    const response = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: workflowThread.id,
          },
        },
      }),
      [400],
    );
    expect(response.body.error.message).toBe(
      "A workflow cannot watch run-finished events from its own chat thread",
    );
  });

  it(
    "fires claimable matching automations when a watched run completes",
    { timeout: 30_000 },
    async () => {
      const fixture = await setupChatAutomationFixture();
      const run = await startWatchedChatRun(fixture, "watched completed run");
      await setRunAutonomyBudgetFixture(context, run.runId, 2);

      const fireAlways = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
      });
      const failedOnly = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["failed"],
      });
      const patternMatch = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["completed"],
        outputPattern: "*deploy failed*",
      });
      const patternMiss = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        outputPattern: "*all systems nominal*",
      });
      await setWorkflowAutomationAutonomyBudgetFixture(
        context,
        patternMatch,
        0,
      );

      chatCallbacks.mockChatOutputEvents([
        {
          eventType: "assistant",
          sequenceNumber: 0,
          eventData: {
            message: {
              content: [{ type: "text", text: "Alert: Deploy FAILED on prod" }],
            },
          },
        },
      ]);
      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      await completeChatRunOk(run.runId, sandboxHeaders, {
        lastEventSequence: 0,
      });

      await expectAutomationFired(fireAlways);
      await expectAutomationFired(patternMatch);
      await expect(automationLastRunAt(failedOnly)).resolves.toBeNull();
      await expect(automationLastRunAt(patternMiss)).resolves.toBeNull();
      const fireAlwaysState = await readWorkflowAutomationAutonomyFixture(
        context,
        fireAlways,
      );
      const patternMatchState = await readWorkflowAutomationAutonomyFixture(
        context,
        patternMatch,
      );
      expect(fireAlwaysState).toMatchObject({ autonomyBudget: 10 });
      expect(patternMatchState).toMatchObject({ autonomyBudget: 0 });
      await expect(
        readLatestWorkflowAutomationRunFixture(context, fireAlways),
      ).resolves.toMatchObject({ autonomyBudget: 1 });
      await expect(
        readLatestWorkflowAutomationRunFixture(context, patternMatch),
      ).resolves.toMatchObject({ autonomyBudget: 1 });

      const displayMessage = await expectAutomationSourceAnnotation(
        fixture,
        fireAlways,
        run,
      );
      expect(displayMessage).toBe(
        "A run in the watched chat thread completed.",
      );

      const automationRuns = await api.listAgentRuns(fixture.actor, {
        status: "pending",
        limit: 20,
      });
      expect(automationRuns.runs).toHaveLength(2);
      const automationRunId = automationRuns.runs[0]?.id;
      if (!automationRunId) {
        throw new Error("Expected a triggered automation run");
      }
      await claimChatRun(fixture.runnerGroup, automationRunId);
    },
  );

  it("dispatches one real Goal completion automation without a successor", async () => {
    const fixture = await setupChatAutomationFixture();
    const run = await startWatchedChatRun(fixture, "finish existing Goal work");
    const automationId = await createChatRunFinishedAutomation(fixture, {
      chatThreadId: run.threadId,
      runStatuses: ["completed"],
    });
    const goal = await seedGoalForRunFixture(
      run.runId,
      "remaining historical Goal",
    );
    const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
    await setLegacyGoalRunOriginFixture(run.runId, goal.id);
    await completeChatRunOk(run.runId, sandboxHeaders);
    await expectAutomationFired(automationId);
    await completeChatRunOk(run.runId, sandboxHeaders);
    await flushWaitUntilForTest();
    await expectAutomationSourceAnnotation(fixture, automationId, run);
    const history = await readGoalQueueStateFixture(run.threadId);
    expect(history.eventIds).toStrictEqual([]);
    expect(history.runIds).toStrictEqual([run.runId]);
  }, 60_000);

  it(
    "fires a completed-run automation when the goal is blocked",
    { timeout: 30_000 },
    async () => {
      const fixture = await setupChatAutomationFixture();
      const run = await startWatchedChatRun(
        fixture,
        "finish after blocking the goal",
      );
      const automationId = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["completed"],
      });
      await createGoalForRun(
        fixture.actor,
        run.runId,
        "Block the watched thread goal",
      );
      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      await setHistoricalGoalStatusFixture(run.runId, "blocked");
      await expect(historicalGoalStatusFixture(run.runId)).resolves.toBe(
        "blocked",
      );

      await completeChatRunOk(run.runId, sandboxHeaders);

      await expectAutomationFired(automationId);
      await expectAutomationSourceAnnotation(fixture, automationId, run);
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "fires a %s-run automation while the historical Goal remains active",
    { timeout: 30_000 },
    async (terminalStatus) => {
      expect.hasAssertions();
      const fixture = await setupChatAutomationFixture();
      const run = await startWatchedChatRun(
        fixture,
        `${terminalStatus} run pauses the goal`,
      );
      const automationId = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: [terminalStatus],
      });
      await createGoalForRun(
        fixture.actor,
        run.runId,
        "Pause the watched thread goal",
      );
      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);

      if (terminalStatus === "failed") {
        await webhooks.requestAgentComplete(
          { runId: run.runId, exitCode: 1, error: "goal iteration failed" },
          sandboxHeaders,
          [200],
        );
      } else {
        await api.requestCancelRun(fixture.actor, run.runId, [200]);
      }

      await expectGoalStatus(fixture.actor, run.runId, "active");
      await expectAutomationFired(automationId);
      await expectAutomationSourceAnnotation(fixture, automationId, run);
    },
  );

  it(
    "fires completion despite an unavailable historical Goal model",
    { timeout: 60_000 },
    async () => {
      expect.hasAssertions();
      const fixture = await setupChatAutomationFixture();
      const firstRun = await startWatchedChatRun(
        fixture,
        "continue into a failed goal launch",
      );
      await createGoalForRun(
        fixture.actor,
        firstRun.runId,
        "Pause after the continuation fails to launch",
      );
      const automationProvider = await misc.upsertOrgModelProvider(
        fixture.actor,
        {
          type: "openai-api-key",
          secret: "goal-stop-automation-openai-key",
        },
        [201],
      );
      if (automationProvider.status !== 201) {
        throw new Error("Expected the automation model provider to be created");
      }
      await api.updateOrgModelPolicies(fixture.actor, [
        {
          model: "claude-sonnet-5",
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: fixture.providerId,
        },
        {
          model: "gpt-5.6-terra",
          isDefault: false,
          defaultProviderType: "openai-api-key",
          credentialScope: "org",
          modelProviderId: automationProvider.body.provider.id,
        },
      ]);
      const automationThread = await chat.createThread(fixture.actor, {
        agentId: fixture.agentId,
        model: "gpt-5.6-terra",
      });
      const automationId = await createChatRunFinishedAutomation(
        fixture,
        {
          chatThreadId: firstRun.threadId,
          runStatuses: ["completed"],
        },
        { workflowChatThreadId: automationThread.id },
      );
      await misc.deleteOrgModelProvider(
        fixture.actor,
        "anthropic-api-key",
        [204],
      );

      const sandboxHeaders = await claimChatRun(
        fixture.runnerGroup,
        firstRun.runId,
      );
      await completeChatRunOk(firstRun.runId, sandboxHeaders);
      await flushWaitUntilForTest();

      await expectGoalStatus(fixture.actor, firstRun.runId, "active");
      await expectAutomationFired(automationId);
      await expectAutomationSourceAnnotation(fixture, automationId, {
        runId: firstRun.runId,
        threadId: firstRun.threadId,
      });
    },
  );

  it(
    "shows an error instead of firing when the watched run exhausts its budget",
    { timeout: 30_000 },
    async () => {
      const fixture = await setupChatAutomationFixture();
      const run = await startWatchedChatRun(fixture, "exhausted watched run");
      const automationId = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
      });
      await setRunAutonomyBudgetFixture(context, run.runId, 0);

      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      await completeChatRunOk(run.runId, sandboxHeaders);

      let automationThreadId: string | null = null;
      await expect
        .poll(async () => {
          const automation = await accept(
            automationsClient().get({
              headers: authHeaders(),
              params: { id: automationId },
            }),
            [200],
          );
          automationThreadId = automation.body.chatThreadId;
          return automationThreadId;
        })
        .toStrictEqual(expect.any(String));
      const exhaustedAutomationThreadId = automationThreadId;
      if (!exhaustedAutomationThreadId) {
        throw new Error("Expected the automation chat thread");
      }

      await expect
        .poll(async () => {
          const messages = await chat.listThreadEvents(
            fixture.actor,
            exhaustedAutomationThreadId,
          );
          return messages.events.find((event) => {
            return event.eventType === "output.error";
          });
        })
        .toMatchObject({
          eventType: "output.error",
          error: "AUTONOMY_BUDGET_EXHAUSTED",
        });
      await expect(
        readWorkflowAutomationAutonomyFixture(context, automationId),
      ).resolves.toMatchObject({
        autonomyBudget: 10,
        enabled: true,
        lastRunId: null,
      });
      await expect(automationLastRunAt(automationId)).resolves.toBeNull();
    },
  );

  it(
    "fires failed-status automations without matching patterns on errors",
    { timeout: 30_000 },
    async () => {
      const fixture = await setupChatAutomationFixture();
      const run = await startWatchedChatRun(fixture, "watched failed run");

      const failedOnly = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["failed"],
      });
      const completedOnly = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["completed"],
      });
      const failedWithPattern = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["failed"],
        outputPattern: "*boom*",
      });

      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1, error: "boom: sandbox exploded" },
        sandboxHeaders,
        [200],
      );

      await expectAutomationFired(failedOnly);
      await expectAutomationSourceAnnotation(fixture, failedOnly, run);
      await expect(automationLastRunAt(completedOnly)).resolves.toBeNull();
      // Error messages are not matchable output, so pattern automations stay
      // silent even when the error text would match.
      await expect(automationLastRunAt(failedWithPattern)).resolves.toBeNull();
    },
  );
});
