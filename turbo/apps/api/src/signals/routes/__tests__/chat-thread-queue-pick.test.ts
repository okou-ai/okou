import { randomUUID } from "node:crypto";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventAutomationPart } from "./helpers/chat-event";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

/**
 * CHAT-02: at organization capacity, chat input waits in its thread without a
 * run. A pick launches the thread's FIFO head when a slot frees (the ending
 * run's thread first, then the organization's oldest waiting thread) or when
 * the cron sweep finds capacity.
 */
const context = testContext({ connectorCatalog: true });
const {
  bdd,
  chat,
  routeMocks,
  entitledNativeChatActor,
  sendChatRun,
  sendWaitingChatInput,
  claimChatRun,
  completeChatRunOk,
  cancelChatRun,
  waitForRunStatus,
  chatCallbacks,
} = createChatEventsFixture(context);
const wf = createWorkflowsBddApi(context);

const WORKFLOW_NAME = "chat-thread-queue-pick-workflow";

const WEBHOOK_APP_ROUTES = Object.freeze([
  ...webhooksWorkflowAutomationsRoutes,
  ...chatEventsRoutes,
  ...chatThreadRoutes,
  ...workflowAutomationsRoutes,
]);

/** Run the real cron sweep scoped to the given threads. */
async function sweepQueuedThreads(chatThreadIds: string[]): Promise<void> {
  await accept(
    setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
      testCronCleanupSandboxesStateContract,
    ).cleanup({
      body: { chatThreadIds, runIds: [], orgIds: [], exportJobIds: [] },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

/** The run that launched a sent input, or undefined while it still waits. */
async function runOfInput(
  actor: ApiTestUser,
  threadId: string,
  clientEventId: string,
): Promise<string | undefined> {
  const page = await chat.listThreadEvents(actor, threadId);
  return userMessages(page.events).find((message) => {
    return (
      message.revokesEventId === clientEventId && message.runId !== undefined
    );
  })?.runId;
}

/** Runs launched on a thread, oldest first. */
async function threadRunIds(
  actor: ApiTestUser,
  threadId: string,
): Promise<readonly string[]> {
  const page = await chat.listThreadEvents(actor, threadId);
  return [
    ...new Set(
      userMessages(page.events).flatMap((message) => {
        return message.runId === undefined ? [] : [message.runId];
      }),
    ),
  ];
}

async function sendWaiting(
  actor: ApiTestUser,
  agentId: string,
  prompt: string,
  threadId?: string,
) {
  const clientEventId = randomUUID();
  const waiting = await sendWaitingChatInput(actor, {
    agentId,
    prompt,
    clientEventId,
    ...(threadId === undefined ? {} : { threadId }),
  });
  return { ...waiting, clientEventId };
}

/** Claim a run through the Runner and complete it successfully. */
async function finishRun(runnerGroup: string, runId: string): Promise<void> {
  const { sandboxHeaders } = await claimChatRun(runnerGroup, runId);
  chatCallbacks.mockChatOutputEvents([]);
  await completeChatRunOk(runId, sandboxHeaders);
  await flushWaitUntilForTest();
}

function clerkHeaders(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

async function createWebhookAutomation(
  actor: ApiTestUser,
  agentId: string,
): Promise<{
  readonly threadId: string;
  readonly token: string;
  readonly secret: string;
}> {
  bdd.acceptAgentStorageWrites();
  const workflowId = await wf.createWorkflow(actor, {
    agentId,
    name: WORKFLOW_NAME,
  });
  const created = await accept(
    setupApp({ context, routes: workflowAutomationsRoutes })(
      workflowAutomationsContract,
    ).create({
      headers: clerkHeaders(actor),
      params: { workflowId },
      body: { kind: "event", eventType: "webhook-received" },
    }),
    [201],
  );
  if (
    created.body.kind !== "event" ||
    created.body.eventType !== "webhook-received" ||
    !created.body.webhookUrl ||
    !created.body.webhookSecret ||
    !created.body.chatThreadId
  ) {
    throw new Error("Expected a thread-bound webhook automation with a secret");
  }
  const token = new URL(created.body.webhookUrl).pathname.split("/").at(-1);
  if (!token) {
    throw new Error("Expected webhook URL token");
  }
  return {
    threadId: created.body.chatThreadId,
    token,
    secret: created.body.webhookSecret,
  };
}

async function postWorkflowWebhook(
  automation: { readonly token: string; readonly secret: string },
  payload: string,
): Promise<void> {
  const rawBody = JSON.stringify({ event: payload });
  const timestamp = Math.floor(now() / 1000);
  const response = await createApp({
    signal: context.signal,
    routes: WEBHOOK_APP_ROUTES,
  }).request(`/api/webhooks/workflow-automations/${automation.token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Okou-Timestamp": String(timestamp),
      "X-Okou-Signature": computeHmacSignature(
        rawBody,
        automation.secret,
        timestamp,
      ),
    },
    body: rawBody,
  });
  expect(response.status).toBe(200);
  await flushWaitUntilForTest();
}

/** Run ids of automation-fired prompts, oldest first. */
async function automationRunIds(
  actor: ApiTestUser,
  threadId: string,
): Promise<readonly string[]> {
  const page = await chat.listThreadEvents(actor, threadId);
  return page.events.flatMap((event) => {
    if (
      event.eventType !== "input.prompt" ||
      chatEventAutomationPart(event)?.workflowName !== WORKFLOW_NAME ||
      !event.runId
    ) {
      return [];
    }
    return [event.runId];
  });
}

describe("CHAT-02: queued chat thread picks", () => {
  it("launches only the FIFO head of a waiting thread and resumes its latest session", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the thread session",
    });
    await finishRun(runnerGroup, first.runId);

    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const head = await sendWaiting(
      actor,
      agentId,
      "first queued message",
      first.threadId,
    );
    const second = await sendWaiting(
      actor,
      agentId,
      "second queued message",
      first.threadId,
    );

    await finishRun(runnerGroup, blocker.runId);

    const picked = await head.launchedRun();
    await expect(
      runOfInput(actor, first.threadId, second.clientEventId),
    ).resolves.toBeUndefined();
    const resumed = await claimChatRun(runnerGroup, picked.runId);
    expect(resumed.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );

    // The second input waits for the head's run and then takes its slot.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(picked.runId, resumed.sandboxHeaders);
    await flushWaitUntilForTest();
    const next = await second.launchedRun();
    expect(next.runId).not.toBe(picked.runId);
    const nextClaim = await claimChatRun(runnerGroup, next.runId);
    expect(nextClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${picked.runId}`,
    );
    await cancelChatRun(actor, next.runId);
  }, 90_000);

  it("gives the freed slot to the same thread before an older waiting thread", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const running = await sendChatRun(actor, {
      agentId,
      prompt: "thread A holds the only slot",
    });
    const runningClaim = await claimChatRun(runnerGroup, running.runId);
    await waitForRunStatus(actor, running.runId, "running");

    const olderThread = await sendWaiting(
      actor,
      agentId,
      "thread B queued first",
    );
    const sameThread = await sendWaiting(
      actor,
      agentId,
      "thread A queued second",
      running.threadId,
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(running.runId, runningClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const takeover = await sameThread.launchedRun();
    await expect(
      runOfInput(actor, olderThread.threadId, olderThread.clientEventId),
    ).resolves.toBeUndefined();

    // Once the same thread's run ends with nothing left, the older thread
    // gets the slot.
    await finishRun(runnerGroup, takeover.runId);
    const older = await olderThread.launchedRun();
    await cancelChatRun(actor, older.runId);
  }, 90_000);

  it("launches an automation event appended before a user message first (strict FIFO)", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor(
      {},
      "team",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const automation = await createWebhookAutomation(actor, agentId);
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });

    await postWorkflowWebhook(automation, "automation before the user");
    const user = await sendWaiting(
      actor,
      agentId,
      "user after automation",
      automation.threadId,
    );
    await expect(
      automationRunIds(actor, automation.threadId),
    ).resolves.toStrictEqual([]);

    await finishRun(runnerGroup, blocker.runId);

    await expect
      .poll(() => {
        return automationRunIds(actor, automation.threadId);
      })
      .toHaveLength(1);
    const [automationRunId] = await automationRunIds(
      actor,
      automation.threadId,
    );
    if (!automationRunId) {
      throw new Error("Expected the automation event to launch");
    }
    await expect(
      runOfInput(actor, automation.threadId, user.clientEventId),
    ).resolves.toBeUndefined();

    await finishRun(runnerGroup, automationRunId);
    const userRun = await user.launchedRun();
    expect(userRun.runId).not.toBe(automationRunId);
    await cancelChatRun(actor, userRun.runId);
  }, 90_000);

  it("takes over input sent while the thread's run was running", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const running = await sendChatRun(actor, {
      agentId,
      prompt: "the thread's running run",
    });
    const runningClaim = await claimChatRun(runnerGroup, running.runId);
    await waitForRunStatus(actor, running.runId, "running");

    // The send only steers the running run; the run end launches it.
    const steered = await sendWaiting(
      actor,
      agentId,
      "sent while the run is running",
      running.threadId,
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(running.runId, runningClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const takeover = await steered.launchedRun();
    expect(takeover.runId).not.toBe(running.runId);
    await cancelChatRun(actor, takeover.runId);
  }, 90_000);

  it("keeps a waiting thread pickable after the cron sweep finds the organization full", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const older = await sendWaiting(actor, agentId, "oldest waiting thread");
    const waiting = await sendWaiting(actor, agentId, "waits for the sweep");

    await sweepQueuedThreads([older.threadId, waiting.threadId]);
    await expect(
      runOfInput(actor, older.threadId, older.clientEventId),
    ).resolves.toBeUndefined();
    await expect(
      runOfInput(actor, waiting.threadId, waiting.clientEventId),
    ).resolves.toBeUndefined();

    // The freed slot goes to the organization's oldest waiting thread.
    await finishRun(runnerGroup, blocker.runId);
    const olderRun = await older.launchedRun();
    await expect(
      runOfInput(actor, waiting.threadId, waiting.clientEventId),
    ).resolves.toBeUndefined();

    await finishRun(runnerGroup, olderRun.runId);
    await sweepQueuedThreads([waiting.threadId]);
    const launched = await waiting.launchedRun();
    await cancelChatRun(actor, launched.runId);
  }, 90_000);

  it("skips a recalled head and launches a later message on the thread", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const recalled = await sendWaiting(actor, agentId, "recalled message");
    const recall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: recalled.threadId,
        revokesEventId: recalled.clientEventId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(recall.body.runId).toBeNull();

    await finishRun(runnerGroup, blocker.runId);
    await sweepQueuedThreads([recalled.threadId]);
    await expect(threadRunIds(actor, recalled.threadId)).resolves.toStrictEqual(
      [],
    );

    const later = await sendChatRun(actor, {
      agentId,
      threadId: recalled.threadId,
      prompt: "sent after the recall",
    });
    await expect(threadRunIds(actor, recalled.threadId)).resolves.toStrictEqual(
      [later.runId],
    );
    await cancelChatRun(actor, later.runId);
  }, 90_000);
});
