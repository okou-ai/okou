import {
  setHistoricalGoalStatusFixture,
  historicalGoalStatusFixture,
  readGoalQueueStateFixture,
  seedGoalForRunFixture,
  setLegacyGoalRunOriginFixture,
} from "../../../test-fixtures/goal-queue";

import { HttpResponse } from "msw";
import {
  resolveChatEventRecommendedFollowups,
  type ChatEvent,
  type GenerationTemplateRequest,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE } from "@okouai/api-contracts/contracts/errors";
import type { SupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "@okouai/core";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { WebPushError } from "web-push";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { withBuiltInModelRuntimeRouteUnavailableForTest } from "../../../test-fixtures/built-in-model-runtime-route";
import {
  holdChatEventInsertTransactionFixture,
  holdRunOutputMaterializationRowFixture,
  insertQueuedSlackMissingContextFixture,
  removeAcknowledgedCancellationLifecycleFixture,
  removeChatCallbackPublicBrandFixture,
} from "../../../test-fixtures/chat-events";

import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedBuiltInModelKey } from "./helpers/runtime-state";

/**
 * CHAT-02 / HOOK-01: signed chat run callbacks through real dispatch.
 *
 * Terminal callbacks in this file originate from the real internal dispatcher
 * (sandbox complete/cancel webhooks and the sandbox heartbeat route), so normal
 * app-internal dispatch does not depend on an HTTP self-call.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const misc = createMiscRoutesApi(context);

const USER_ARTIFACTS_BUCKET = "test-user-artifacts";
type UserMessage = Extract<
  ChatEvent,
  {
    eventType:
      | "input.prompt"
      | "input.automation"
      | "input.rejected"
      | "control.interrupt"
      | "control.revoke";
  }
>;
type AssistantMessage = Exclude<ChatEvent, UserMessage>;
type PromptMessage = Extract<ChatEvent, { eventType: "input.prompt" }>;
type OutputMessage = Extract<ChatEvent, { eventType: "output.message" }>;
type LifecycleEvent = "completed" | "failed" | "cancelled";
type LifecycleChatEvent<Event extends LifecycleEvent> = Extract<
  ChatEvent,
  { eventType: `run.${Event}` }
>;
type FollowupsEvent = Extract<ChatEvent, { eventType: "output.followups" }>;
type TestOrgRole = "admin" | "member";

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
  readonly storage: {
    addObject(object: {
      readonly bucket: string;
      readonly key: string;
      readonly size: number;
    }): void;
  };
}

async function entitledChatActor(): Promise<EntitledChatActor> {
  const actor = bdd.user();
  const storage = chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD chat callback agent",
    description: "Exercises chat callback terminal processing.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, providerId, storage };
}

async function entitledChatMemberActor(): Promise<EntitledChatActor> {
  const adminFixture = await entitledChatActor();
  if (!adminFixture.actor.orgId) {
    throw new Error("Expected the admin fixture to be org-scoped");
  }
  const actor = bdd.user({
    orgId: adminFixture.actor.orgId,
    orgRole: "org:member",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD member chat callback agent",
    description: "Exercises member-owned chat callback terminal processing.",
    visibility: "private",
  });
  return { ...adminFixture, actor, agentId: agent.agentId };
}

async function configureClaudeCodeSubscriptionProvider(
  fixture: EntitledChatActor,
): Promise<void> {
  await misc.upsertPersonalModelProvider(
    fixture.actor,
    { type: "claude-code-oauth-token", secret: "sk-ant-oat-bdd" },
    [200, 201],
  );
  await api.updateOrgModelPolicies(fixture.actor, [
    {
      model: "claude-sonnet-5",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: fixture.providerId,
    },
    {
      model: "claude-opus-4-8",
      isDefault: false,
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
    },
  ]);
}

async function startChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly clientEventId?: string;
    readonly threadId?: string;
    readonly selectedModel?: SupportedRunModel;
    readonly userMessage?: UserMessageInputDocument;
    readonly revokesEventId?: string;
  },
  options?: {
    readonly onMessageAccepted?: () => void;
  },
): Promise<{
  readonly runId: string;
  readonly threadId: string;
  readonly messageId: string;
}> {
  const messageId = body.clientEventId ?? randomUUID();
  const selectedModel: SupportedRunModel | undefined =
    body.selectedModel ??
    (body.threadId === undefined ? "claude-sonnet-5" : undefined);
  const requestBody = {
    agentId: body.agentId,
    prompt: body.prompt,
    clientEventId: messageId,
    ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
    ...(body.userMessage === undefined
      ? {}
      : { userMessage: body.userMessage }),
    ...(body.revokesEventId === undefined
      ? {}
      : { revokesEventId: body.revokesEventId }),
    ...(selectedModel === undefined ? {} : { model: selectedModel }),
  };
  const sent = await chat.requestSendEvent(actor, requestBody, [201]);
  if (sent.status !== 201) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  // Concurrency tests may need to release competing work after the queue-first
  // message commits but before this helper waits for its run replacement.
  options?.onMessageAccepted?.();
  let runId: string | null | undefined = sent.body.runId;
  if (runId === null) {
    // A terminal callback may claim the queued row between enqueue and the
    // inline dispatch decision. Recover as a refreshed client does: read the
    // appended replacement instead of retrying the client message id.
    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === messageId && message.runId !== undefined
          );
        });
      },
    );
    runId = userMessages(messages.events).find((message) => {
      return message.revokesEventId === messageId;
    })?.runId;
  }
  if (runId === undefined || runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return {
    runId,
    threadId: sent.body.threadId,
    messageId,
  };
}

async function queueChatEvent(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly userMessage?: UserMessageInputDocument;
  },
): Promise<string> {
  const messageId = randomUUID();
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: body.agentId,
      threadId: body.threadId,
      prompt: body.prompt,
      clientEventId: messageId,
      ...(body.userMessage === undefined
        ? {}
        : { userMessage: body.userMessage }),
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId !== null) {
    throw new Error("Expected the chat send to queue while a run is active");
  }
  return messageId;
}

async function enableGoalWorkflows(actor: ApiTestUser): Promise<void> {
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
}

async function createGoalForRun(
  _actor: ApiTestUser,
  runId: string,
  objective: string,
): Promise<void> {
  await seedGoalForRunFixture(runId, objective);
}

async function claimChatRunJob(runnerGroup: string, runId: string) {
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
  return claim.body;
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{ readonly authorization: string }> {
  const claim = await claimChatRunJob(runnerGroup, runId);
  return { authorization: `Bearer ${claim.sandboxToken}` };
}

function cliAgentSessionIdForChatRun(runId: string): string {
  return `bdd-cli-${runId}`;
}

async function waitForThreadMessages(
  actor: ApiTestUser,
  threadId: string,
  predicate: (messages: readonly ChatEvent[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadEvents>> | undefined;
  await expect
    .poll(
      async () => {
        page = await chat.listThreadEvents(actor, threadId);
        return predicate(page.events);
      },
      { interval: 100, timeout: 10_000 },
    )
    .toBe(true);
  if (!page) {
    throw new Error(`Expected chat thread ${threadId} messages to be readable`);
  }
  return page;
}

async function waitForThreadTitle(
  actor: ApiTestUser,
  threadId: string,
  title: string | null,
): Promise<void> {
  await expect
    .poll(async () => {
      return await readThreadTitleFromEvents(actor, threadId);
    })
    .toBe(title);
}

async function readThreadTitleFromEvents(
  actor: ApiTestUser,
  threadId: string,
): Promise<string | null> {
  const events = await chat.requestThreadEvents(actor, {}, [200]);
  if (events.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }

  let latestTitleEvent:
    | { readonly title: string | null; readonly createdAt: string }
    | undefined;
  for (const event of events.body.events) {
    if (
      event.chatThreadId !== threadId ||
      (event.kind !== "created" && event.kind !== "renamed")
    ) {
      continue;
    }
    if (
      latestTitleEvent === undefined ||
      Date.parse(event.createdAt) >= Date.parse(latestTitleEvent.createdAt)
    ) {
      latestTitleEvent = event;
    }
  }

  return latestTitleEvent?.title ?? null;
}

async function waitForRunStatus(
  actor: ApiTestUser,
  runId: string,
  status:
    | "cancelled"
    | "completed"
    | "failed"
    | "pending"
    | "queued"
    | "running",
): Promise<void> {
  await expect
    .poll(async () => {
      const run = await api.readRun(actor, runId);
      return run.status;
    })
    .toBe(status);
}

async function waitForQueuedEventReplacement(
  actor: ApiTestUser,
  threadId: string,
  queuedEventId: string,
): Promise<string> {
  const page = await waitForThreadMessages(actor, threadId, (events) => {
    return userMessages(events).some((event) => {
      return (
        event.revokesEventId === queuedEventId && event.runId !== undefined
      );
    });
  });
  const replacements = userMessages(page.events).filter((event) => {
    return event.revokesEventId === queuedEventId && event.runId !== undefined;
  });
  expect(replacements).toHaveLength(1);
  const runId = replacements[0]?.runId;
  if (runId === undefined) {
    throw new Error("Expected the queued event to have one replacement run");
  }
  return runId;
}

async function expectCancellationRecoveryPending(
  actor: ApiTestUser,
  threadId: string,
  expected: boolean,
): Promise<void> {
  await expect
    .poll(async () => {
      const detail = await chat.readThread(actor, threadId);
      return detail.cancellationRecoveryPending;
    })
    .toBe(expected);
}

function cancellationRecoveryCleanupClient() {
  return setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
    testCronCleanupSandboxesStateContract,
  );
}

async function reconcileCancellationRecoveryFixtures(
  chatThreadId: string,
  ...additionalChatThreadIds: string[]
): Promise<void> {
  await accept(
    cancellationRecoveryCleanupClient().cleanup({
      body: {
        chatThreadIds: [chatThreadId, ...additionalChatThreadIds],
        runIds: [],
        orgIds: [],
        exportJobIds: [],
      },
    }),
    [200],
  );
}

async function waitForRunContext(actor: ApiTestUser, runId: string) {
  let response: Awaited<ReturnType<typeof api.requestRunContext>> | undefined;
  await expect
    .poll(async () => {
      response = await api.requestRunContext(actor, runId, [200, 404]);
      return response.status;
    })
    .toBe(200);
  if (!response || response.status !== 200) {
    throw new Error("Expected the auto-send run context to be readable");
  }
  return response;
}

async function goalQueueEventIds(threadId: string): Promise<readonly string[]> {
  return (await readGoalQueueStateFixture(threadId)).eventIds;
}

async function goalRunIds(threadId: string): Promise<readonly string[]> {
  return (await readGoalQueueStateFixture(threadId)).runIds;
}

function chatRunCheckpoint(runId: string): {
  readonly cliAgentType: "claude-code";
  readonly cliAgentSessionId: string;
  readonly cliAgentSessionHistoryHash: string;
} {
  const historyHash = createHash("sha256")
    .update(`bdd chat session history ${runId}`)
    .digest("hex");
  return {
    cliAgentType: "claude-code",
    cliAgentSessionId: cliAgentSessionIdForChatRun(runId),
    cliAgentSessionHistoryHash: historyHash,
  };
}

/**
 * Atomically checkpoint + exitCode-0 complete. Completing without a checkpoint
 * routes to the missing-checkpoint handler and FAILS the run.
 */
async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  options: { readonly lastEventSequence?: number } = {},
): Promise<void> {
  const stagedOutputEvents = chatCallbacks.consumeMockChatOutputEvents();
  const { lastEventSequence } = options;
  const acknowledgedOutputEvents =
    lastEventSequence === undefined
      ? stagedOutputEvents
      : stagedOutputEvents.filter((event) => {
          return event.sequenceNumber <= lastEventSequence;
        });
  if (acknowledgedOutputEvents.length > 0) {
    await webhooks.requestAgentEvents(
      { runId, events: acknowledgedOutputEvents },
      sandboxHeaders,
      [200],
    );
  }
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: chatRunCheckpoint(runId),
      ...(lastEventSequence === undefined ? {} : { lastEventSequence }),
    },
    sandboxHeaders,
    [200],
  );
}

async function failChatRun(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  error: string,
  failureReason?: RunFailureReasonToken,
): Promise<void> {
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 1,
      error,
      ...(failureReason === undefined ? {} : { failureReason }),
    },
    sandboxHeaders,
    [200],
  );
}

function assistantMessages(messages: readonly ChatEvent[]): AssistantMessage[] {
  return messages.filter((message): message is AssistantMessage => {
    return !isUserMessage(message);
  });
}

function userMessages(messages: readonly ChatEvent[]): UserMessage[] {
  return messages.filter(isUserMessage);
}

function isUserMessage(message: ChatEvent): message is UserMessage {
  switch (message.eventType) {
    case "input.prompt":
    case "input.automation":
    case "input.rejected":
    case "control.interrupt":
    case "control.revoke": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function eventBackedContents(
  messages: readonly ChatEvent[],
  runId: string,
): OutputMessage[] {
  return messages.filter((message): message is OutputMessage => {
    return message.eventType === "output.message" && message.runId === runId;
  });
}

function lifecycleMarkers<Event extends LifecycleEvent>(
  messages: readonly ChatEvent[],
  runId: string,
  event: Event,
): LifecycleChatEvent<Event>[] {
  return messages.filter((message): message is LifecycleChatEvent<Event> => {
    return message.runId === runId && message.eventType === `run.${event}`;
  });
}

function recommendedFollowupEvents(
  messages: readonly ChatEvent[],
  runId: string,
): FollowupsEvent[] {
  return messages.filter((message): message is FollowupsEvent => {
    return (
      message.eventType === "output.followups" &&
      message.runId === runId &&
      resolveChatEventRecommendedFollowups(message).length > 0
    );
  });
}

async function waitForChatThreadMessageCreatedPublish(
  threadId: string,
): Promise<void> {
  await expect
    .poll(() => {
      return context.mocks.ably.publish.mock.calls.some((call) => {
        return call[0] === `chatThreadMessageCreated:${threadId}`;
      });
    })
    .toBe(true);
}

function assistantEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    eventType: "assistant",
    sequenceNumber,
    eventData: { message: { content: [{ type: "text", text }] } },
  };
}

function resultEvent(
  sequenceNumber: number,
  result: string,
): Record<string, unknown> {
  return { eventType: "result", sequenceNumber, eventData: { result } };
}

function chatOutputAxiomQueryCalls(): readonly unknown[][] {
  return context.mocks.axiom.query.mock.calls.filter((call) => {
    const apl = call[0];
    return (
      typeof apl === "string" &&
      apl.includes("['agent-run-events']") &&
      apl.includes('eventType == "assistant"')
    );
  });
}

function pushPayload(call: readonly unknown[] | undefined): unknown {
  const raw = call?.[1];
  return JSON.parse(typeof raw === "string" ? raw : "{}");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferredGate(): {
  readonly wait: () => Promise<void>;
  readonly release: () => void;
} {
  const gate = createDeferredPromise<void>(context.signal);
  const releaseGate = (): void => {
    if (!gate.settled()) {
      gate.resolve(undefined);
    }
  };
  onTestFinished(() => {
    releaseGate();
  });
  return {
    wait: () => {
      return gate.promise;
    },
    release: releaseGate,
  };
}

describe("CHAT-02: completed chat callback", () => {
  it("persists assistant output, reorders threads, titles the thread, recommends follow-ups, notifies, and auto-sends the queued template message", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const titlePrompts: string[] = [];
    const followupSystemPrompts: string[] = [];
    const followupPrompts: string[] = [];
    const longFollowupPrompt =
      "Can you draft a new 90-minute workshop outline that focuses on the event-driven workflow of an AI Lead Operations Team and includes hands-on exercises?";
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Debugging Node Apps";
      }
      if (
        systemContent.includes(
          "You generate recommended follow-up messages for a chat.",
        )
      ) {
        followupSystemPrompts.push(systemContent);
        followupPrompts.push(body.messages[1]?.content ?? "");
        return JSON.stringify([
          { prompt: longFollowupPrompt, kind: "talk" },
          {
            prompt: "Generate a landing page for this plan",
            kind: "generate",
            generationType: "website",
          },
        ]);
      }
      return "Generated summary";
    });

    const prompt = "How do I debug my Node app?";
    const first = await startChatRun(actor, {
      agentId,
      prompt,
      selectedModel: "claude-sonnet-5",
    });

    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "presentation",
      selection: {
        templateId: template.templateId,
      },
    };
    const queuedUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: template.title,
          template: generationTemplate,
        },
        { type: "text", text: "queued next turn" },
      ],
    };
    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued next turn",
      userMessage: queuedUserMessage,
    });
    const beforeComplete = await chat.listThreadEvents(actor, first.threadId);
    const queued = userMessages(beforeComplete.events).find((message) => {
      return chatEventDisplayText(message) === "queued next turn";
    });
    if (!queued) {
      throw new Error("Expected the queued user message to be listed");
    }
    // Sentinel thread with a later lastMessageAt than thread X, so the
    // run-end bump on X is observable through thread-list reordering.
    const sentinel = await startChatRun(actor, {
      agentId,
      prompt: "unrelated sentinel run",
    });
    await api.requestCancelRun(actor, sentinel.runId, [200]);
    await waitForRunStatus(actor, sentinel.runId, "cancelled");
    await waitForThreadTitle(actor, first.threadId, "Debugging Node Apps");
    const titlePromptCountBeforeComplete = titlePrompts.length;

    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    context.mocks.ably.publish.mockClear();
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "final answer")]);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    const after = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return (
          eventBackedContents(messages, first.runId).length === 1 &&
          recommendedFollowupEvents(messages, first.runId).some((message) => {
            return resolveChatEventRecommendedFollowups(message).length === 2;
          })
        );
      },
    );
    expect(
      eventBackedContents(after.events, first.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["final answer"]);
    expect(
      eventBackedContents(after.events, first.runId)[0],
    ).not.toHaveProperty("status");

    const marker = lifecycleMarkers(after.events, first.runId, "completed")[0];
    if (!marker) {
      throw new Error("Expected a completed lifecycle marker");
    }
    expect(marker.content).toBeNull();
    expect(marker).not.toHaveProperty("status");
    expect(marker).not.toHaveProperty("recommendedFollowups");
    const recommender = recommendedFollowupEvents(after.events, first.runId)[0];
    if (!recommender) {
      throw new Error("Expected a recommended follow-up message");
    }
    expect(resolveChatEventRecommendedFollowups(recommender)).toStrictEqual([
      { prompt: longFollowupPrompt, kind: "talk" },
      {
        prompt: "Generate a landing page for this plan",
        kind: "generate",
        generationType: "website",
      },
    ]);
    expect(followupPrompts).toHaveLength(1);
    expect(followupPrompts[0]).toContain("final answer");
    expect(followupPrompts[0]).not.toContain("queued next turn");
    expect(followupSystemPrompts).toStrictEqual([
      expect.stringContaining(
        "The prompt values are displayed as plain text, not rendered as Markdown",
      ),
    ]);
    expect(followupSystemPrompts[0]).toContain(
      "Supported generation types are:",
    );

    await waitForThreadTitle(actor, first.threadId, "Debugging Node Apps");
    expect(titlePrompts).toHaveLength(titlePromptCountBeforeComplete);
    const initialTitlePrompt = titlePrompts.find((titlePrompt) => {
      return titlePrompt.includes(`Most recent user message:\n${prompt}`);
    });
    if (initialTitlePrompt === undefined) {
      throw new Error("Expected the initial send to request a thread title");
    }
    expect(initialTitlePrompt).not.toContain(
      "Most recent assistant reply:\nfinal answer",
    );

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    const relevantEvents = threadEvents.body.events.filter((event) => {
      return (
        event.chatThreadId === first.threadId ||
        event.chatThreadId === sentinel.threadId
      );
    });
    expect(relevantEvents.at(-1)).toMatchObject({
      kind: "sort_touched",
      chatThreadId: first.threadId,
    });

    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.some(
          (call) => {
            const payload = pushPayload(call) as Record<string, unknown>;
            return (
              payload.title === prompt.slice(0, 60) &&
              payload.body === "Generated summary" &&
              payload.url === `http://localhost:3002/chats/${first.threadId}`
            );
          },
        );
      })
      .toBe(true);
    const afterAutoSend = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            chatEventDisplayText(message) === "queued next turn" &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(afterAutoSend.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          chatEventDisplayText(message) === "queued next turn" &&
          message.runId !== undefined
        );
      },
    );
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to be auto-claimed");
    }
    expect(claimed.runId).not.toBe(first.runId);
    expect(claimed.id).not.toBe(queued.id);
    expect(claimed.revokesEventId).toBe(queued.id);
    expect(claimed.userMessage?.parts).toContainEqual(
      expect.objectContaining({
        type: "template",
        template: generationTemplate,
      }),
    );
    const original = userMessages(afterAutoSend.events).find((message) => {
      return message.id === queued.id;
    });
    expect(original).toBeDefined();
    expect(original?.runId).toBeUndefined();
    // The raw message page contains both immutable rows; the client folds the
    // original into its run-associated replacement.
    const matchingMessageIds = userMessages(afterAutoSend.events)
      .filter((message) => {
        return chatEventDisplayText(message) === "queued next turn";
      })
      .map((message) => {
        return message.id;
      });
    expect(matchingMessageIds).toHaveLength(2);
    expect(matchingMessageIds).toStrictEqual(
      expect.arrayContaining([queued.id, claimed.id]),
    );
    // The auto-send publishes happen in background callback processing, so
    // poll until the message channel has been published before asserting.
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${first.threadId}`;
        });
      })
      .toBe(true);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${first.threadId}`,
      null,
    );
    const autoContext = await waitForRunContext(actor, claimed.runId);
    expect(autoContext.body.prompt).toBe(
      `[Template #1: ${template.title} (presentation)]queued next turn`,
    );
    const appended = autoContext.body.appendSystemPrompt ?? "";
    expect(appended).toContain(
      "# Current Integration\nYou are currently running inside: Web",
    );
    expect(appended).toContain("# Inline Templates");
    expect(appended).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(appended).not.toContain("Selected design system");
    // Runbook flow, not the retired multi-resource flow.
    expect(appended).toContain(
      `okou resource pull ${template.templateId}-runbook --dir ./generated/resources`,
    );
    expect(appended).toContain("--artifact-kind presentation-html");
    expect(appended).not.toContain(
      "okou generate presentation --design-system",
    );
    expect(Object.keys(autoContext.body.environment)).toContain(
      "ANTHROPIC_API_KEY",
    );

    await claimChatRunJob(runnerGroup, claimed.runId);
    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("starts the queued chat run's API clock at its dequeue", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "hold the thread while the next message queues",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    const queuedAt = now() + 60_000;
    const dequeuedAt = queuedAt + 1000;
    const queuedPrompt = "measure from queued message dequeue";
    mockNow(queuedAt);
    onTestFinished(() => {
      clearMockNow();
    });

    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: queuedPrompt,
    });

    mockNow(dequeuedAt);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "finish the blocking run"),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 0,
    });

    const afterAutoSend = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            chatEventDisplayText(message) === queuedPrompt &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(afterAutoSend.events).find((message) => {
      return (
        chatEventDisplayText(message) === queuedPrompt &&
        message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued Web message to auto-send");
    }
    const secondClaim = await claimChatRunJob(runnerGroup, claimed.runId);
    expect(secondClaim.apiStartTime).toBe(dequeuedAt);

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("uses the optimized prompt and userMessage semantics for recommended follow-ups", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const firstUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        { type: "text", text: "first structured request" },
      ],
    };
    const templatePrompt = `[Template #1: ${style.title} (illustration)]`;

    const first = await startChatRun(actor, {
      agentId,
      prompt: "stale first legacy request",
      userMessage: firstUserMessage,
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "first structured answer"),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const titlePrompts: string[] = [];
    const followupSystemPrompts: string[] = [];
    const followupPrompts: string[] = [];
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Structured Context";
      }
      if (
        systemContent.includes(
          "You generate recommended follow-up messages for a chat.",
        )
      ) {
        followupSystemPrompts.push(systemContent);
        followupPrompts.push(body.messages[1]?.content ?? "");
        return JSON.stringify([
          { prompt: "Continue the structured work", kind: "talk" },
        ]);
      }
      return "Generated summary";
    });

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "stale second legacy request",
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "second structured request" }],
      },
    });
    await waitForThreadTitle(actor, first.threadId, "Structured Context");

    const userMessageContext = [
      templatePrompt,
      "first structured request",
      "second structured request",
    ];
    const legacyContext = [
      "stale first legacy request",
      "stale second legacy request",
    ];
    const expectedContext = userMessageContext;
    const excludedContext = legacyContext;

    expect(titlePrompts).toHaveLength(1);
    for (const value of expectedContext) {
      expect(titlePrompts[0]).toContain(value);
    }
    for (const value of excludedContext) {
      expect(titlePrompts[0]).not.toContain(value);
    }

    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "second structured answer"),
    ]);
    await completeChatRunOk(second.runId, secondHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    expect(followupSystemPrompts).toHaveLength(1);
    expect(followupSystemPrompts[0]).toContain(
      "These are quick replies, not task briefs.",
    );
    expect(followupSystemPrompts[0]).toContain(
      "Usefulness is a hard requirement and takes priority",
    );
    expect(followupSystemPrompts[0]).toContain(
      "asks the assistant to take a concrete next action",
    );
    expect(followupSystemPrompts[0]).toContain(
      "makes or requests a decision, selection, constraint, or adjustment",
    );
    expect(followupSystemPrompts[0]).toContain(
      "asks a substantive question whose answer reduces uncertainty or changes the next step",
    );
    expect(followupSystemPrompts[0]).toContain(
      "Never output a pure acknowledgement, thanks, praise, sympathy, status reaction, or conversation closer.",
    );
    expect(followupSystemPrompts[0]).toContain('"知道了"');
    expect(followupSystemPrompts[0]).toContain(
      "silently validate every suggestion",
    );
    expect(followupSystemPrompts[0]).toContain("Never pad with social filler.");
    expect(followupSystemPrompts[0]).toContain(
      "Match the user's language and conversational tone.",
    );
    expect(followupSystemPrompts[0]).toContain(
      "Express exactly one intent in one simple clause or question.",
    );
    expect(followupSystemPrompts[0]).toContain(
      "responding to it takes priority over all other follow-up ideas.",
    );
    expect(followupSystemPrompts[0]).toContain(
      "accept or proceed; decline, stop, or defer; adjust the proposal",
    );
    expect(followupSystemPrompts[0]).toContain(
      "Do not revive an older topic merely for variety.",
    );
    expect(followupSystemPrompts[0]).toContain(
      "Always return exactly 3 suggestions.",
    );
    expect(followupSystemPrompts[0]).not.toContain("Chinese");
    expect(followupPrompts).toHaveLength(1);
    for (const value of expectedContext) {
      expect(followupPrompts[0]).toContain(value);
    }
    expect(followupPrompts[0]).toContain("second structured answer");
    for (const value of excludedContext) {
      expect(followupPrompts[0]).not.toContain(value);
    }
  }, 90_000);

  it("suppresses malformed recommended follow-up JSON instead of storing raw syntax lines", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    let followupRequests = 0;
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("recommended follow-up messages")) {
        followupRequests += 1;
        return [
          "[",
          "{",
          '"prompt": "Investigate this malformed follow-up",',
          '"kind": "talk"',
        ].join("\n");
      }
      if (systemContent.includes("Generate a short, descriptive title")) {
        return "Malformed Follow-ups";
      }
      return "Generated summary";
    });

    const run = await startChatRun(actor, {
      agentId,
      prompt: "Explain how to debug malformed follow-ups",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The final assistant answer"),
    ]);
    context.mocks.ably.publish.mockClear();
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    expect(followupRequests).toBe(1);
    const after = await chat.listThreadEvents(actor, run.threadId);
    const marker = lifecycleMarkers(after.events, run.runId, "completed")[0];
    if (!marker) {
      throw new Error("Expected a completed lifecycle marker");
    }
    expect(marker).not.toHaveProperty("recommendedFollowups");
  });

  it("silently degrades all four callback features while delivering the generic notification", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const system = body.messages[0]?.content ?? "";
      if (
        ![
          "Generate a short, descriptive title",
          "recommended follow-up messages",
          "one short notification sentence",
          "agent run in at most 50 words",
        ].some((text) => {
          return system.includes(text);
        })
      ) {
        return "Thinking";
      }
      return HttpResponse.json({
        choices: [
          {
            finish_reason: "error",
            error: { metadata: { error_type: "rate_limit_exceeded" } },
          },
        ],
      });
    });
    const run = await startChatRun(actor, {
      agentId,
      prompt: "Keep the main answer",
    });
    await flushWaitUntilForTest();
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The main answer survives"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({ content: "The main answer survives" }),
    );
    expect(
      events.events.some((event) => {
        return event.eventType === "output.followups";
      }),
    ).toBeFalsy();
    await expect(
      readThreadTitleFromEvents(actor, run.threadId),
    ).resolves.toBeNull();
    expect(
      context.mocks.webpush.sendNotification.mock.calls.map(pushPayload),
    ).toContainEqual(
      expect.objectContaining({ body: "Your task is complete" }),
    );
    // Only the four are rejected, so the optional progress copy still lands:
    // the degradations are scoped to the generations the provider refused.
    expect(
      events.events.some((event) => {
        return event.runEventId === "thinking:initial";
      }),
    ).toBeTruthy();
  });

  it.each([
    {
      name: "an empty suggestion array",
      response: () => {
        return "[]";
      },
    },
    {
      name: "generated text that is not JSON",
      response: () => {
        return "I have no useful follow-ups for this conversation.";
      },
    },
    {
      name: "generated JSON that is not an array",
      response: () => {
        return JSON.stringify({
          followups: [{ prompt: "Run the failing case again", kind: "talk" }],
        });
      },
    },
    {
      name: "an array whose every item fails validation",
      response: () => {
        return JSON.stringify([
          { prompt: "Run the failing case again", kind: "chat" },
          { text: "Try the other branch", kind: "talk" },
        ]);
      },
    },
  ])("omits recommended follow-ups for $name", async ({ response }) => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const system = body.messages[0]?.content ?? "";
      if (
        system.includes(
          "You generate recommended follow-up messages for a chat.",
        )
      ) {
        return response();
      }
      // A sibling whose interpreted output is empty in the same run proves
      // each caller absorbs its own empty result.
      if (system.includes("one short notification sentence")) {
        return "---";
      }
      return "Generated summary";
    });

    const run = await startChatRun(actor, {
      agentId,
      prompt: "Keep the main answer",
    });
    await flushWaitUntilForTest();
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The main answer survives"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({ content: "The main answer survives" }),
    );
    expect(
      events.events.some((event) => {
        return event.eventType === "output.followups";
      }),
    ).toBeFalsy();
    // The sibling whose interpreted output is empty in the same run falls
    // back to the fixed copy, so the omission is scoped to this caller.
    expect(
      context.mocks.webpush.sendNotification.mock.calls.map(pushPayload),
    ).toContainEqual(
      expect.objectContaining({ body: "Your task is complete" }),
    );
  });

  // Never part of a request an external caller makes, so anything carrying it
  // into the thread came from the provider response.
  const privateProviderDetail = "private-openrouter-credential-detail";

  it.each([
    {
      name: "rejected credentials",
      response: () => {
        return new HttpResponse(privateProviderDetail, { status: 401 });
      },
    },
    {
      // The generated text is well formed for the provider; it is the response
      // envelope around it that breaks its contract.
      name: "a response body that is not JSON",
      response: () => {
        return new HttpResponse(privateProviderDetail, {
          headers: { "content-type": "application/json" },
        });
      },
    },
    {
      // Nothing annotates this, so nothing about it is presented as a cause.
      name: "a response body that fails while streaming",
      response: () => {
        return new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  ])("omits recommended follow-ups after $name", async ({ response }) => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const system = body.messages[0]?.content ?? "";
      if (
        system.includes(
          "You generate recommended follow-up messages for a chat.",
        )
      ) {
        return response();
      }
      return "Generated summary";
    });

    const run = await startChatRun(actor, {
      agentId,
      prompt: "Keep the main answer",
    });
    await flushWaitUntilForTest();
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The main answer survives"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({ content: "The main answer survives" }),
    );
    expect(
      events.events.some((event) => {
        return event.eventType === "output.followups";
      }),
    ).toBeFalsy();
    // The run keeps its own result, and nothing the provider sent reaches
    // the thread.
    expect(JSON.stringify(events.events)).not.toContain(privateProviderDetail);
  });

  it("absorbs title and summary storage failures without losing the round", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    // PostgreSQL rejects NUL in text. This induces a real write failure using
    // a provider response, without DB mocks or changing shared schema/state.
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const system = body.messages[0]?.content ?? "";
      if (
        system.includes("Generate a short, descriptive title") ||
        system.includes("agent run in at most 50 words")
      ) {
        return "Unstorable\u0000text";
      }
      if (system.includes("recommended follow-up messages")) {
        return JSON.stringify([
          { prompt: "Continue the analysis", kind: "talk" },
        ]);
      }
      return "Task finished";
    });
    const run = await startChatRun(actor, {
      agentId,
      prompt: "Keep storage errors visible",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The main answer survives"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    // Generation succeeded for every feature; only the two unstorable writes
    // failed, and each failure is confined to its own effect.
    await expect(
      readThreadTitleFromEvents(actor, run.threadId),
    ).resolves.toBeNull();
    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({ content: "The main answer survives" }),
    );
    expect(
      events.events.some((event) => {
        return event.eventType === "output.followups";
      }),
    ).toBeTruthy();
  });

  it("keeps the completed output after a push delivery failure", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const run = await startChatRun(actor, { agentId, prompt: "Notify me" });
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions(() => {
      return new HttpResponse(null, { status: 503 });
    });
    context.mocks.webpush.sendNotification.mockRejectedValue(
      new Error("Push delivery failed"),
    );
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "Completed answer")]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    expect(
      context.mocks.webpush.sendNotification.mock.calls.map(pushPayload),
    ).toContainEqual(
      expect.objectContaining({ body: "Your task is complete" }),
    );
    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({ content: "Completed answer" }),
    );
  });

  it("pins the model, reasoning effort, and token budget of every fast-path completion", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const requestsBySite = new Map<
      string,
      { model: string; max_tokens?: number; reasoning?: { effort: string } }
    >();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      const record = {
        model: body.model,
        ...(body.max_tokens === undefined
          ? {}
          : { max_tokens: body.max_tokens }),
        ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
      };
      if (systemContent.includes("Generate a short, descriptive title")) {
        requestsBySite.set("title", record);
        return "Budget Pinning";
      }
      if (systemContent.includes("recommended follow-up messages")) {
        requestsBySite.set("followups", record);
        return JSON.stringify([{ prompt: "Keep going", kind: "talk" }]);
      }
      if (systemContent.includes("one short notification sentence")) {
        requestsBySite.set("notification", record);
        return "The task finished";
      }
      if (systemContent.includes("agent run in at most 50 words")) {
        requestsBySite.set("runSummary", record);
        return "Generated summary";
      }
      return "Generated summary";
    });

    const run = await startChatRun(actor, {
      agentId,
      prompt: "Explain how token budgets interact with reasoning",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The final assistant answer"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    // Every generation reached its caller, so the pinned request parameters
    // below describe budgets that actually produced their effects.
    await expect(readThreadTitleFromEvents(actor, run.threadId)).resolves.toBe(
      "Budget Pinning",
    );
    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(
      events.events.some((event) => {
        return event.eventType === "output.followups";
      }),
    ).toBeTruthy();

    // Reasoning tokens are drawn from the same budget as the answer, so a
    // budget sized for a non-reasoning model starves the answer entirely. This
    // model cannot disable thinking and "low" is already its floor, so the
    // shared ceiling is the only lever that keeps the answer from being lost.
    for (const site of ["title", "followups", "notification", "runSummary"]) {
      expect(requestsBySite.get(site)).toStrictEqual({
        model: "google/gemini-3.8-flash",
        max_tokens: 2048,
        reasoning: { effort: "low" },
      });
    }
  });

  it("pushes a token-limited notification summary instead of discarding it", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const truncatedSummary = "The task finished by writing the migration pl";
    let notificationRequests = 0;
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("one short notification sentence")) {
        notificationRequests += 1;
        return { content: truncatedSummary, finishReason: "length" };
      }
      if (systemContent.includes("Generate a short, descriptive title")) {
        return "Truncated Notification";
      }
      if (systemContent.includes("recommended follow-up messages")) {
        return JSON.stringify([{ prompt: "Keep going", kind: "talk" }]);
      }
      return "Generated summary";
    });

    const prompt = "Summarize the migration plan";
    const run = await startChatRun(actor, { agentId, prompt });
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();

    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The final assistant answer"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    expect(notificationRequests).toBe(1);
    // A shortened sentence still tells the user what finished, and the only
    // alternative is the generic fallback, so this caller keeps the text.
    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.some(
          (call) => {
            const payload = pushPayload(call) as Record<string, unknown>;
            return (
              payload.title === prompt.slice(0, 60) &&
              payload.body === truncatedSummary
            );
          },
        );
      })
      .toBe(true);
  });

  it("falls back to the fixed notification copy when the token-limited summary strips to nothing", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("one short notification sentence")) {
        // Non-empty for the provider, nothing once the Markdown rule is
        // stripped. Accepting truncated text made this state reachable.
        return { content: "---", finishReason: "length" };
      }
      if (systemContent.includes("Generate a short, descriptive title")) {
        return "Emptied Notification";
      }
      if (systemContent.includes("recommended follow-up messages")) {
        return JSON.stringify([{ prompt: "Keep going", kind: "talk" }]);
      }
      return "Generated summary";
    });

    const prompt = "Summarize the emptied notification";
    const run = await startChatRun(actor, { agentId, prompt });
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();

    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The final assistant answer"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.some(
          (call) => {
            const payload = pushPayload(call) as Record<string, unknown>;
            return (
              payload.title === prompt.slice(0, 60) &&
              payload.body === "Your task is complete"
            );
          },
        );
      })
      .toBe(true);
    expect(
      context.mocks.webpush.sendNotification.mock.calls.every((call) => {
        const payload = pushPayload(call) as Record<string, unknown>;
        return payload.body !== "";
      }),
    ).toBeTruthy();
  });

  it("leaves the thread untitled when the title completion is token-limited", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    let titleRequests = 0;
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        titleRequests += 1;
        return {
          content: "A Truncated Title That Must Not",
          finishReason: "length",
        };
      }
      return "Generated summary";
    });

    const run = await startChatRun(actor, {
      agentId,
      prompt: "Plan the token budget migration",
    });
    await flushWaitUntilForTest();

    expect(titleRequests).toBe(1);
    // A truncated title used to be persisted verbatim. It must now be dropped
    // so the next round can retry rather than pinning a half-written title.
    await expect(
      readThreadTitleFromEvents(actor, run.threadId),
    ).resolves.toBeNull();

    await api.requestCancelRun(actor, run.runId, [200]);
    await waitForRunStatus(actor, run.runId, "cancelled");
  });

  it("suppresses token-limited recommended follow-ups instead of storing partial JSON", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    let followupRequests = 0;
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("recommended follow-up messages")) {
        followupRequests += 1;
        return {
          content: JSON.stringify([
            { prompt: "Keep going with the migration", kind: "talk" },
          ]).slice(0, 40),
          finishReason: "length",
        };
      }
      if (systemContent.includes("Generate a short, descriptive title")) {
        return "Truncated Follow-ups";
      }
      return "Generated summary";
    });

    const run = await startChatRun(actor, {
      agentId,
      prompt: "Explain how truncated follow-ups are handled",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "The final assistant answer"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    expect(followupRequests).toBe(1);
    const after = await chat.listThreadEvents(actor, run.threadId);
    const marker = lifecycleMarkers(after.events, run.runId, "completed")[0];
    if (!marker) {
      throw new Error("Expected a completed lifecycle marker");
    }
    expect(marker).not.toHaveProperty("recommendedFollowups");
  });

  it("auto-sends the queued message before completed-run LLM side effects finish", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish the current turn",
    });
    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued while side effects wait",
    });

    const queuedBeforeComplete = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const queued = userMessages(queuedBeforeComplete.events).find((message) => {
      return chatEventDisplayText(message) === "queued while side effects wait";
    });
    if (!queued) {
      throw new Error("Expected the queued user message to be listed");
    }

    const openRouterGate = deferredGate();
    const titlePrompts: string[] = [];
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions(async (body) => {
      await openRouterGate.wait();
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("recommended follow-up messages")) {
        return JSON.stringify([
          { prompt: "Review the queued result", kind: "talk" },
        ]);
      }
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Deferred Side Effects";
      }
      return "Deferred summary";
    });

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "completed answer")]);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    const afterAutoSend = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesEventId === queued.id && message.runId !== undefined
          );
        });
      },
    );
    const markerBeforeRelease = lifecycleMarkers(
      afterAutoSend.events,
      first.runId,
      "completed",
    )[0];
    if (!markerBeforeRelease) {
      throw new Error(
        "Expected completed marker before releasing side effects",
      );
    }
    expect(markerBeforeRelease).not.toHaveProperty("recommendedFollowups");

    const claimed = userMessages(afterAutoSend.events).find((message) => {
      return message.revokesEventId === queued.id;
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to auto-send");
    }
    expect(claimed.runId).not.toBe(first.runId);

    context.mocks.ably.publish.mockClear();
    openRouterGate.release();
    const afterFollowups = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return recommendedFollowupEvents(messages, first.runId).some(
          (message) => {
            return resolveChatEventRecommendedFollowups(message).length === 1;
          },
        );
      },
    );
    expect(
      lifecycleMarkers(afterFollowups.events, first.runId, "completed"),
    ).toHaveLength(1);
    const markerAfterRelease = lifecycleMarkers(
      afterFollowups.events,
      first.runId,
      "completed",
    )[0];
    expect(markerAfterRelease?.id).toBe(markerBeforeRelease.id);
    expect(markerAfterRelease).not.toHaveProperty("recommendedFollowups");
    const followupEvent = recommendedFollowupEvents(
      afterFollowups.events,
      first.runId,
    )[0];
    if (!followupEvent) {
      throw new Error("Expected a recommended follow-up message");
    }
    expect(resolveChatEventRecommendedFollowups(followupEvent)).toStrictEqual([
      { prompt: "Review the queued result", kind: "talk" },
    ]);
    await waitForChatThreadMessageCreatedPublish(first.threadId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${first.threadId}`,
      { syncThroughSeqId: followupEvent.seqId },
    );
    // The auto-sent queued message titles the thread as soon as its run is
    // created, with the completed round supplying prior context.
    expect(titlePrompts).toHaveLength(1);
    expect(titlePrompts[0]).toContain(
      "Most recent user message:\nqueued while side effects wait",
    );
    expect(titlePrompts[0]).toContain("finish the current turn");

    await flushWaitUntilForTest();

    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued after duplicate callback",
    });
    const afterSecondQueue = await chat.listThreadEvents(actor, first.threadId);
    const duplicateProbeQueued = userMessages(afterSecondQueue.events).find(
      (message) => {
        return (
          chatEventDisplayText(message) === "queued after duplicate callback"
        );
      },
    );
    if (!duplicateProbeQueued) {
      throw new Error("Expected the duplicate probe message to queue");
    }

    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const afterDuplicateCallback = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const duplicateProbeClaimed = userMessages(
      afterDuplicateCallback.events,
    ).filter((message) => {
      return message.revokesEventId === duplicateProbeQueued.id;
    });
    expect(duplicateProbeClaimed).toHaveLength(0);
    const duplicateProbeStillQueued = userMessages(
      afterDuplicateCallback.events,
    ).find((message) => {
      return message.id === duplicateProbeQueued.id;
    });
    expect(duplicateProbeStillQueued?.runId).toBeUndefined();

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("continues a queued prompt while a historical Goal remains active", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish before queued goal interruption",
    });
    const goalBrief = "Continue after the queued prompt";
    await createGoalForRun(actor, first.runId, goalBrief);
    const queuedMessageId = await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "run before the admitted goal",
    });
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "completed before queued goal interruption"),
    ]);

    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedMessageId &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimedPrompt = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
    });
    if (!claimedPrompt?.runId) {
      throw new Error("Expected the queued prompt to win goal priority");
    }
    expect(chatEventDisplayText(claimedPrompt)).toBe(
      "run before the admitted goal",
    );
    await expect(goalRunIds(first.threadId)).resolves.toHaveLength(0);
    await expect(goalQueueEventIds(first.threadId)).resolves.toHaveLength(0);

    await api.requestCancelRun(actor, claimedPrompt.runId, [200]);
    await waitForRunStatus(actor, claimedPrompt.runId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("prepares a resumed manual run without paused Goal authority", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "pause this goal before finishing",
    });
    const goalBrief = "Keep improving the paused goal context";
    await createGoalForRun(actor, first.runId, goalBrief);
    await setHistoricalGoalStatusFixture(first.runId, "paused");

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "finished after pausing the goal"),
    ]);
    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "handle a new user request",
    });
    const runContext = await waitForRunContext(actor, second.runId);
    const appendSystemPrompt = runContext.body.appendSystemPrompt ?? "";
    expect(appendSystemPrompt).not.toContain("# Thread Goal");
    expect(appendSystemPrompt).not.toContain("okou goal");
    const claimed = await claimChatRunJob(runnerGroup, second.runId);
    expect(
      claimed.storageManifest?.storageMounts.map((mount) => {
        return mount.mountPath;
      }),
    ).not.toContain("/home/user/.claude/skills/goal");
    expect(claimed.resumeSession).not.toBeNull();

    await api.requestCancelRun(actor, second.runId, [200]);
    await waitForRunStatus(actor, second.runId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("marks an auto-sent follow-up when org concurrency queues the new run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");

    const first = await startChatRun(actor, {
      agentId,
      prompt: "finish before auto-send queues",
    });
    const blocker = await startChatRun(actor, {
      agentId,
      prompt: "hold org concurrency open",
    });
    await waitForRunStatus(actor, first.runId, "pending");
    await waitForRunStatus(actor, blocker.runId, "pending");

    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued while org cap is full",
    });
    const queuedBeforeComplete = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const queued = userMessages(queuedBeforeComplete.events).find((message) => {
      return chatEventDisplayText(message) === "queued while org cap is full";
    });
    if (!queued) {
      throw new Error("Expected the queued user message to be listed");
    }

    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const sandboxHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "anchor completed")]);
    await completeChatRunOk(first.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });

    const afterAutoSend = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        const claimed = userMessages(messages).find((message) => {
          return (
            message.revokesEventId === queued.id && message.runId !== undefined
          );
        });
        return (
          claimed !== undefined &&
          assistantMessages(messages).some((message) => {
            return (
              message.runId === claimed.runId &&
              message.runEventId === "queue:queued"
            );
          })
        );
      },
    );
    const claimed = userMessages(afterAutoSend.events).find((message) => {
      return message.revokesEventId === queued.id;
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to auto-send");
    }
    const marker = assistantMessages(afterAutoSend.events).find((message) => {
      return (
        message.runId === claimed.runId && message.runEventId === "queue:queued"
      );
    });
    if (!marker) {
      throw new Error("Expected an assistant queue marker");
    }
    expect(marker).toMatchObject({
      content: "Waiting in queue...",
      runId: claimed.runId,
    });
    await flushWaitUntilForTest();

    await api.requestCancelRun(actor, blocker.runId, [200]);
    await waitForRunStatus(actor, blocker.runId, "cancelled");
    await waitForRunStatus(actor, claimed.runId, "pending");
    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);
});

describe("CHAT-02/RUN-03: cancellation recovery barrier", () => {
  it("preserves immediate release when a pending run is cancelled", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "cancel before runner claim",
    });
    await waitForRunStatus(actor, run.runId, "pending");
    const queuedEventId = await queueChatEvent(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "continue after pending cancellation",
    });

    await api.requestCancelRun(actor, run.runId, [200]);
    const replacementRunId = await waitForQueuedEventReplacement(
      actor,
      run.threadId,
      queuedEventId,
    );
    expect(replacementRunId).not.toBe(run.runId);
    await expectCancellationRecoveryPending(actor, run.threadId, false);

    await api.requestCancelRun(actor, replacementRunId, [200]);
    await waitForRunStatus(actor, replacementRunId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("preserves immediate release when an org-queued run is cancelled", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const blocker = await startChatRun(actor, {
      agentId,
      prompt: "hold the only org run slot",
    });
    await waitForRunStatus(actor, blocker.runId, "pending");
    const queuedRun = await startChatRun(actor, {
      agentId,
      prompt: "cancel while waiting for the org slot",
    });
    await waitForRunStatus(actor, queuedRun.runId, "queued");
    const queuedEventId = await queueChatEvent(actor, {
      agentId,
      threadId: queuedRun.threadId,
      prompt: "continue after queued cancellation",
    });

    await api.requestCancelRun(actor, queuedRun.runId, [200]);
    const replacementRunId = await waitForQueuedEventReplacement(
      actor,
      queuedRun.threadId,
      queuedEventId,
    );
    expect(replacementRunId).not.toBe(queuedRun.runId);
    await expectCancellationRecoveryPending(actor, queuedRun.threadId, false);

    await api.requestCancelRun(actor, replacementRunId, [200]);
    await waitForRunStatus(actor, replacementRunId, "cancelled");
    await api.requestCancelRun(actor, blocker.runId, [200]);
    await waitForRunStatus(actor, blocker.runId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("redrives lifecycle-first recovery after a partial side-effect failure", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "cancel before the recovery completion",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await expectCancellationRecoveryPending(actor, run.threadId, false);
    const queuedEventId = await queueChatEvent(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "wait for cancellation recovery",
    });
    await api.requestCancelRun(actor, run.runId, [200]);
    await flushWaitUntilForTest();
    const afterCancel = await chat.listThreadEvents(actor, run.threadId);
    expect(
      lifecycleMarkers(afterCancel.events, run.runId, "cancelled"),
    ).toHaveLength(1);
    expect(
      userMessages(afterCancel.events).filter((event) => {
        return (
          event.revokesEventId === queuedEventId && event.runId !== undefined
        );
      }),
    ).toHaveLength(0);
    await expectCancellationRecoveryPending(actor, run.threadId, true);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadDetailChanged:${run.threadId}`,
      null,
    );
    context.mocks.ably.publish.mockClear();
    let rejectedRecoveryDrainSignal = false;
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (
        !rejectedRecoveryDrainSignal &&
        topic === `chatThreadMessageCreated:${run.threadId}`
      ) {
        rejectedRecoveryDrainSignal = true;
        return Promise.reject(
          new Error("Injected recovery drain signal failure"),
        );
      }
      return Promise.resolve(undefined);
    });
    const completion = await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Run cancelled" },
      sandboxHeaders,
      [200],
    );
    expect(completion.body).toStrictEqual({
      success: true,
      status: "failed",
    });
    await flushWaitUntilForTest();
    await waitForRunStatus(actor, run.runId, "cancelled");
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${run.threadId}`,
      null,
    );
    await expectCancellationRecoveryPending(actor, run.threadId, false);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadDetailChanged:${run.threadId}`,
      null,
    );
    const replacementRunId = await waitForQueuedEventReplacement(
      actor,
      run.threadId,
      queuedEventId,
    );

    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Run cancelled" },
      sandboxHeaders,
      [200],
    );
    await api.requestCancelRun(actor, run.runId, [200]);
    await flushWaitUntilForTest();
    const afterDuplicates = await chat.listThreadEvents(actor, run.threadId);
    expect(
      userMessages(afterDuplicates.events).filter((event) => {
        return (
          event.revokesEventId === queuedEventId && event.runId !== undefined
        );
      }),
    ).toHaveLength(1);

    await api.requestCancelRun(actor, replacementRunId, [200]);
    await waitForRunStatus(actor, replacementRunId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("redrives an acknowledged chat callback after terminal processing is lost", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "cancel before losing detached terminal processing",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    const queuedEventId = await queueChatEvent(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "continue after acknowledged callback recovery",
    });

    await api.requestCancelRun(actor, run.runId, [200]);
    await flushWaitUntilForTest();
    await removeAcknowledgedCancellationLifecycleFixture({
      runId: run.runId,
    });

    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Run cancelled" },
      sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    await expectCancellationRecoveryPending(actor, run.threadId, true);
    const beforeRedrive = await chat.listThreadEvents(actor, run.threadId);
    expect(
      lifecycleMarkers(beforeRedrive.events, run.runId, "cancelled"),
    ).toHaveLength(0);
    expect(
      userMessages(beforeRedrive.events).filter((event) => {
        return (
          event.revokesEventId === queuedEventId && event.runId !== undefined
        );
      }),
    ).toHaveLength(0);

    await api.requestCancelRun(actor, run.runId, [200]);
    await flushWaitUntilForTest();
    const replacementRunId = await waitForQueuedEventReplacement(
      actor,
      run.threadId,
      queuedEventId,
    );
    const afterRedrive = await chat.listThreadEvents(actor, run.threadId);
    expect(
      lifecycleMarkers(afterRedrive.events, run.runId, "cancelled"),
    ).toHaveLength(1);
    await expectCancellationRecoveryPending(actor, run.threadId, false);

    await api.requestCancelRun(actor, replacementRunId, [200]);
    await waitForRunStatus(actor, replacementRunId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("waits for the lifecycle event when recovery completion arrives first", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "delay the cancellation lifecycle callback",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    const queuedEventId = await queueChatEvent(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "wait for the delayed lifecycle event",
    });
    const cancelPublishGate = deferredGate();
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      return topic === "cancel"
        ? cancelPublishGate.wait()
        : Promise.resolve(undefined);
    });

    await api.requestCancelRun(actor, run.runId, [200]);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some(([topic]) => {
          return topic === "cancel";
        });
      })
      .toBe(true);
    await expectCancellationRecoveryPending(actor, run.threadId, true);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadDetailChanged:${run.threadId}`,
      null,
    );
    const completion = await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Run cancelled" },
      sandboxHeaders,
      [200],
    );
    expect(completion.body).toStrictEqual({
      success: true,
      status: "failed",
    });
    const beforeLifecycle = await chat.listThreadEvents(actor, run.threadId);
    expect(
      lifecycleMarkers(beforeLifecycle.events, run.runId, "cancelled"),
    ).toHaveLength(0);
    expect(
      userMessages(beforeLifecycle.events).filter((event) => {
        return (
          event.revokesEventId === queuedEventId && event.runId !== undefined
        );
      }),
    ).toHaveLength(0);
    await expectCancellationRecoveryPending(actor, run.threadId, true);

    const duplicateCompletion = await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Run cancelled" },
      sandboxHeaders,
      [200],
    );
    expect(duplicateCompletion.body).toStrictEqual({
      success: true,
      status: "failed",
    });

    cancelPublishGate.release();
    await flushWaitUntilForTest();
    const replacementRunId = await waitForQueuedEventReplacement(
      actor,
      run.threadId,
      queuedEventId,
    );
    const afterLifecycle = await chat.listThreadEvents(actor, run.threadId);
    expect(
      lifecycleMarkers(afterLifecycle.events, run.runId, "cancelled"),
    ).toHaveLength(1);
    await expectCancellationRecoveryPending(actor, run.threadId, false);

    await api.requestCancelRun(actor, replacementRunId, [200]);
    await waitForRunStatus(actor, replacementRunId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("records recovery when checkpointed completion follows cancellation", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "race completion with cancellation",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    const queuedEventId = await queueChatEvent(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "continue after the concurrent completion",
    });
    await flushWaitUntilForTest();
    await api.requestCancelRun(actor, run.runId, [200]);
    const completion = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        lastEventSequence: 0,
        checkpoint: chatRunCheckpoint(run.runId),
      },
      sandboxHeaders,
      [200],
    );
    expect(completion.body).toStrictEqual({
      success: true,
      status: "failed",
    });
    await flushWaitUntilForTest();
    await waitForRunStatus(actor, run.runId, "cancelled");
    const replacementRunId = await waitForQueuedEventReplacement(
      actor,
      run.threadId,
      queuedEventId,
    );

    await api.requestCancelRun(actor, replacementRunId, [200]);
    await waitForRunStatus(actor, replacementRunId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("releases a lost recovery completion through the recovery-aware stale sweep", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const startedAt = now();
    mockNow(startedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "cancel without a recovery completion",
    });
    await claimChatRun(runnerGroup, run.runId);
    const queuedEventId = await queueChatEvent(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "continue after the recovery barrier expires",
    });

    await api.requestCancelRun(actor, run.runId, [200]);
    await flushWaitUntilForTest();
    await expectCancellationRecoveryPending(actor, run.threadId, true);
    const whileFresh = await chat.listThreadEvents(actor, run.threadId);
    expect(
      lifecycleMarkers(whileFresh.events, run.runId, "cancelled"),
    ).toHaveLength(1);
    expect(
      userMessages(whileFresh.events).filter((event) => {
        return (
          event.revokesEventId === queuedEventId && event.runId !== undefined
        );
      }),
    ).toHaveLength(0);

    mockNow(startedAt + CANCELLATION_RECOVERY_STALE_AFTER_MS - 1);
    await reconcileCancellationRecoveryFixtures(run.threadId);
    const beforeExpiry = await chat.listThreadEvents(actor, run.threadId);
    expect(
      userMessages(beforeExpiry.events).filter((event) => {
        return (
          event.revokesEventId === queuedEventId && event.runId !== undefined
        );
      }),
    ).toHaveLength(0);
    await expectCancellationRecoveryPending(actor, run.threadId, true);

    context.mocks.ably.publish.mockClear();
    mockNow(startedAt + CANCELLATION_RECOVERY_STALE_AFTER_MS + 1);
    await reconcileCancellationRecoveryFixtures(run.threadId);
    const replacementRunId = await waitForQueuedEventReplacement(
      actor,
      run.threadId,
      queuedEventId,
    );
    await expectCancellationRecoveryPending(actor, run.threadId, false);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadDetailChanged:${run.threadId}`,
      null,
    );

    await api.requestCancelRun(actor, replacementRunId, [200]);
    await waitForRunStatus(actor, replacementRunId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);

  it("continues the recovery stale sweep after one thread drain fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const startedAt = now();
    mockNow(startedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const poisonedRun = await startChatRun(actor, {
      agentId,
      prompt: "cancel before a poisoned recovery drain",
    });
    const healthyRun = await startChatRun(actor, {
      agentId,
      prompt: "cancel before a healthy recovery drain",
    });
    await claimChatRun(runnerGroup, poisonedRun.runId);
    await claimChatRun(runnerGroup, healthyRun.runId);
    const poisonedEventId = await insertQueuedSlackMissingContextFixture({
      threadId: poisonedRun.threadId,
      content: "fail this expired recovery drain",
    });
    const healthyEventId = await queueChatEvent(actor, {
      agentId,
      threadId: healthyRun.threadId,
      prompt: "continue despite the other drain failure",
    });

    await api.requestCancelRun(actor, poisonedRun.runId, [200]);
    await api.requestCancelRun(actor, healthyRun.runId, [200]);
    await flushWaitUntilForTest();
    mockNow(startedAt + CANCELLATION_RECOVERY_STALE_AFTER_MS + 1);
    await reconcileCancellationRecoveryFixtures(
      poisonedRun.threadId,
      healthyRun.threadId,
    );

    const replacementRunId = await waitForQueuedEventReplacement(
      actor,
      healthyRun.threadId,
      healthyEventId,
    );
    const poisonedThread = await chat.listThreadEvents(
      actor,
      poisonedRun.threadId,
    );
    expect(
      userMessages(poisonedThread.events).filter((event) => {
        return (
          event.revokesEventId === poisonedEventId && event.runId !== undefined
        );
      }),
    ).toHaveLength(0);

    await api.requestCancelRun(actor, replacementRunId, [200]);
    await waitForRunStatus(actor, replacementRunId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);
});

describe("CHAT-02: chat output extraction and terminal callbacks", () => {
  it("uses durable assistant output for queued auto-send without querying Axiom output", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "stream before queued follow-up",
    });
    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued after streamed output",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);

    await webhooks.requestAgentEvents(
      {
        runId: first.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_bdd_db_complete",
              content: [{ type: "text", text: "DB-complete streamed answer" }],
            },
          },
          { type: "system", sequenceNumber: 1 },
        ],
      },
      firstHeaders,
      [200],
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockImplementation((apl: unknown) => {
      const query = typeof apl === "string" ? apl : "";
      if (query.includes("['agent-run-events']")) {
        throw new Error("DB-complete output should not query Axiom");
      }
      return Promise.resolve([]);
    });

    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 1,
    });

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return userMessages(threadMessages).some((message) => {
          return (
            chatEventDisplayText(message) === "queued after streamed output" &&
            message.runId !== undefined
          );
        });
      },
    );
    expect(chatOutputAxiomQueryCalls()).toHaveLength(0);
    expect(
      eventBackedContents(messages.events, first.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["DB-complete streamed answer"]);
    expect(
      lifecycleMarkers(messages.events, first.runId, "completed"),
    ).toHaveLength(1);

    const claimed = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === "queued after streamed output" &&
        message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error("Expected queued message to auto-send");
    }
    expect(claimed.runId).not.toBe(first.runId);
  }, 90_000);

  it("uses every acknowledged DB assistant event without Axiom repair", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await startChatRun(actor, {
      agentId,
      prompt: "partial streamed output",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_bdd_partial_0",
              content: [{ type: "text", text: "Partial streamed answer" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              id: "msg_bdd_partial_1",
              content: [{ type: "text", text: "Terminal DB answer" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    context.mocks.axiom.query.mockClear();
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 1,
    });

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, run.runId).length === 2;
      },
    );
    expect(chatOutputAxiomQueryCalls()).toHaveLength(0);
    expect(
      eventBackedContents(messages.events, run.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(
      expect.arrayContaining(["Partial streamed answer", "Terminal DB answer"]),
    );
  }, 90_000);

  it("does not query Axiom when repeated DB event batches are idempotent", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await startChatRun(actor, {
      agentId,
      prompt: "repeat DB output",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    const event = {
      type: "assistant" as const,
      sequenceNumber: 0,
      message: {
        id: "msg_bdd_repeated_db_output",
        content: [{ type: "text" as const, text: "Stored once" }],
      },
    };
    await webhooks.requestAgentEvents(
      { runId: run.runId, events: [event] },
      sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentEvents(
      { runId: run.runId, events: [event] },
      sandboxHeaders,
      [200],
    );
    context.mocks.axiom.query.mockClear();

    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, run.runId).length === 1;
      },
    );
    expect(
      eventBackedContents(messages.events, run.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["Stored once"]);
    expect(chatOutputAxiomQueryCalls()).toHaveLength(0);
  }, 90_000);

  it("persists assistant-only batches without writing the run-output materialization", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const run = await startChatRun(actor, {
      agentId,
      prompt:
        "persist assistant output while the callback projection is locked",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "result",
            sequenceNumber: 0,
            result: "Seed the callback projection row",
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    const held = await holdRunOutputMaterializationRowFixture({
      runId: run.runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });

    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              id: "msg_bdd_no_output_materialization_write",
              content: [
                {
                  type: "text",
                  text: "Durable assistant output while the projection row is locked",
                },
              ],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );

    await expect(held.blockedWaiterCount()).resolves.toBe(0);
    const messages = await chat.listThreadEvents(actor, run.threadId);
    expect(
      eventBackedContents(messages.events, run.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual([
      "Durable assistant output while the projection row is locked",
    ]);
    await flushWaitUntilForTest();
    held.release();
    await held.done;
    await api.requestCancelRun(actor, run.runId, [200]);
    await flushWaitUntilForTest();
  }, 30_000);

  it("persists normalized Claude text blocks independently across tool-only sequences", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await startChatRun(actor, {
      agentId,
      prompt: "persist normalized Claude blocks",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    const events = [
      {
        type: "assistant" as const,
        sequenceNumber: 0,
        message: {
          id: "msg_bdd_normalized_claude",
          content: [{ type: "text" as const, text: "text A" }],
        },
      },
      {
        type: "assistant" as const,
        sequenceNumber: 1,
        message: {
          id: "msg_bdd_normalized_claude",
          content: [
            {
              type: "tool_use" as const,
              id: "tool_bdd_normalized_claude",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
      },
      {
        type: "assistant" as const,
        sequenceNumber: 2,
        message: {
          id: "msg_bdd_normalized_claude",
          content: [{ type: "text" as const, text: "text B" }],
        },
      },
      {
        type: "assistant" as const,
        sequenceNumber: 3,
        message: {
          id: "msg_bdd_normalized_claude",
          content: [{ type: "text" as const, text: "text C" }],
        },
      },
    ];
    await webhooks.requestAgentEvents(
      { runId: run.runId, events },
      sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentEvents(
      { runId: run.runId, events },
      sandboxHeaders,
      [200],
    );
    context.mocks.axiom.query.mockClear();
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 3,
    });
    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, run.runId).length === 3;
      },
    );
    const persisted = eventBackedContents(messages.events, run.runId).sort(
      (left, right) => {
        return (
          (left.sequenceNumber ?? Number.MAX_SAFE_INTEGER) -
          (right.sequenceNumber ?? Number.MAX_SAFE_INTEGER)
        );
      },
    );
    expect(
      persisted.map((message) => {
        return {
          content: message.content,
          runEventId: message.runEventId,
          sequenceNumber: message.sequenceNumber,
        };
      }),
    ).toStrictEqual([
      { content: "text A", runEventId: "event:0", sequenceNumber: 0 },
      { content: "text B", runEventId: "event:2", sequenceNumber: 2 },
      { content: "text C", runEventId: "event:3", sequenceNumber: 3 },
    ]);
    expect(
      new Set(
        persisted.map((message) => {
          return message.id;
        }),
      ).size,
    ).toBe(3);
    expect(chatOutputAxiomQueryCalls()).toHaveLength(0);
    await flushWaitUntilForTest();
  }, 90_000);

  it("returns 503 when the required DB output projection is locked", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "locked live projection",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    const held = await holdChatEventInsertTransactionFixture({
      threadId: run.threadId,
      content: "hold the chat sequence row",
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });

    const response = await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_locked_projection",
              content: [{ type: "text", text: "must be durable" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [503],
    );
    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual({
      error: {
        code: "EVENT_DELIVERY_UNAVAILABLE",
        message: "Agent event delivery is temporarily unavailable",
      },
    });

    const messages = await chat.listThreadEvents(actor, run.threadId);
    expect(eventBackedContents(messages.events, run.runId)).toHaveLength(0);
    held.release();
    await held.done;
  }, 30_000);

  it("returns the route deadline while a required DB projection remains blocked", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "keep accepted projection alive",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    const routeDeadline = new AbortController();
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 20_000 ? routeDeadline.signal : undefined;
    });
    const held = await holdChatEventInsertTransactionFixture({
      threadId: run.threadId,
      content: "hold the accepted projection",
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });

    const pending = webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_independent_projection",
              content: [{ type: "text", text: "Persist after the ACK." }],
            },
          },
        ],
      },
      sandboxHeaders,
      [503],
    );
    await expect.poll(held.blockedWaiterCount).toBeGreaterThanOrEqual(1);

    routeDeadline.abort(
      new DOMException("event route deadline", "TimeoutError"),
    );
    const response = await pending;
    expect(response.status).toBe(503);
    held.release();
    await held.done;

    const messages = await chat.listThreadEvents(actor, run.threadId);
    expect(eventBackedContents(messages.events, run.runId)).toHaveLength(0);
  }, 30_000);

  it("persists concurrent event batches instead of skipping output projection", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "saturate live projection admission",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await Promise.all(
      Array.from({ length: 6 }, (_, sequenceNumber) => {
        return webhooks.requestAgentEvents(
          {
            runId: run.runId,
            events: [
              {
                type: "assistant",
                sequenceNumber,
                message: {
                  id: `msg_saturated_projection_${sequenceNumber}`,
                  content: [
                    {
                      type: "text",
                      text: `saturated output ${sequenceNumber}`,
                    },
                  ],
                },
              },
            ],
          },
          sandboxHeaders,
          [200],
        );
      }),
    );

    const messages = await chat.listThreadEvents(actor, run.threadId);
    expect(eventBackedContents(messages.events, run.runId)).toHaveLength(6);

    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 5,
    });
    await flushWaitUntilForTest();
  }, 30_000);

  it("keeps rejected event reservations as sequence gaps", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "repeat an accepted event batch",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);

    const sequenceOne = {
      type: "assistant" as const,
      sequenceNumber: 1,
      message: {
        id: "msg_repeated_event_batch_1",
        content: [{ type: "text" as const, text: "Stored sequence one." }],
      },
    };
    const sequenceZero = {
      type: "assistant" as const,
      sequenceNumber: 0,
      message: {
        id: "msg_repeated_event_batch_0",
        content: [{ type: "text" as const, text: "Stored sequence zero." }],
      },
    };
    await webhooks.requestAgentEvents(
      { runId: run.runId, events: [sequenceOne] },
      sandboxHeaders,
      [200],
    );
    // The existing sequence-one row rejects its reserved position.
    await webhooks.requestAgentEvents(
      { runId: run.runId, events: [sequenceZero, sequenceOne] },
      sandboxHeaders,
      [200],
    );
    // A fully repeated batch still consumes its reservation.
    await webhooks.requestAgentEvents(
      { runId: run.runId, events: [sequenceZero] },
      sandboxHeaders,
      [200],
    );
    // The rejected sequence-one row leaves another gap before the newly
    // accepted row.
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          sequenceOne,
          {
            type: "assistant",
            sequenceNumber: 2,
            message: {
              id: "msg_repeated_event_batch_2",
              content: [
                { type: "text", text: "Stored sequence two after a gap." },
              ],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 3,
            message: {
              id: "msg_repeated_event_batch_3",
              content: [{ type: "text", text: "Stored sequence three." }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();

    const messages = await chat.listThreadEvents(actor, run.threadId);
    const outputByRunSequence = new Map(
      eventBackedContents(messages.events, run.runId).map((message) => {
        return [message.sequenceNumber, message] as const;
      }),
    );
    expect(
      [...outputByRunSequence.keys()].sort((left, right) => {
        return (left ?? 0) - (right ?? 0);
      }),
    ).toStrictEqual([0, 1, 2, 3]);
    const sequenceZeroRow = outputByRunSequence.get(0);
    const sequenceOneRow = outputByRunSequence.get(1);
    const sequenceTwoRow = outputByRunSequence.get(2);
    const sequenceThreeRow = outputByRunSequence.get(3);
    if (
      sequenceZeroRow === undefined ||
      sequenceOneRow === undefined ||
      sequenceTwoRow === undefined ||
      sequenceThreeRow === undefined
    ) {
      throw new Error("Expected every canonical repeated-batch output");
    }
    expect(sequenceZeroRow.seqId).toBeGreaterThan(sequenceOneRow.seqId);
    expect(sequenceTwoRow.seqId).toBeGreaterThan(sequenceZeroRow.seqId + 2);
    expect(sequenceThreeRow.seqId).toBeGreaterThan(sequenceTwoRow.seqId);
  });

  it("completes no-output runs and preserves the newest result-only output across retries", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const silent = await startChatRun(actor, {
      agentId,
      prompt: "silent streamed run",
    });
    const silentHeaders = await claimChatRun(runnerGroup, silent.runId);
    await webhooks.requestAgentEvents(
      {
        runId: silent.runId,
        events: [
          {
            type: "user",
            sequenceNumber: 0,
            message: {
              content: [
                {
                  type: "text",
                  text: "non-assistant text must not become assistant output",
                },
              ],
            },
          },
        ],
      },
      silentHeaders,
      [200],
    );
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockImplementation((apl: unknown) => {
      const query = typeof apl === "string" ? apl : "";
      if (query.includes("['agent-run-events']")) {
        throw new Error("DB-complete no-output run should not query Axiom");
      }
      return Promise.resolve([]);
    });

    await completeChatRunOk(silent.runId, silentHeaders, {
      lastEventSequence: 0,
    });
    let messages = await waitForThreadMessages(
      actor,
      silent.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, silent.runId, "completed").length ===
          1
        );
      },
    );
    expect(chatOutputAxiomQueryCalls()).toHaveLength(0);
    expect(eventBackedContents(messages.events, silent.runId)).toHaveLength(0);
    await flushWaitUntilForTest();

    const resultOnly = await startChatRun(actor, {
      agentId,
      threadId: silent.threadId,
      prompt: "result-only streamed run",
    });
    const resultOnlyHeaders = await claimChatRun(runnerGroup, resultOnly.runId);
    await webhooks.requestAgentEvents(
      {
        runId: resultOnly.runId,
        events: [
          {
            type: "result",
            sequenceNumber: 2,
            result: "DB result fallback answer",
          },
        ],
      },
      resultOnlyHeaders,
      [200],
    );
    await webhooks.requestAgentEvents(
      {
        runId: resultOnly.runId,
        events: [
          {
            type: "result",
            sequenceNumber: 2,
            result: "DB result fallback answer",
          },
        ],
      },
      resultOnlyHeaders,
      [200],
    );
    await webhooks.requestAgentEvents(
      {
        runId: resultOnly.runId,
        events: [
          {
            type: "result",
            sequenceNumber: 1,
            result: "Older result must not replace the latest output",
          },
        ],
      },
      resultOnlyHeaders,
      [200],
    );
    context.mocks.axiom.query.mockClear();

    await completeChatRunOk(resultOnly.runId, resultOnlyHeaders, {
      lastEventSequence: 2,
    });
    messages = await waitForThreadMessages(
      actor,
      silent.threadId,
      (threadMessages) => {
        return (
          eventBackedContents(threadMessages, resultOnly.runId).length === 1
        );
      },
    );
    expect(chatOutputAxiomQueryCalls()).toHaveLength(0);
    expect(
      eventBackedContents(messages.events, resultOnly.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["DB result fallback answer"]);
    await flushWaitUntilForTest();
  }, 90_000);

  it("excludes stored result output above the terminal event boundary", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await startChatRun(actor, {
      agentId,
      prompt: "exclude future result output",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "result",
            sequenceNumber: 1,
            result: "Future result must stay outside the completed run",
          },
        ],
      },
      sandboxHeaders,
      [200],
    );

    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, run.runId, "completed").length === 1
        );
      },
    );
    expect(eventBackedContents(messages.events, run.runId)).toHaveLength(0);
    await flushWaitUntilForTest();
  }, 90_000);

  it("completes when no output materialization exists", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await startChatRun(actor, {
      agentId,
      prompt: "complete without projected output",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);

    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockImplementation((apl: unknown) => {
      const query = typeof apl === "string" ? apl : "";
      if (query.includes("agent-run-events")) {
        throw new Error("Incomplete DB output should not query Axiom");
      }
      return Promise.resolve([]);
    });

    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, run.runId, "completed").length === 1
        );
      },
    );

    expect(eventBackedContents(messages.events, run.runId)).toHaveLength(0);
  }, 90_000);

  it("extracts assistant output from Codex items and result fallbacks, skips non-events, and handles heartbeats without reading events", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const routeRequests = chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "progress probe",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${first.threadId}`;
        });
      })
      .toBe(true);
    context.mocks.axiom.query.mockClear();
    context.mocks.ably.publish.mockClear();
    await webhooks.requestAgentHeartbeat(
      { runId: first.runId },
      firstHeaders,
      [200],
    );

    expect(routeRequests()).toBe(0);
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
    const progressMessages = await chat.listThreadEvents(actor, first.threadId);
    const progressUserMessages = userMessages(progressMessages.events);
    expect(progressUserMessages).toHaveLength(2);
    const progressOriginal = progressUserMessages.find((message) => {
      return message.id === first.messageId;
    });
    expect(progressOriginal?.runId).toBeUndefined();
    expect(progressUserMessages).toContainEqual(
      expect.objectContaining({
        runId: first.runId,
        revokesEventId: first.messageId,
      }),
    );

    // Blank assistant text, non-agent_message Codex items, and result-shaped
    // fields on non-result events are skipped.
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, ""),
      {
        eventType: "item.completed",
        sequenceNumber: 1,
        eventData: { item: { type: "tool_call", text: "internal tool text" } },
      },
      {
        eventType: "result",
        sequenceNumber: 2,
        eventData: { result: "final fallback answer" },
      },
      {
        eventType: "item.completed",
        sequenceNumber: 3,
        eventData: {
          item: { type: "tool_call", text: "internal tool text" },
          result: "tool result must not become chat output",
        },
      },
      resultEvent(4, "future result must not become chat output"),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 3,
    });

    let messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, first.runId).length === 1;
      },
    );
    expect(
      eventBackedContents(messages.events, first.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["final fallback answer"]);

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "codex turn",
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    chatCallbacks.mockChatOutputEvents([
      {
        eventType: "item.completed",
        sequenceNumber: 0,
        eventData: { item: { type: "agent_message", text: "Codex answer" } },
      },
    ]);
    await completeChatRunOk(second.runId, secondHeaders, {
      lastEventSequence: 0,
    });

    messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, second.runId).length === 1;
      },
    );
    expect(
      eventBackedContents(messages.events, second.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["Codex answer"]);

    const third = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "streamed turn",
    });
    const thirdHeaders = await claimChatRun(runnerGroup, third.runId);
    await webhooks.requestAgentEvents(
      {
        runId: third.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: "msg_bdd_streamed",
              content: [{ type: "text", text: "Already streamed." }],
            },
          },
        ],
      },
      thirdHeaders,
      [200],
    );
    chatCallbacks.mockChatOutputEvents([
      resultEvent(0, "Unknown command: /aaa"),
    ]);
    await completeChatRunOk(third.runId, thirdHeaders, {
      lastEventSequence: 0,
    });

    messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return eventBackedContents(threadMessages, third.runId).length === 1;
      },
    );
    expect(
      eventBackedContents(messages.events, third.runId).map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["Already streamed."]);

    const beforeTitle = await readThreadTitleFromEvents(actor, first.threadId);
    expect(beforeTitle).toBeNull();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterFailure();
    const fourth = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "title failure turn",
    });
    const fourthHeaders = await claimChatRun(runnerGroup, fourth.runId);
    chatCallbacks.mockChatOutputEvents([resultEvent(0, "Some result")]);
    await completeChatRunOk(fourth.runId, fourthHeaders, {
      lastEventSequence: 0,
    });

    expect((await api.readRun(actor, fourth.runId)).status).toBe("completed");
    messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, fourth.runId, "completed").length ===
          1
        );
      },
    );
    expect(
      lifecycleMarkers(messages.events, fourth.runId, "completed"),
    ).toHaveLength(1);
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe(beforeTitle);
  }, 90_000);
});

describe("CHAT-02: drain-time admission failure", () => {
  it("terminalizes a queued Web message when credits are lost before drain", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped Web chat actor");
    }
    const startedAt = now();
    mockNow(startedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await startChatRun(actor, {
      agentId,
      prompt: "finish after queued Web credit loss",
    });
    const anchorHeaders = await claimChatRun(runnerGroup, anchor.runId);
    const queuedEventId = randomUUID();
    const queuedPrompt = "reject this queued Web message after credit loss";
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: queuedPrompt,
        clientEventId: queuedEventId,
      },
      [201],
    );
    if ("error" in queued.body) {
      throw new Error(queued.body.error.message);
    }
    expect(queued.body.runId).toBeNull();

    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: actor.orgId,
      status: "suspended",
      canBuyCredits: true,
    });
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Injected queued Web admission realtime failure"),
    );

    await completeChatRunOk(anchor.runId, anchorHeaders);
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const terminal = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (events) => {
        return (
          userMessages(events).some((event) => {
            return (
              event.eventType === "input.rejected" &&
              event.revokesEventId === queuedEventId &&
              event.error === "insufficient_credits"
            );
          }) &&
          assistantMessages(events).some((event) => {
            return (
              event.eventType === "output.error" &&
              event.error === "insufficient_credits"
            );
          })
        );
      },
    );
    const original = userMessages(terminal.events).find((event) => {
      return event.id === queuedEventId;
    });
    expect(original).toMatchObject({
      eventType: "input.prompt",
    });
    expect(original ? chatEventDisplayText(original) : null).toBe(queuedPrompt);
    const replacements = userMessages(terminal.events).filter((event) => {
      return event.revokesEventId === queuedEventId;
    });
    expect(replacements).toStrictEqual([
      expect.objectContaining({
        eventType: "input.rejected",
        error: "insufficient_credits",
      }),
    ]);
    const errors = assistantMessages(terminal.events).filter((event) => {
      return (
        event.eventType === "output.error" &&
        event.error === "insufficient_credits"
      );
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.content).toContain("Add credits");
    expect(errors[0]?.content).toContain(
      "https://app.okou.ai/?settings=billing&billingView=credits",
    );
    expect(
      (await api.listAgentRuns(actor, { limit: 20 })).runs.filter((run) => {
        return run.prompt === queuedPrompt;
      }),
    ).toHaveLength(0);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${anchor.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    mockNow(startedAt + CANCELLATION_RECOVERY_STALE_AFTER_MS + 1);
    await reconcileCancellationRecoveryFixtures(anchor.threadId);
    const retried = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: queuedPrompt,
        clientEventId: queuedEventId,
      },
      [201],
    );
    if ("error" in retried.body) {
      throw new Error(retried.body.error.message);
    }
    expect(retried.body.runId).toBeNull();
    await flushWaitUntilForTest();

    const afterRecovery = await chat.listThreadEvents(actor, anchor.threadId);
    expect(
      userMessages(afterRecovery.events).filter((event) => {
        return event.revokesEventId === queuedEventId;
      }),
    ).toHaveLength(1);
    expect(
      assistantMessages(afterRecovery.events).filter((event) => {
        return (
          event.eventType === "output.error" &&
          event.error === "insufficient_credits"
        );
      }),
    ).toHaveLength(1);
    expect(
      (await api.listAgentRuns(actor, { limit: 20 })).runs.filter((run) => {
        return run.prompt === queuedPrompt;
      }),
    ).toHaveLength(0);
  }, 90_000);

  it("terminalizes a queued Web message with neutral copy when every built-in route is unavailable", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await startChatRun(actor, {
      agentId,
      prompt: "finish before queued built-in model admission",
    });
    const anchorHeaders = await claimChatRun(runnerGroup, anchor.runId);
    const queuedPrompt = "reject this queued message without a built-in key";
    const queuedEventId = await queueChatEvent(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: queuedPrompt,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    await chat.updateThreadModelSelection(
      actor,
      anchor.threadId,
      "claude-sonnet-5",
    );
    chatCallbacks.mockChatOutputEvents([]);

    await withBuiltInModelRuntimeRouteUnavailableForTest(
      "claude-sonnet-5",
      async () => {
        await completeChatRunOk(anchor.runId, anchorHeaders);
        await flushWaitUntilForTest();
      },
    );

    const terminal = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (events) => {
        return (
          userMessages(events).some((event) => {
            return (
              event.eventType === "input.rejected" &&
              event.revokesEventId === queuedEventId &&
              event.error === "model_provider_unavailable"
            );
          }) &&
          assistantMessages(events).some((event) => {
            return (
              event.eventType === "output.error" &&
              event.error === "model_provider_unavailable"
            );
          })
        );
      },
    );
    const rejected = userMessages(terminal.events).find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === queuedEventId
      );
    });
    if (rejected?.eventType !== "input.rejected") {
      throw new Error("Expected the queued Web message to be rejected");
    }
    expect(rejected.error).toBe("model_provider_unavailable");
    const errors = assistantMessages(terminal.events).filter((event) => {
      return (
        event.eventType === "output.error" &&
        event.error === "model_provider_unavailable"
      );
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.content).toBe(
      "Oops, something went wrong. Please try again later.",
    );
    expect(
      (await api.listAgentRuns(actor, { limit: 20 })).runs.filter((run) => {
        return run.prompt === queuedPrompt;
      }),
    ).toHaveLength(0);
  }, 90_000);
});

describe("CHAT-02: failed chat callbacks", () => {
  it("formats failed-run errors and notifies, without auto-sending", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    await seedBuiltInModelKey(context, "gpt-5.6-sol");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-sol",
        isDefault: false,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();

    const actionableError =
      "No model provider configured. Configure one in Workspace Settings → Models.";
    const usageLimitError =
      "Claude usage limit reached. Visit https://claude.ai/settings/usage or try again at 6:17 AM.";
    const executionTimeoutError =
      "Agent execution timed out after 7200 seconds";
    const rounds: readonly {
      readonly prompt: string;
      readonly error: string;
      readonly expectedError?: string;
      readonly failureReason?: RunFailureReasonToken;
      readonly selectedModel?: SupportedRunModel;
    }[] = [
      { prompt: "round one", error: actionableError },
      {
        prompt: "round two",
        error: executionTimeoutError,
        expectedError: "Oops, something went wrong. Please try again later.",
        failureReason: "future_reason",
      },
      {
        prompt: "round three",
        error: "Second runner failure",
        expectedError: "Oops, something went wrong. Please try again later.",
      },
      { prompt: "round four", error: usageLimitError },
      {
        prompt: "round five",
        error: executionTimeoutError,
        expectedError: CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE,
      },
      {
        prompt: "round six",
        error: usageLimitError,
        expectedError: "Oops, something went wrong. Please try again later.",
        failureReason: "provider_rate_limited",
      },
      {
        prompt: "round seven",
        error: usageLimitError,
        expectedError:
          "Selected model is at capacity. Please try a different model.",
        failureReason: "provider_overloaded",
        selectedModel: "gpt-5.6-sol",
      },
      {
        prompt: "round eight",
        error:
          "Claude Sonnet 5 is overloaded. Please wait a few minutes and try again, or switch to another model.",
        failureReason: "usage_limit",
        selectedModel: "claude-sonnet-5",
      },
      {
        prompt: "round nine",
        error: "Unrelated runner failure",
        expectedError: "insufficient_credits",
        failureReason: "insufficient_credits",
      },
      {
        prompt: "round ten",
        error: "Contradictory runner failure",
        expectedError:
          "Claude Sonnet 5 is overloaded. Please wait a few minutes and try again, or switch to another model.",
        failureReason: "provider_overloaded",
        selectedModel: "claude-sonnet-5",
      },
      {
        prompt: "round eleven",
        error: "Contradictory runner failure",
        expectedError: CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE,
        failureReason: "execution_timeout",
      },
    ];

    let threadId: string | undefined;
    const runIds: string[] = [];
    for (const round of rounds) {
      const run = await startChatRun(actor, {
        agentId,
        prompt: round.prompt,
        ...(threadId === undefined ? {} : { threadId }),
        ...(round.selectedModel === undefined
          ? {}
          : { selectedModel: round.selectedModel }),
      });
      threadId = run.threadId;
      runIds.push(run.runId);
      const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
      // Isolate failed-callback notifications from send-side background work.
      await flushWaitUntilForTest();
      context.mocks.ably.publish.mockClear();
      await failChatRun(
        run.runId,
        sandboxHeaders,
        round.error,
        round.failureReason,
      );
      // The complete webhook acknowledges before terminal callback work
      // finishes. Drain its tracked waitUntil work so the realtime assertion
      // covers the complete failed-run callback instead of a one-second window.
      await flushWaitUntilForTest();
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        `chatThreadMessageCreated:${run.threadId}`,
        null,
      );
      if (round.failureReason !== undefined) {
        await webhooks.requestAgentComplete(
          {
            runId: run.runId,
            exitCode: 1,
            error: "Late conflicting failure",
            failureReason: "provider_overloaded",
          },
          sandboxHeaders,
          [200],
        );
        await flushWaitUntilForTest();
      }
    }
    if (!threadId) {
      throw new Error("Expected failed chat rounds");
    }

    const messages = await waitForThreadMessages(actor, threadId, (items) => {
      const failed = items.filter((message) => {
        return message.eventType === "run.failed";
      });
      return runIds.every((runId) => {
        return failed.some((message) => {
          return message.runId === runId && message.error !== undefined;
        });
      });
    });
    const users = userMessages(messages.events);
    const originals = users.filter((message) => {
      return message.runId === undefined;
    });
    const replacements = users.filter((message) => {
      return message.runId !== undefined;
    });
    expect(originals).toHaveLength(rounds.length);
    expect(replacements).toHaveLength(rounds.length);
    expect(
      replacements.every((replacement) => {
        return originals.some((original) => {
          return replacement.revokesEventId === original.id;
        });
      }),
    ).toBeTruthy();
    const failed = messages.events.filter((message) => {
      return message.eventType === "run.failed";
    });
    expect(
      runIds.map((runId) => {
        return failed.find((message) => {
          return message.runId === runId;
        })?.error;
      }),
    ).toStrictEqual(
      rounds.map((round) => {
        return round.expectedError ?? round.error;
      }),
    );
    expect(
      failed.find((message) => {
        return message.runId === runIds[0];
      })?.content,
    ).toBe(actionableError);
    expect(
      failed.find((message) => {
        return message.runId === runIds[3];
      })?.content,
    ).toBe(usageLimitError);
    expect(
      failed.find((message) => {
        return message.runId === runIds[4];
      })?.content,
    ).toBe(CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE);
    expect(
      runIds.map((runId) => {
        return failed.find((message) => {
          return message.runId === runId;
        })?.failureReason;
      }),
    ).toStrictEqual(
      rounds.map((round) => {
        return round.failureReason;
      }),
    );

    const rawRows = await chat.listThreadEventRows(actor, threadId);
    const rawFailures = rawRows.filter((row) => {
      return row.eventType === "run.failed";
    });
    expect(
      runIds.map((runId) => {
        return rawFailures.find((row) => {
          return row.runId === runId;
        })?.failureReason;
      }),
    ).toStrictEqual(
      rounds.map((round) => {
        return round.failureReason;
      }),
    );
    expect(
      rawFailures.find((row) => {
        return row.runId === runIds[1];
      })?.payload,
    ).toStrictEqual({
      content: "Oops, something went wrong. Please try again later.",
      error: "Oops, something went wrong. Please try again later.",
    });

    expect(context.mocks.webpush.sendNotification).toHaveBeenCalledTimes(
      rounds.length,
    );
    expect(
      pushPayload(context.mocks.webpush.sendNotification.mock.calls[1]),
    ).toMatchObject({
      title: "round two",
      body: "Task failed: Oops, something went wrong. Please try again later.",
      url: `http://localhost:3002/chats/${threadId}`,
    });
    expect(
      pushPayload(context.mocks.webpush.sendNotification.mock.calls[4]),
    ).toMatchObject({
      title: "round five",
      body: `Task failed: ${CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE}`,
      url: `http://localhost:3002/chats/${threadId}`,
    });
  }, 90_000);

  it("stores insufficient credits failures as the billing recovery marker", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const run = await startChatRun(actor, {
      agentId,
      prompt: "post-dispatch billing failure",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);

    await failChatRun(
      run.runId,
      sandboxHeaders,
      "INSUFFICIENT_CREDITS: Insufficient credits. Please add credits to continue.",
    );

    const page = await waitForThreadMessages(
      actor,
      run.threadId,
      (messages) => {
        return lifecycleMarkers(messages, run.runId, "failed").some(
          (message) => {
            return message.error === "insufficient_credits";
          },
        );
      },
    );
    const marker = lifecycleMarkers(page.events, run.runId, "failed")[0];
    expect(marker?.error).toBe("insufficient_credits");
    expect(marker?.content).toBe("insufficient_credits");
  }, 90_000);

  it("shows friendly Claude overload guidance while preserving the raw run error", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const rawOverloadError =
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment. If it persists, check https://status.claude.com.";

    const run = await startChatRun(actor, {
      agentId,
      prompt: "trigger claude overload",
      selectedModel: "claude-sonnet-5",
    });
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await failChatRun(run.runId, sandboxHeaders, rawOverloadError);

    const page = await waitForThreadMessages(
      actor,
      run.threadId,
      (messages) => {
        return lifecycleMarkers(messages, run.runId, "failed").some(
          (message) => {
            return message.error?.includes("Claude Sonnet 5") ?? false;
          },
        );
      },
    );
    const marker = lifecycleMarkers(page.events, run.runId, "failed")[0];
    expect(marker?.error).toBe(
      "Claude Sonnet 5 is overloaded. Please wait a few minutes and try again, or switch to another model.",
    );
    expect(marker?.content).toBe(marker?.error);
    expect(marker?.error).not.toContain("status.claude.com");

    const rawRun = await api.readRun(actor, run.runId);
    expect(rawRun.error).toBe(rawOverloadError);
  }, 90_000);

  it("shows Claude Code credential recovery guidance for upstream auth 401s", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const upstreamAuthError =
      "Failed to authenticate. API Error: 401 Invalid authentication credentials";
    const revokedOAuthError =
      "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";
    const invalidOAuthError =
      "Failed to authenticate. API Error: 401 OAuth access token is invalid.";

    async function failAndReadError(params: {
      readonly prompt: string;
      readonly errorMessage?: string;
      readonly failureReason?: RunFailureReasonToken;
      readonly selectedModel?: SupportedRunModel;
      readonly orgRole?: TestOrgRole;
      readonly removeCallbackPublicBrand?: boolean;
      readonly configureProvider?: (
        fixture: EntitledChatActor,
      ) => Promise<void>;
    }): Promise<string> {
      const fixture =
        params.orgRole === "member"
          ? await entitledChatMemberActor()
          : await entitledChatActor();
      await params.configureProvider?.(fixture);
      const run = await startChatRun(fixture.actor, {
        agentId: fixture.agentId,
        prompt: params.prompt,
        ...(params.selectedModel === undefined
          ? {}
          : { selectedModel: params.selectedModel }),
      });
      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      if (params.removeCallbackPublicBrand) {
        await removeChatCallbackPublicBrandFixture(run.runId);
      }
      if (params.orgRole !== undefined) {
        mockClerkMembership(
          context,
          fixture.actor,
          params.orgRole === "admin" ? "org:admin" : "org:member",
        );
      }
      await failChatRun(
        run.runId,
        sandboxHeaders,
        params.errorMessage ?? upstreamAuthError,
        params.failureReason,
      );

      const page = await waitForThreadMessages(
        fixture.actor,
        run.threadId,
        (messages) => {
          return lifecycleMarkers(messages, run.runId, "failed").some(
            (message) => {
              return message.error !== undefined;
            },
          );
        },
      );
      const marker = lifecycleMarkers(page.events, run.runId, "failed")[0];
      if (!marker?.error) {
        throw new Error("Expected failed chat callback to store an error");
      }
      expect(marker.content).toBe(marker.error);
      expect(marker.error).not.toContain("Report this issue");
      await expect(
        api.readRun(fixture.actor, run.runId),
      ).resolves.toMatchObject({
        status: "failed",
        error: params.errorMessage ?? upstreamAuthError,
      });
      if (params.failureReason === "reconnect_required") {
        expect(marker.failureReason).toBe("reconnect_required");
        expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
        await misc.upsertPersonalModelProvider(
          fixture.actor,
          {
            type: "claude-code-oauth-token",
            secret: "sk-ant-oat-reconnected-bdd",
          },
          [200],
        );
        const retry = await startChatRun(fixture.actor, {
          agentId: fixture.agentId,
          threadId: run.threadId,
          prompt: "retry after replacing the Claude OAuth token",
          selectedModel: "claude-opus-4-8",
        });
        const retryHeaders = await claimChatRun(
          fixture.runnerGroup,
          retry.runId,
        );
        await completeChatRunOk(retry.runId, retryHeaders);
        await expect(
          api.readRun(fixture.actor, retry.runId),
        ).resolves.toMatchObject({ status: "completed" });
      }
      return marker.error;
    }

    await expect(
      failAndReadError({
        prompt: "subscription credential failed",
        selectedModel: "claude-opus-4-8",
        configureProvider: configureClaudeCodeSubscriptionProvider,
      }),
    ).resolves.toBe(
      "Claude Code subscription authentication failed. Reconnect Claude Code in Model Providers, then retry.\n\nReconnect Claude Code: https://app.okou.ai/?settings=model",
    );
    await expect(
      failAndReadError({
        prompt: "structured subscription credential failed",
        errorMessage: "Provider authentication copy changed",
        failureReason: "invalid_credentials",
        selectedModel: "claude-opus-4-8",
        configureProvider: configureClaudeCodeSubscriptionProvider,
      }),
    ).resolves.toBe(
      "Claude Code subscription authentication failed. Reconnect Claude Code in Model Providers, then retry.\n\nReconnect Claude Code: https://app.okou.ai/?settings=model",
    );
    await expect(
      failAndReadError({
        prompt: "revoked subscription credential failed",
        errorMessage: revokedOAuthError,
        selectedModel: "claude-opus-4-8",
        configureProvider: configureClaudeCodeSubscriptionProvider,
      }),
    ).resolves.toBe(
      "Claude Code subscription authentication failed. Reconnect Claude Code in Model Providers, then retry.\n\nReconnect Claude Code: https://app.okou.ai/?settings=model",
    );
    await expect(
      failAndReadError({
        prompt: "revoked OAuth text with an Anthropic API key",
        errorMessage: revokedOAuthError,
        selectedModel: "claude-sonnet-5",
      }),
    ).resolves.toBe("Oops, something went wrong. Please try again later.");
    await expect(
      failAndReadError({
        prompt: "invalid subscription credential failed",
        errorMessage: invalidOAuthError,
        selectedModel: "claude-opus-4-8",
        configureProvider: configureClaudeCodeSubscriptionProvider,
      }),
    ).resolves.toBe(
      "Claude Code subscription authentication failed. Reconnect Claude Code in Model Providers, then retry.\n\nReconnect Claude Code: https://app.okou.ai/?settings=model",
    );
    await expect(
      failAndReadError({
        prompt: "structured invalid subscription credential failed",
        errorMessage: invalidOAuthError,
        failureReason: "reconnect_required",
        selectedModel: "claude-opus-4-8",
        configureProvider: configureClaudeCodeSubscriptionProvider,
      }),
    ).resolves.toBe(
      "Claude Code subscription authentication failed. Reconnect Claude Code in Model Providers, then retry.\n\nReconnect Claude Code: https://app.okou.ai/?settings=model",
    );
    await expect(
      failAndReadError({
        prompt: "invalid OAuth text with an Anthropic API key",
        errorMessage: invalidOAuthError,
        selectedModel: "claude-sonnet-5",
      }),
    ).resolves.toBe("Oops, something went wrong. Please try again later.");
    for (const errorMessage of [
      "Failed to authenticate. API Error: 4010 OAuth access token is invalid.",
      "Failed to authenticate. API Error: 401 OAuth access token is invalidated.",
      "Failed to authenticate. API Error: 401 OAuth access token validation is invalid.",
    ]) {
      await expect(
        failAndReadError({
          prompt: "unclassified OAuth failure",
          errorMessage,
          selectedModel: "claude-opus-4-8",
          configureProvider: configureClaudeCodeSubscriptionProvider,
        }),
      ).resolves.toBe("Oops, something went wrong. Please try again later.");
    }
    await expect(
      failAndReadError({
        prompt: "legacy callback without public brand failed for admin",
        orgRole: "admin",
        removeCallbackPublicBrand: true,
      }),
    ).resolves.toBe(
      "Claude Code could not authenticate with the configured Anthropic API key. Update or replace the API key in Model Providers, then retry.\n\nOpen Model Providers: https://app.okou.ai/?settings=model",
    );
    await expect(
      failAndReadError({
        prompt: "org key failed for member",
        orgRole: "member",
      }),
    ).resolves.toBe(
      "Claude Code could not authenticate with the configured Anthropic API key. Ask a workspace admin to update or replace the API key.\n\nShare with an admin: https://app.okou.ai/?settings=model",
    );
  }, 90_000);
});

describe("CHAT-02: auto-send after failures", () => {
  it("uses structured failed messages for normal and queued incomplete-round context", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await startChatRun(actor, {
      agentId,
      prompt: "successful structured context anchor",
      selectedModel: "claude-sonnet-5",
    });
    const anchorHeaders = await claimChatRun(runnerGroup, anchor.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorHeaders);
    await flushWaitUntilForTest();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        { type: "text", text: "structured failed request" },
        {
          type: "feedback",
          quote: "The failed response omitted the owner",
          note: [{ type: "text", text: "Name the responsible owner" }],
        },
      ],
    };
    const templatePrompt = `[Template #1: ${style.title} (illustration)]`;
    const feedbackPrompt =
      "Feedback on this part of your reply:\n\n" +
      "> The failed response omitted the owner\n\nName the responsible owner";

    const failedForNormal = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "stale failed legacy request",
      userMessage,
    });
    const failedForNormalHeaders = await claimChatRun(
      runnerGroup,
      failedForNormal.runId,
    );
    await failChatRun(
      failedForNormal.runId,
      failedForNormalHeaders,
      "structured normal context failure",
    );
    await flushWaitUntilForTest();

    const normal = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "normal incomplete context probe",
    });
    const normalContext = await waitForRunContext(actor, normal.runId);
    expect(normalContext.body.appendSystemPrompt).toContain(templatePrompt);
    expect(normalContext.body.appendSystemPrompt).toContain(feedbackPrompt);
    await api.requestCancelRun(actor, normal.runId, [200]);
    await waitForRunStatus(actor, normal.runId, "cancelled");
    await flushWaitUntilForTest();

    const failedForQueue = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "second stale failed legacy request",
      userMessage,
    });
    const failedForQueueHeaders = await claimChatRun(
      runnerGroup,
      failedForQueue.runId,
    );
    const queuedPrompt = "queued incomplete context probe";
    await queueChatEvent(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: queuedPrompt,
    });
    await failChatRun(
      failedForQueue.runId,
      failedForQueueHeaders,
      "structured queued context failure",
    );

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            chatEventDisplayText(message) === queuedPrompt &&
            message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === queuedPrompt &&
        message.runId !== undefined
      );
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued probe to be promoted");
    }
    const queuedContext = await waitForRunContext(actor, promoted.runId);
    expect(queuedContext.body.appendSystemPrompt).toContain(templatePrompt);
    expect(queuedContext.body.appendSystemPrompt).toContain(feedbackPrompt);

    await api.requestCancelRun(actor, promoted.runId, [200]);
    await waitForRunStatus(actor, promoted.runId, "cancelled");
  }, 90_000);

  it("uses the latest unrevoked successful event as the incomplete-round boundary", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const followupGate = deferredGate();
    let followupRequests = 0;

    const anchor = await startChatRun(actor, {
      agentId,
      prompt: "successful boundary anchor",
    });
    const anchorHeaders = await claimChatRun(runnerGroup, anchor.runId);
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions(async (body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("recommended follow-up messages")) {
        followupRequests += 1;
        await followupGate.wait();
        return JSON.stringify([
          { prompt: "Inspect the failed round", kind: "talk" },
        ]);
      }
      if (systemContent.includes("Generate a short, descriptive title")) {
        return "Revoked Boundary";
      }
      return "Boundary summary";
    });
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "successful boundary answer"),
    ]);
    await completeChatRunOk(anchor.runId, anchorHeaders, {
      lastEventSequence: 0,
    });
    await waitForThreadMessages(actor, anchor.threadId, (messages) => {
      return lifecycleMarkers(messages, anchor.runId, "completed").length > 0;
    });
    await expect
      .poll(() => {
        return followupRequests;
      })
      .toBe(1);

    const firstFailedPrompt = "failed before the late successful follow-up";
    const firstFailed = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: firstFailedPrompt,
    });
    const firstFailedHeaders = await claimChatRun(
      runnerGroup,
      firstFailed.runId,
    );
    await failChatRun(
      firstFailed.runId,
      firstFailedHeaders,
      "first boundary failure",
    );
    await waitForThreadMessages(actor, anchor.threadId, (messages) => {
      return lifecycleMarkers(messages, firstFailed.runId, "failed").length > 0;
    });

    followupGate.release();
    const afterFollowup = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (messages) => {
        return recommendedFollowupEvents(messages, anchor.runId).length > 0;
      },
    );
    const lateFollowup = recommendedFollowupEvents(
      afterFollowup.events,
      anchor.runId,
    )[0];
    if (!lateFollowup) {
      throw new Error("Expected the delayed recommended follow-up event");
    }
    await flushWaitUntilForTest();

    const revokingFailure = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "revoke the late successful follow-up",
      revokesEventId: lateFollowup.id,
    });
    const revokingFailureHeaders = await claimChatRun(
      runnerGroup,
      revokingFailure.runId,
    );
    await failChatRun(
      revokingFailure.runId,
      revokingFailureHeaders,
      "revoking boundary failure",
    );
    await waitForThreadMessages(actor, anchor.threadId, (messages) => {
      return (
        lifecycleMarkers(messages, revokingFailure.runId, "failed").length > 0
      );
    });

    const probe = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "probe the revoked boundary",
    });
    const probeContext = await waitForRunContext(actor, probe.runId);
    expect(probeContext.body.appendSystemPrompt).toContain(firstFailedPrompt);

    await api.requestCancelRun(actor, probe.runId, [200]);
    await waitForRunStatus(actor, probe.runId, "cancelled");
  }, 90_000);

  it("auto-sends the queued message after a failure, carrying attachments, incomplete-round context, and the continued session", async () => {
    const { actor, agentId, runnerGroup, storage } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await startChatRun(actor, {
      agentId,
      prompt: "start the session",
      selectedModel: "claude-sonnet-5",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstHeaders);
    // This journey verifies failed-run auto-send context, not overlap with the
    // successful anchor's detached terminal materialization. Drain the tracked
    // waitUntil work so later lifecycle/follow-up rows cannot move its boundary
    // after the failed run starts; callback ordering has dedicated gate coverage.
    await flushWaitUntilForTest();

    const completedFirst = await api.readRun(actor, first.runId);
    expect(completedFirst.result?.agentSessionId).toMatch(/[0-9a-f-]{36}/);

    const contextUpload = await chat.prepareUpload(actor, {
      filename: "incomplete-context.txt",
      contentType: "text/plain",
      size: 18,
    });
    storage.addObject({
      bucket: USER_ARTIFACTS_BUCKET,
      key: `artifacts/${actor.userId}/${contextUpload.id}/incomplete-context.txt`,
      size: 18,
    });
    const contextFile = await chat.completeUpload(actor, {
      id: contextUpload.id,
    });

    const longPrompt = `Refine the analysis ${"x".repeat(4200)}`;
    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: longPrompt,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: contextFile.id,
            filenameSnapshot: contextFile.filename,
            contentType: contextFile.contentType,
          },
          { type: "text", text: longPrompt },
        ],
      },
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);

    const queuedUpload = await chat.prepareUpload(actor, {
      filename: "queued-notes.txt",
      contentType: "text/plain",
      size: 11,
    });
    storage.addObject({
      bucket: USER_ARTIFACTS_BUCKET,
      key: `artifacts/${actor.userId}/${queuedUpload.id}/queued-notes.txt`,
      size: 11,
    });
    const queuedFile = await chat.completeUpload(actor, {
      id: queuedUpload.id,
    });
    const queuedContent = "queued with files";
    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued with files",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: queuedFile.id,
            filenameSnapshot: queuedFile.filename,
            contentType: queuedFile.contentType,
          },
          { type: "text", text: queuedContent },
        ],
      },
    });

    await chatCallbacks.registerPushSubscription(actor);
    chatCallbacks.enableVapid();
    const pushGate = deferredGate();
    context.mocks.webpush.sendNotification.mockImplementation(() => {
      return pushGate.wait();
    });

    context.mocks.ably.publish.mockClear();
    await failChatRun(second.runId, secondHeaders, "boom");

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.eventType === "input.prompt" &&
            chatEventDisplayText(message) === queuedContent &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(messages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          chatEventDisplayText(message) === queuedContent &&
          message.runId !== undefined
        );
      },
    );
    if (!claimed?.runId) {
      throw new Error(
        "Expected the queued message to be auto-claimed after the failure",
      );
    }
    expect(claimed.runId).not.toBe(second.runId);
    expect(claimed.userMessage?.parts).toContainEqual(
      expect.objectContaining({
        type: "file",
        fileId: queuedFile.id,
        filenameSnapshot: "queued-notes.txt",
      }),
    );
    const autoContext = await waitForRunContext(actor, claimed.runId);
    expect(autoContext.body.prompt).toContain("queued with files");
    expect(autoContext.body.prompt).toContain(
      "[Web file] queued-notes.txt (text/plain)",
    );
    expect(autoContext.body.prompt).toContain(`[ID] ${queuedFile.id}`);
    const appended = autoContext.body.appendSystemPrompt ?? "";
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended).toContain("RUN_STATUS: failed");
    expect(appended).toContain("...[truncated]");
    expect(appended).toContain(
      `[Web file] ${contextFile.filename} (${contextFile.contentType})\n   [ID] ${contextFile.id}`,
    );
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(autoContext.body.sessionId).toBe(`bdd-cli-${first.runId}`);

    pushGate.release();
    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.length;
      })
      .toBe(1);

    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued after duplicate failed callback",
    });
    const afterFailureSecondQueue = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const duplicateFailureProbeQueued = userMessages(
      afterFailureSecondQueue.events,
    ).find((message) => {
      return (
        chatEventDisplayText(message) ===
        "queued after duplicate failed callback"
      );
    });
    if (!duplicateFailureProbeQueued) {
      throw new Error("Expected the duplicate failure probe message to queue");
    }

    await failChatRun(second.runId, secondHeaders, "boom");
    await flushWaitUntilForTest();
    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.length;
      })
      .toBe(1);
    const afterDuplicateFailure = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    const duplicateFailureProbeClaimed = userMessages(
      afterDuplicateFailure.events,
    ).filter((message) => {
      return message.revokesEventId === duplicateFailureProbeQueued.id;
    });
    expect(duplicateFailureProbeClaimed).toHaveLength(0);
    const duplicateFailureProbeStillQueued = userMessages(
      afterDuplicateFailure.events,
    ).find((message) => {
      return message.id === duplicateFailureProbeQueued.id;
    });
    expect(duplicateFailureProbeStillQueued?.runId).toBeUndefined();

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("keeps only the newest 20 incomplete rounds for normal and queued callback sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await startChatRun(actor, {
      agentId,
      prompt: "successful frontier anchor",
      selectedModel: "claude-sonnet-5",
    });
    const anchorHeaders = await claimChatRun(runnerGroup, anchor.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorHeaders);
    await flushWaitUntilForTest();

    const historyPrompts = Array.from({ length: 21 }, (_, index) => {
      return `incomplete frontier history ${String(index).padStart(2, "0")}`;
    });
    for (const prompt of historyPrompts) {
      const round = await startChatRun(actor, {
        agentId,
        threadId: anchor.threadId,
        prompt,
      });
      await api.requestCancelRun(actor, round.runId, [200]);
      await waitForRunStatus(actor, round.runId, "cancelled");
    }
    await flushWaitUntilForTest();

    const normalPrompt = "normal frontier probe";
    const normal = await startChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: normalPrompt,
    });
    const normalContext = await waitForRunContext(actor, normal.runId);
    const normalAppended = normalContext.body.appendSystemPrompt ?? "";
    expect(normalAppended).toContain("# Incomplete Rounds Context");
    expect(normalAppended.match(/^- RUN_STATUS:/gm) ?? []).toHaveLength(20);
    expect(normalAppended).not.toContain(historyPrompts[0]);
    expect(normalAppended).not.toContain("successful frontier anchor");
    for (const prompt of historyPrompts.slice(1)) {
      expect(normalAppended).toContain(prompt);
    }
    const normalPositions = historyPrompts.slice(1).map((prompt) => {
      return normalAppended.indexOf(prompt);
    });
    expect(normalPositions).toStrictEqual(
      [...normalPositions].sort((left, right) => {
        return left - right;
      }),
    );

    const normalHeaders = await claimChatRun(runnerGroup, normal.runId);
    const queuedPrompt = "queued callback frontier probe";
    await queueChatEvent(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: queuedPrompt,
    });
    await failChatRun(normal.runId, normalHeaders, "frontier probe failed");

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            chatEventDisplayText(message) === queuedPrompt &&
            message.runId !== undefined
          );
        });
      },
    );
    const autoSent = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === queuedPrompt &&
        message.runId !== undefined
      );
    });
    if (!autoSent?.runId) {
      throw new Error("Expected the queued frontier probe to auto-send");
    }

    const callbackContext = await waitForRunContext(actor, autoSent.runId);
    const callbackAppended = callbackContext.body.appendSystemPrompt ?? "";
    expect(callbackAppended).toContain("# Incomplete Rounds Context");
    expect(callbackAppended.match(/^- RUN_STATUS:/gm) ?? []).toHaveLength(20);
    expect(
      callbackAppended.match(/^- RUN_STATUS: cancelled$/gm) ?? [],
    ).toHaveLength(19);
    expect(
      callbackAppended.match(/^- RUN_STATUS: failed$/gm) ?? [],
    ).toHaveLength(1);
    expect(callbackAppended).not.toContain(historyPrompts[0]);
    expect(callbackAppended).not.toContain(historyPrompts[1]);
    expect(callbackAppended).toContain(normalPrompt);
    for (const prompt of historyPrompts.slice(2)) {
      expect(callbackAppended).toContain(prompt);
    }
    const callbackPositions = [...historyPrompts.slice(2), normalPrompt].map(
      (prompt) => {
        return callbackAppended.indexOf(prompt);
      },
    );
    expect(callbackPositions).toStrictEqual(
      [...callbackPositions].sort((left, right) => {
        return left - right;
      }),
    );

    await api.requestCancelRun(actor, autoSent.runId, [200]);
    await waitForRunStatus(actor, autoSent.runId, "cancelled");
    await flushWaitUntilForTest();
  }, 90_000);
});

describe("CHAT-02: auto-send across a model switch", () => {
  it("recovers a queued message through the current same-family workspace default", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-opus-4-8",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const titlePrompts: string[] = [];
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "Working with JSON";
      }
      return "Generated summary";
    });

    const firstPrompt = `How do I parse JSON? ${"p".repeat(4200)}`;
    const first = await startChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      selectedModel: "claude-opus-4-8",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Use JSON.parse(str)."),
    ]);
    await completeChatRunOk(first.runId, firstHeaders, {
      lastEventSequence: 0,
    });

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "And stringify?",
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queued before policy removal",
    });
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Use JSON.stringify(value)."),
    ]);
    await completeChatRunOk(second.runId, secondHeaders, {
      lastEventSequence: 0,
    });

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            chatEventDisplayText(message) === "queued before policy removal" &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === "queued before policy removal" &&
        message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error(
        "Expected the queued message to be auto-claimed after policy removal",
      );
    }

    const autoContext = await waitForRunContext(actor, claimed.runId);
    const appended = autoContext.body.appendSystemPrompt ?? "";
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).not.toContain("# Incomplete Rounds Context");
    expect(autoContext.body.sessionId).toBe(`bdd-cli-${second.runId}`);
    expect(Object.keys(autoContext.body.environment)).toContain(
      "ANTHROPIC_API_KEY",
    );
    expect(autoContext.body.environment.ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );

    const thread = await chat.readThread(actor, first.threadId);
    expect(thread).not.toHaveProperty("selectedModel");
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Working with JSON");
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      threadEvents.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === first.threadId &&
          event.selectedModel === "claude-sonnet-5"
        );
      }),
    ).toHaveLength(1);

    expect(titlePrompts).toHaveLength(1);
    const initialTitlePrompt = titlePrompts[0];
    if (initialTitlePrompt === undefined) {
      throw new Error("Expected the initial send to request a thread title");
    }
    expect(initialTitlePrompt).toContain("How do I parse JSON?");
    expect(initialTitlePrompt).not.toContain("Use JSON.stringify(value).");

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);

  it("resumes the CLI session by default when the queued model stays within the same family", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
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

    const first = await startChatRun(actor, {
      agentId,
      prompt: "start on opus before queueing a Claude family switch",
      selectedModel: "claude-opus-4-8",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstHeaders);

    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "keep the opus session active",
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    await chat.updateThreadModelSelection(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );
    await queueChatEvent(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "queue a sonnet follow-up",
    });
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondHeaders);

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            chatEventDisplayText(message) === "queue a sonnet follow-up" &&
            message.runId !== undefined
          );
        });
      },
    );
    const claimed = userMessages(messages.events).find((message) => {
      return (
        chatEventDisplayText(message) === "queue a sonnet follow-up" &&
        message.runId !== undefined
      );
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queued message to be auto-claimed");
    }

    const autoContext = await waitForRunContext(actor, claimed.runId);
    expect(autoContext.body.sessionId).toBe(`bdd-cli-${second.runId}`);
    expect(autoContext.body.appendSystemPrompt ?? "").not.toContain(
      "# Web Chat Run Context",
    );
    expect(autoContext.body.environment.ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );

    await api.requestCancelRun(actor, claimed.runId, [200]);
    await waitForRunStatus(actor, claimed.runId, "cancelled");
  }, 90_000);
});

describe("CHAT-02: thread deletion while a run is active", () => {
  it("skips terminal processing when the thread is gone", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await startChatRun(actor, {
      agentId,
      prompt: "delete this thread",
    });
    await claimChatRun(runnerGroup, run.runId);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${run.threadId}`;
        });
      })
      .toBe(true);
    context.mocks.axiom.query.mockClear();
    context.mocks.ably.publish.mockClear();
    await chat.deleteThread(actor, run.threadId);
    await waitForRunStatus(actor, run.runId, "cancelled");
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
    const deletedRead = await chat.requestReadThread(
      actor,
      run.threadId,
      [404],
    );
    expect(deletedRead.status).toBe(404);
  }, 60_000);
});

describe("CHAT-02: push notification gating", () => {
  it("uses the Okou VAPID contact identity for every subscription", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    chatCallbacks.enableVapid();
    const endpoints = [
      await chatCallbacks.registerPushSubscription(actor),
      await chatCallbacks.registerPushSubscription(actor),
    ];

    const run = await startChatRun(actor, {
      agentId,
      prompt: "verify branded VAPID contacts",
    });
    chatCallbacks.mockChatOutputEvents([]);
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await completeChatRunOk(run.runId, sandboxHeaders);

    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.length;
      })
      .toBe(2);
    await flushWaitUntilForTest();

    for (const endpoint of endpoints) {
      const notification =
        context.mocks.webpush.sendNotification.mock.calls.find((call) => {
          return isRecord(call[0]) && call[0].endpoint === endpoint;
        });
      expect(notification?.[2]).toStrictEqual({
        vapidDetails: {
          subject: "mailto:contact@okou.ai",
          publicKey: "bdd-vapid-public-key",
          privateKey: "bdd-vapid-private-key",
        },
      });
    }
  }, 60_000);

  it("delivers completed run pushes once while a historical Goal remains active", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    chatCallbacks.enableVapid();
    await chatCallbacks.registerPushSubscription(actor);
    const run = await startChatRun(actor, {
      agentId,
      prompt: "complete while Goal remains active",
    });
    const goal = await seedGoalForRunFixture(run.runId, "historical objective");
    chatCallbacks.mockChatOutputEvents([]);
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await setLegacyGoalRunOriginFixture(run.runId, goal.id);
    await completeChatRunOk(run.runId, sandboxHeaders);
    await flushWaitUntilForTest();
    await completeChatRunOk(run.runId, sandboxHeaders);
    await flushWaitUntilForTest();
    expect(context.mocks.webpush.sendNotification).toHaveBeenCalledTimes(1);
    await expect(goalQueueEventIds(run.threadId)).resolves.toStrictEqual([]);
    await expect(goalRunIds(run.threadId)).resolves.toStrictEqual([run.runId]);
  }, 60_000);

  it("delivers failed run pushes while a historical Goal remains active", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await enableGoalWorkflows(actor);
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    chatCallbacks.enableVapid();
    await chatCallbacks.registerPushSubscription(actor);

    const run = await startChatRun(actor, {
      agentId,
      prompt: "fail while goal remains active",
    });
    await createGoalForRun(actor, run.runId, "pause after this failure");
    const sandboxHeaders = await claimChatRun(runnerGroup, run.runId);
    await failChatRun(run.runId, sandboxHeaders, "goal iteration failed");

    await expect
      .poll(async () => {
        return await historicalGoalStatusFixture(run.runId);
      })
      .toBe("active");
    await flushWaitUntilForTest();
    expect(context.mocks.webpush.sendNotification).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("withholds pushes without VAPID keys and deletes stale subscriptions after gone responses", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const endpoint = await chatCallbacks.registerPushSubscription(actor);

    const first = await startChatRun(actor, {
      agentId,
      prompt: "no vapid yet",
    });
    const firstHeaders = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstHeaders);

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (threadMessages) => {
        return (
          lifecycleMarkers(threadMessages, first.runId, "completed").length ===
          1
        );
      },
    );
    expect(eventBackedContents(messages.events, first.runId)).toHaveLength(0);
    expect(
      lifecycleMarkers(messages.events, first.runId, "completed"),
    ).toHaveLength(1);
    await flushWaitUntilForTest();
    expect(context.mocks.webpush.sendNotification).not.toHaveBeenCalled();

    chatCallbacks.enableVapid();
    context.mocks.webpush.sendNotification.mockRejectedValueOnce(
      new WebPushError("Gone", 410, {}, "", endpoint),
    );
    const second = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "now with vapid",
    });
    const secondHeaders = await claimChatRun(runnerGroup, second.runId);
    await completeChatRunOk(second.runId, secondHeaders);

    await expect
      .poll(() => {
        return context.mocks.webpush.sendNotification.mock.calls.length;
      })
      .toBe(1);
    expect(
      pushPayload(context.mocks.webpush.sendNotification.mock.calls[0]),
    ).toMatchObject({
      title: "now with vapid",
      body: "Your task is complete",
      url: `http://localhost:3002/chats/${first.threadId}`,
    });
    await flushWaitUntilForTest();

    const third = await startChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "after stale cleanup",
    });
    const thirdHeaders = await claimChatRun(runnerGroup, third.runId);
    await completeChatRunOk(third.runId, thirdHeaders);
    await waitForThreadMessages(actor, first.threadId, (threadMessages) => {
      return (
        lifecycleMarkers(threadMessages, third.runId, "completed").length === 1
      );
    });
    expect(context.mocks.webpush.sendNotification).toHaveBeenCalledTimes(1);
  }, 60_000);
});
