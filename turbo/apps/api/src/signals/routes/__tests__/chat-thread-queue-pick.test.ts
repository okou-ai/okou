import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { insertCatalogModelFixture } from "../../../test-fixtures/model-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventAutomationPart } from "./helpers/chat-event";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { postConcurrencyEntitlementsInvoicePaid } from "./helpers/stripe-billing-webhook";

/**
 * CHAT-02: at organization capacity, chat input waits in its thread without a
 * run. A pick launches the thread's FIFO head when a slot frees (the
 * organization's waiting threads oldest first, with no priority for the ending
 * run's thread) or after a concurrency entitlement changes.
 */
const context = testContext({ connectorCatalog: true });
const {
  api,
  bdd,
  chat,
  routeMocks,
  entitledNativeChatActor,
  sendChatRun,
  sendWaitingChatInput,
  claimChatRun,
  completeChatRunOk,
  failChatRun,
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

/** A production Stripe webhook triggers the same organization pick as cron. */
async function refreshConcurrencyEntitlement(
  actor: ApiTestUser,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  await postConcurrencyEntitlementsInvoicePaid(context.signal, {
    orgId: actor.orgId,
    userId: actor.userId,
    customerId: `cus_${randomUUID()}`,
    subscriptionId: `sub_${randomUUID()}`,
    lines: [
      {
        slots: 1,
        startsAt: new Date(now()),
        expiresAt: new Date(now() + 86_400_000),
      },
    ],
  });
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

  it("gives the freed slot to another thread that waited longer than the ending run's thread", async () => {
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

    // The organization pick goes oldest first: the other thread's input
    // launches and fills the organization, so the ending run's own thread
    // keeps waiting.
    const older = await olderThread.launchedRun();
    await expect(
      runOfInput(actor, running.threadId, sameThread.clientEventId),
    ).resolves.toBeUndefined();

    // The other thread's run end frees the slot for the ending run's thread.
    await finishRun(runnerGroup, older.runId);
    const takeover = await sameThread.launchedRun();
    expect(takeover.runId).not.toBe(running.runId);
    await cancelChatRun(actor, takeover.runId);
  }, 90_000);

  it("gives the slot of a cancelled running run to a waiting thread", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const running = await sendChatRun(actor, {
      agentId,
      prompt: "thread A holds the only slot",
    });
    const runningClaim = await claimChatRun(runnerGroup, running.runId);
    await waitForRunStatus(actor, running.runId, "running");

    const waiting = await sendWaiting(actor, agentId, "thread B waits");

    // Cancel side effects finish before the Runner stops: the started run
    // still holds its slot, so they cannot launch the waiting thread yet.
    await api.requestCancelRun(actor, running.runId, [200]);
    await waitForRunStatus(actor, running.runId, "cancelled");
    await flushWaitUntilForTest();
    await expect(
      runOfInput(actor, waiting.threadId, waiting.clientEventId),
    ).resolves.toBeUndefined();

    // The Runner's end report releases the slot to the waiting thread.
    await failChatRun(
      running.runId,
      runningClaim.sandboxHeaders,
      "Run cancelled",
    );
    await flushWaitUntilForTest();

    const picked = await waiting.launchedRun();
    await cancelChatRun(actor, picked.runId);
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

    await flushWaitUntilForTest();
    await expect(
      (() => {
        return automationRunIds(actor, automation.threadId);
      })(),
    ).resolves.toHaveLength(1);
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

  it("leaves a queued automation event for the pick while steering later prompts", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor(
      {},
      "team",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const automation = await createWebhookAutomation(actor, agentId);
    const running = await sendChatRun(actor, {
      agentId,
      threadId: automation.threadId,
      prompt: "the automation thread's running run",
    });
    const runningClaim = await claimChatRun(runnerGroup, running.runId);
    await waitForRunStatus(actor, running.runId, "running");

    await postWorkflowWebhook(automation, "automation while the run runs");
    const pending = await chat.listThreadEvents(actor, automation.threadId);
    expect(
      pending.events.filter((event) => {
        return event.eventType === "input.automation" && !event.runId;
      }),
    ).toHaveLength(1);
    const promptEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: automation.threadId,
        prompt: "steer past the automation",
        clientEventId: promptEventId,
      },
      [201],
    );

    await expect(
      api.nextSteerableInput(runningClaim.claim.sandboxToken, running.runId),
    ).resolves.toStrictEqual({
      input: { eventId: promptEventId, prompt: "steer past the automation" },
    });
    await cancelChatRun(actor, running.runId);
  }, 90_000);

  it("keeps a waiting thread pickable after a concurrency update finds the organization full", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const older = await sendWaiting(actor, agentId, "oldest waiting thread");
    const waiting = await sendWaiting(
      actor,
      agentId,
      "waits after the concurrency update",
    );

    await refreshConcurrencyEntitlement(actor);
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
    const launched = await waiting.launchedRun();
    await cancelChatRun(actor, launched.runId);
  }, 90_000);

  it("keeps the queued model, service tier, and effort after thread and user settings change", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup, providerId } =
      await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId: openaiProviderId } = await api.createOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "queued-model-selection-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-6-astra",
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: openaiProviderId,
      },
    ]);
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const waiting = await sendWaitingChatInput(actor, {
      agentId,
      prompt: "retain the model selection from enqueue",
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast", reasoningEffort: "low" },
    });
    await chat.updateThreadModelSelection(
      actor,
      waiting.threadId,
      "gpt-6-astra",
      {
        codexServiceTier: null,
        reasoningEffort: "ultra",
      },
    );
    await chat.updateThreadModelSelection(
      actor,
      waiting.threadId,
      "claude-fable-5-1",
    );
    await chat.updateUserModelPreference(actor, "claude-fable-5-1");

    await finishRun(runnerGroup, blocker.runId);
    const launched = await waiting.launchedRun();
    const claimed = await claimChatRun(runnerGroup, launched.runId);
    expect(claimed.claim.modelUsageProvider).toBe("gpt-6-astra");
    expect(claimed.claim.platformEnvironment).toMatchObject({
      OKOU_CODEX_SERVICE_TIER: "fast",
      OKOU_REASONING_EFFORT: "low",
    });
    await expect(
      chat.readThreadMetadata(actor, waiting.threadId),
    ).resolves.toMatchObject({
      selectedModel: "claude-fable-5-1",
      serviceTier: null,
      modelSettings: { "gpt-6-astra": { effort: "ultra" } },
    });
    await cancelChatRun(actor, launched.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("rejects one input per thread and continues picking the organization's next thread", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup, providerId } =
      await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const nativePolicy = {
      model: "claude-fable-5-1",
      preferred: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    } as const;
    await api.updateOrgModelPolicies(actor, [
      nativePolicy,
      { ...nativePolicy, model: "claude-opus-5", preferred: false },
    ]);
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const clientEventId = randomUUID();
    const unavailable = await sendWaitingChatInput(actor, {
      agentId,
      prompt: "uses a model removed before admission",
      clientEventId,
      model: "claude-opus-5",
    });
    await chat.updateUserModelPreference(actor, "claude-fable-5-1");
    const successorEventId = randomUUID();
    const successor = await sendWaitingChatInput(actor, {
      agentId,
      threadId: unavailable.threadId,
      prompt: "wait for the next pass after the rejected head",
      clientEventId: successorEventId,
      model: "claude-fable-5-1",
    });
    const later = await sendWaiting(actor, agentId, "uses the remaining model");
    await api.updateOrgModelPolicies(actor, [nativePolicy]);

    await finishRun(runnerGroup, blocker.runId);

    const rejected = await chat.listThreadEvents(actor, unavailable.threadId);
    expect(rejected.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
        error: "bad_request",
      }),
    );
    expect(rejected.events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        error: "bad_request",
      }),
    );
    await expect(
      threadRunIds(actor, unavailable.threadId),
    ).resolves.toStrictEqual([]);
    // A null result from rejection advances the organization pass to another
    // thread. This pass does not consume the rejected head's successor.
    await expect(
      runOfInput(actor, successor.threadId, successorEventId),
    ).resolves.toBeUndefined();
    const picked = await later.launchedRun();
    await finishRun(runnerGroup, picked.runId);
    const successorRun = await successor.launchedRun();
    await cancelChatRun(actor, successorRun.runId);
  }, 90_000);

  it("rejects a queued input whose recorded model is not in the catalog at its pick", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const { actor, agentId, runnerGroup, providerId } =
      await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const model = `queued-retired-${randomUUID()}`;
    const restore = await insertCatalogModelFixture({
      model,
      displayName: "Queued model retired before pick",
      sortOrder: 100_000,
      builtInRoutes: [
        {
          concreteProviderType: "openai-api-key",
          upstreamModel: `queued-retired-upstream-${randomUUID()}`,
          priority: 0,
          efforts: [],
          defaultEffort: null,
        },
      ],
    });
    onTestFinished(restore);
    await seedBuiltInModelCandidateKeys(context, model);
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the only organization slot",
    });
    const clientEventId = randomUUID();
    const waiting = {
      ...(await sendWaitingChatInput(actor, {
        agentId,
        prompt: "retired model input",
        clientEventId,
        model,
      })),
      clientEventId,
    };
    // The real input records a model that existed at enqueue. Removing only
    // its owned catalog entry leaves that recorded model unknown at the pick.
    await restore();

    await finishRun(runnerGroup, blocker.runId);

    const events = await chat.listThreadEvents(actor, waiting.threadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: waiting.clientEventId,
        error: "bad_request",
      }),
    );
    await expect(threadRunIds(actor, waiting.threadId)).resolves.toStrictEqual(
      [],
    );
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
    expect(recall.status === 201 ? recall.body.runId : undefined).toBeNull();

    await finishRun(runnerGroup, blocker.runId);
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
