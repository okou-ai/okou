import { createHash } from "node:crypto";

import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { aroundEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now, withNowScopeForTest } from "../../../lib/time";
import {
  markChatThreadQueuedFixture,
  pickEmptyHeadAcrossEnqueueFixture,
  readQueuedChatThreadFixture,
  removeQueuedChatThreadFixture,
} from "../../../test-fixtures/queued-chat-thread-race";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { modelProvidersRoutes } from "../model-providers";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import {
  chatEventAutomationPart,
  chatEventDisplayText,
} from "./helpers/chat-event";
import { createRouteMocks } from "./helpers/route-test";

const TEST_APP_ROUTES = Object.freeze([
  ...webhooksWorkflowAutomationsRoutes,
  ...chatEventsRoutes,
  ...chatThreadRoutes,
  ...modelProvidersRoutes,
  ...workflowAutomationsRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);

const WORKFLOW_NAME = "chat-thread-queue-compat-workflow";
function assistantOutput() {
  return [
    {
      eventType: "assistant",
      sequenceNumber: 0,
      eventData: { message: { content: [{ type: "text", text: "done" }] } },
    },
  ];
}

aroundEach(async (runTest) => {
  await withNowScopeForTest(runTest);
});

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function chatEventsClient() {
  return setupApp({ context, routes: chatEventsRoutes })(chatEventsContract);
}

function cleanupSandboxesClient() {
  return setupApp({
    context,
    routes: testCronCleanupSandboxesStateRoutes,
  })(testCronCleanupSandboxesStateContract);
}

interface Scenario {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly runnerGroup: string;
}

async function setup(): Promise<Scenario> {
  const runnerGroup = runsApi.configureRunnerGroup();
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  const { actor } = await wf.setupWorkflowOrg({ tier: "team" });
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  // Claimable native runs keep the queue observable through runner claims.
  const { providerId } = await runsApi.ensureOrgModelProvider(actor);
  await runsApi.updateOrgModelPolicies(actor, [
    {
      model: "claude-fable-5-1",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await wf.createAgent(actor, {
    displayName: "Chat Thread Queue Compat Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
  });
  mocks.clerk.session(actor.userId, actor.orgId);
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.mockChatOutputEvents(assistantOutput());
  return {
    actor,
    orgId: actor.orgId,
    agentId: agent.agentId,
    workflowId,
    runnerGroup,
  };
}

/** Send a user prompt; `runId` is null when the input waits in the thread. */
async function sendPrompt(
  scenario: Scenario,
  prompt: string,
  threadId?: string,
): Promise<{ readonly runId: string | null; readonly threadId: string }> {
  const response = await accept(
    chatEventsClient().send({
      headers: authHeaders(),
      body: {
        agentId: scenario.agentId,
        ...(threadId ? { threadId } : {}),
        prompt,
        model: "claude-fable-5-1",
        hasTextContent: true,
        userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
      },
    }),
    [201],
  );
  return { runId: response.body.runId, threadId: response.body.threadId };
}

async function sendRunningPrompt(
  scenario: Scenario,
  prompt: string,
  threadId?: string,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await sendPrompt(scenario, prompt, threadId);
  if (!sent.runId) {
    throw new Error(`Expected "${prompt}" to launch a run`);
  }
  return { runId: sent.runId, threadId: sent.threadId };
}

/** The run that launched the user prompt, or null while it still waits. */
async function promptRunId(
  threadId: string,
  prompt: string,
): Promise<string | null> {
  const events = await wf.readThreadEvents(threadId);
  const launched = events.find((event) => {
    return (
      event.eventType === "input.prompt" &&
      chatEventDisplayText(event) === prompt &&
      typeof event.runId === "string"
    );
  });
  return launched?.runId ?? null;
}

async function waitForPromptRun(
  threadId: string,
  prompt: string,
): Promise<string> {
  await expect
    .poll(() => {
      return promptRunId(threadId, prompt);
    })
    .not.toBeNull();
  const runId = await promptRunId(threadId, prompt);
  if (!runId) {
    throw new Error(`Expected "${prompt}" to launch a run`);
  }
  return runId;
}

/** Run ids of automation-fired prompts, oldest first. */
async function workflowRunIds(threadId: string): Promise<readonly string[]> {
  const events = await wf.readThreadEvents(threadId);
  return events.flatMap((event) => {
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

async function completeRunThroughSandbox(
  scenario: Scenario,
  runId: string,
): Promise<void> {
  await runsApi.heartbeatRunner(scenario.runnerGroup);
  const claim = await runsApi.claimRunnerJob(runId);
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  // The next run on the thread resumes this run's session history, which the
  // terminal callback stores from the run's assistant output.
  chatCallbacks.mockChatOutputEvents(assistantOutput());
  await webhooksApi.requestAgentEvents(
    { runId, events: chatCallbacks.consumeMockChatOutputEvents() },
    sandboxHeaders,
    [200],
  );
  await webhooksApi.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      lastEventSequence: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `chat-thread-queue-compat-${runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`chat thread queue compat history ${runId}`)
          .digest("hex"),
      },
    },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
}

async function cancelRun(scenario: Scenario, runId: string): Promise<void> {
  await runsApi.requestCancelRun(scenario.actor, runId, [200]);
  await flushWaitUntilForTest();
}

/** The fixture-scoped cron sweep: it picks exactly these threads' rows. */
async function sweepQueuedThreads(
  scenario: Scenario,
  chatThreadIds: readonly string[],
): Promise<void> {
  await accept(
    cleanupSandboxesClient().cleanup({
      body: {
        chatThreadIds: [...chatThreadIds],
        runIds: [],
        orgIds: [scenario.orgId],
        exportJobIds: [],
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

async function createWebhookAutomation(scenario: Scenario): Promise<{
  readonly threadId: string;
  readonly token: string;
  readonly secret: string;
}> {
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId: scenario.workflowId },
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
): Promise<unknown> {
  const rawBody = JSON.stringify({ event: payload });
  const timestamp = Math.floor(now() / 1000);
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
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
  return await response.json();
}

describe("chat thread queue compatibility", () => {
  it("deletes a queue row without pending input on the next sweep, and a later send re-creates it", async () => {
    const scenario = await setup();
    const first = await sendRunningPrompt(scenario, "first prompt");
    await completeRunThroughSandbox(scenario, first.runId);
    await markChatThreadQueuedFixture({
      chatThreadId: first.threadId,
      orgId: scenario.orgId,
    });

    await sweepQueuedThreads(scenario, [first.threadId]);

    await expect(
      readQueuedChatThreadFixture(first.threadId),
    ).resolves.toBeNull();

    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const blocker = await sendRunningPrompt(scenario, "hold org capacity");
    const waiting = await sendPrompt(
      scenario,
      "waits for a slot",
      first.threadId,
    );
    expect(waiting.runId).toBeNull();
    await expect(
      readQueuedChatThreadFixture(first.threadId),
    ).resolves.toMatchObject({
      orgId: scenario.orgId,
      claimId: null,
      claimExpiresAt: null,
    });

    await cancelRun(scenario, blocker.runId);

    const launchedRunId = await waitForPromptRun(
      first.threadId,
      "waits for a slot",
    );
    await expect(
      readQueuedChatThreadFixture(first.threadId),
    ).resolves.toBeNull();
    await cancelRun(scenario, launchedRunId);
  });

  it("launches an automation event appended before a user message first (strict FIFO)", async () => {
    const scenario = await setup();
    const automation = await createWebhookAutomation(scenario);
    await postWorkflowWebhook(automation, "first");
    await expect
      .poll(() => {
        return workflowRunIds(automation.threadId);
      })
      .toHaveLength(1);
    const [firstRunId] = await workflowRunIds(automation.threadId);
    if (!firstRunId) {
      throw new Error("Expected the first automation run");
    }
    await expect(
      postWorkflowWebhook(automation, "second"),
    ).resolves.toStrictEqual({ success: true, duplicate: false });
    const queued = await sendPrompt(
      scenario,
      "user after automation",
      automation.threadId,
    );
    expect(queued.runId).toBeNull();

    await completeRunThroughSandbox(scenario, firstRunId);

    const afterFirst = await workflowRunIds(automation.threadId);
    expect(afterFirst).toHaveLength(2);
    await expect(
      promptRunId(automation.threadId, "user after automation"),
    ).resolves.toBeNull();

    const secondRunId = afterFirst[1];
    if (!secondRunId) {
      throw new Error("Expected the queued automation event to launch");
    }
    // Ending the automation run (a cancel avoids resuming session history in
    // the runner claim) hands the thread slot to the next head.
    await cancelRun(scenario, secondRunId);

    const userRunId = await waitForPromptRun(
      automation.threadId,
      "user after automation",
    );
    expect([firstRunId, secondRunId]).not.toContain(userRunId);
    await cancelRun(scenario, userRunId);
  });

  it("launches pending input without a queue row through the run-end takeover", async () => {
    const scenario = await setup();
    const first = await sendRunningPrompt(scenario, "first prompt");
    const waiting = await sendPrompt(
      scenario,
      "appended by an older instance",
      first.threadId,
    );
    expect(waiting.runId).toBeNull();
    // An older API instance appends input without a queue row.
    await removeQueuedChatThreadFixture(first.threadId);
    await expect(
      readQueuedChatThreadFixture(first.threadId),
    ).resolves.toBeNull();

    await completeRunThroughSandbox(scenario, first.runId);

    const takeoverRunId = await waitForPromptRun(
      first.threadId,
      "appended by an older instance",
    );
    expect(takeoverRunId).not.toBe(first.runId);
    await cancelRun(scenario, takeoverRunId);
  });

  it("keeps the queue row when a picker that read an empty head deletes it after new input", async () => {
    const scenario = await setup();
    const first = await sendRunningPrompt(scenario, "first prompt");
    await completeRunThroughSandbox(scenario, first.runId);
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const blocker = await sendRunningPrompt(scenario, "hold org capacity");

    const { staleClaimId } = await pickEmptyHeadAcrossEnqueueFixture({
      chatThreadId: first.threadId,
      orgId: scenario.orgId,
      enqueue: async () => {
        const sent = await sendPrompt(
          scenario,
          "sent during the pick",
          first.threadId,
        );
        // The enqueuer's own pick finds the organization full.
        expect(sent.runId).toBeNull();
        await flushWaitUntilForTest();
      },
    });

    const row = await readQueuedChatThreadFixture(first.threadId);
    expect(row).toMatchObject({
      orgId: scenario.orgId,
      claimId: null,
      claimExpiresAt: null,
    });
    expect(row?.claimId).not.toBe(staleClaimId);

    await cancelRun(scenario, blocker.runId);

    const launchedRunId = await waitForPromptRun(
      first.threadId,
      "sent during the pick",
    );
    await expect(
      readQueuedChatThreadFixture(first.threadId),
    ).resolves.toBeNull();
    await cancelRun(scenario, launchedRunId);
  });
});
