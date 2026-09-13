import {
  setHistoricalGoalStatusFixture,
  seedGoalForRunFixture,
} from "../../../test-fixtures/goal-queue";

import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import AdmZip from "adm-zip";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
  type ChatEvent,
  type ChatThreadArtifactGoogleDriveSync,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { cronProjectChatEventSearchContract } from "@okouai/api-contracts/contracts/cron";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { testChatThreadSnapshotCompactionContract } from "@okouai/api-contracts/contracts/test-chat-thread-snapshot-compaction";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { stubTestTimezone } from "../../../__tests__/env-stub";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  clearMockNow,
  mockNow,
  now,
  withMockNowForTest,
} from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  holdChatEventInsertTransactionFixture,
  insertOutputEventWithConflictingLegacyPayloadFixture,
  startChatEventInsertTransactionFixture,
} from "../../../test-fixtures/chat-events";
import {
  deleteChatThreadEventMarkerFixture,
  holdChatThreadEventInsertTransactionFixture,
  insertCanonicalOrphanChatThreadEventFixture,
  insertChatThreadEventTransactionFixture,
  readChatThreadEventIdsFixture,
  setChatThreadSnapshotBoundaryFixture,
  setChatThreadVideoModelFixture,
} from "../../../test-fixtures/chat-thread-events";

import { setAgentRunCreatedAtFixture } from "../../../test-fixtures/run-deletion";
import {
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { testChatThreadSnapshotCompactionRoutes } from "../test-chat-thread-snapshot-compaction";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import {
  createConnectorBddApi,
  mockGoogleDriveArtifactUpload,
  mockGoogleDriveConnectorOAuth,
  mockGoogleDriveFilesList,
} from "./helpers/api-bdd-connectors";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { chatEventDisplayText } from "./helpers/chat-event";
import { createRouteMocks } from "./helpers/route-test";
import { seedBuiltInDefaultModelKey } from "./helpers/runtime-state";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import {
  insertUsageEvent$,
  materializeHourlyUsage$,
} from "./helpers/usage-state";

const TEST_APP_ROUTES = Object.freeze([
  ...cronProjectChatEventSearchRoutes,
  ...chatThreadRoutes,
]);

/**
 * CHAT-01 / CHAT-03: chat thread lifecycle beyond the mutation chain that
 * lives in chat-files.bdd.test.ts — event snapshots and read state, thread
 * detail model pins, create/delete cascades, search, thread artifacts with
 * Google Drive sync status.
 *
 * Most Given state is constructed through public APIs (Stripe-webhook
 * entitlement, org model provider routes, runner heartbeat/claim, sandbox
 * report webhooks, connector OAuth flows, and skills routes).
 * Targeted database checks are kept for migration and side-effect coverage
 * where the persisted row shape is the contract under test.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const cu = createComputerUseBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const routeMocks = createRouteMocks(context);
const store = createStore();
const DAY_MS = 24 * 60 * 60 * 1000;
const FORWARD_CLEANUP_CUTOFF_MS = Date.parse("2026-08-03T05:40:26.000Z");
const FORWARD_CLEANUP_TEST_CREATED_AT = "2026-08-03T05:40:26.001Z";
const PRE_FORWARD_CLEANUP_TEST_CREATED_AT = "2026-08-03T05:40:25.999Z";

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

function authHeaders(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

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
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;

async function compactChatThreadSnapshots(
  actor: ApiTestUser,
  ...otherActors: readonly ApiTestUser[]
) {
  const client = setupApp({
    context,
    routes: testChatThreadSnapshotCompactionRoutes,
  })(testChatThreadSnapshotCompactionContract);
  const response = await accept(
    client.compact({
      body: {
        scopes: [actor, ...otherActors].map((ownedActor) => {
          if (!ownedActor.orgId) {
            throw new Error("Expected an organization-scoped snapshot actor");
          }
          return { user_id: ownedActor.userId, org_id: ownedActor.orgId };
        }),
      },
    }),
    [200],
  );
  return response.body;
}

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
}

type EntitledChatActorWithoutRunner = Omit<EntitledChatActor, "runnerGroup">;

async function entitledChatActorWithoutRunner(
  displayName: string,
): Promise<EntitledChatActorWithoutRunner> {
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, providerId };
}

async function entitledChatActor(
  displayName: string,
): Promise<EntitledChatActor> {
  const runnerGroup = api.configureRunnerGroup();
  return {
    ...(await entitledChatActorWithoutRunner(displayName)),
    runnerGroup,
  };
}

async function sendChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
    readonly chatThreadSortEventId?: string;
    readonly model?: SupportedRunModel;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{
  readonly claim: RunnerClaim;
  readonly sandboxHeaders: { readonly authorization: string };
}> {
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(runId);
  return {
    claim,
    sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
  };
}

/** Sandbox-scoped Okou token issued to the run, exposed via the claim env. */
function okouTokenFromClaim(claim: RunnerClaim): string {
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error(
      "Expected the claim platform environment to carry an OKOU_TOKEN",
    );
  }
  return token;
}

async function waitForThreadMessages(
  actor: ApiTestUser,
  threadId: string,
  predicate: (messages: readonly ChatEvent[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadEvents>> | undefined;
  await expect
    .poll(async () => {
      page = await chat.listThreadEvents(actor, threadId);
      return predicate(page.events);
    })
    .toBe(true);
  if (!page) {
    throw new Error(`Expected chat thread ${threadId} messages to be readable`);
  }
  return page;
}

async function waitForThreadEvents(
  actor: ApiTestUser,
  threadId: string,
  predicate: (events: readonly ChatEvent[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadEvents>> | undefined;
  await expect
    .poll(async () => {
      page = await chat.listThreadEvents(actor, threadId);
      return predicate(page.events);
    })
    .toBe(true);
  if (!page) {
    throw new Error(`Expected chat thread ${threadId} events to be readable`);
  }
  return page;
}

async function waitForRunStatus(
  actor: ApiTestUser,
  runId: string,
  status: "cancelled" | "completed" | "failed" | "pending" | "running",
): Promise<void> {
  await expect
    .poll(async () => {
      const run = await api.readRun(actor, runId);
      return run.status;
    })
    .toBe(status);
}

/**
 * Checkpoint + exitCode-0 complete (completing without a checkpoint fails the
 * run).
 */
async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
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
    .update(`bdd chat thread history ${runId}`)
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
      ...(stagedOutputEvents.length === 0
        ? {}
        : {
            lastEventSequence: Math.max(
              ...stagedOutputEvents.map((event) => {
                return event.sequenceNumber;
              }),
            ),
          }),
    },
    sandboxHeaders,
    [200],
  );
}

async function cancelChatRun(actor: ApiTestUser, runId: string): Promise<void> {
  await api.requestCancelRun(actor, runId, [200]);
  await waitForRunStatus(actor, runId, "cancelled");
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

type UsageRecordedEvent = Extract<ChatEvent, { eventType: "usage.recorded" }>;

async function usageEventsForRun(
  actor: ApiTestUser,
  threadId: string,
  runId: string,
): Promise<UsageRecordedEvent[]> {
  const page = await chat.listThreadEvents(actor, threadId);
  return page.events.filter((event): event is UsageRecordedEvent => {
    return event.eventType === "usage.recorded" && event.runId === runId;
  });
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

async function threadEventPage(actor: ApiTestUser, sinceSeqId?: number) {
  const response = await chat.requestThreadEvents(
    actor,
    sinceSeqId === undefined ? {} : { sinceSeqId },
    [200],
  );
  expect(response.status).toBe(200);
  if (response.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }
  return response.body;
}

async function expectExpiredThreadEventCursor(
  actor: ApiTestUser,
  sinceSeqId: number,
): Promise<void> {
  const response = await chat.requestThreadEvents(actor, { sinceSeqId }, [410]);
  expect(response.body).toStrictEqual({
    error: {
      message: "Chat thread events cursor has expired",
      code: "CHAT_THREAD_EVENTS_EXPIRED",
    },
  });
}

async function allThreadEvents(actor: ApiTestUser) {
  return (await threadEventPage(actor)).events;
}

async function createSnapshotCursorScenario(label: string) {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped chat actor");
  }
  const { providerId } = await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: `${label} agent`,
  });
  const firstEventId = randomUUID();
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `${label} thread`,
    eventId: firstEventId,
  });
  const markerEventId = randomUUID();
  await chat.renameThread(actor, thread.id, `${label} marker`, markerEventId);

  const events = await allThreadEvents(actor);
  const firstEvent = events.find((event) => {
    return event.id === firstEventId;
  });
  const markerEvent = events.find((event) => {
    return event.id === markerEventId;
  });
  if (!firstEvent || !markerEvent) {
    throw new Error("Expected snapshot cursor lifecycle events");
  }

  await compactChatThreadSnapshots(actor);
  const snapshot = await chat.getThreadSnapshot(actor);
  const { latestEventId, latestSeqId } = snapshot;
  expect(latestEventId).toBe(markerEvent.id);
  expect(latestSeqId).toBe(markerEvent.seqId);
  if (latestEventId === null || latestSeqId === null) {
    throw new Error("Expected a non-empty snapshot cursor");
  }
  return {
    actor,
    orgId: actor.orgId,
    providerId,
    agent,
    thread,
    firstEvent,
    snapshot: { latestEventId, latestSeqId },
  };
}

async function deleteSnapshotCursorMarker(
  scenario: Awaited<ReturnType<typeof createSnapshotCursorScenario>>,
): Promise<void> {
  await deleteChatThreadEventMarkerFixture({
    userId: scenario.actor.userId,
    orgId: scenario.orgId,
    eventId: scenario.snapshot.latestEventId,
    seqId: scenario.snapshot.latestSeqId,
  });
}

type ThreadArtifacts = Awaited<ReturnType<typeof chat.listThreadArtifacts>>;

function expectDriveStatuses(
  artifacts: ThreadArtifacts,
  expected: ChatThreadArtifactGoogleDriveSync,
): void {
  const files = artifacts.runs.flatMap((run) => {
    return run.files;
  });
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(file.googleDriveSync).toStrictEqual(expected);
  }
}

/** Cheapest visible message writer: the no-credit send persists a searchable
 * user row plus a non-searchable output.error without creating a run. */
type NoCreditMessageBody = {
  readonly agentId: string;
  readonly threadId?: string;
  readonly prompt: string;
  readonly userMessage?: UserMessageInputDocument;
};

async function sendNoCreditMessageResult(
  actor: ApiTestUser,
  body: NoCreditMessageBody,
): Promise<{ readonly threadId: string; readonly createdAt: number }> {
  await api.ensureOrgModelProvider(actor);
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (
    sent.status !== 201 ||
    sent.body.runId !== null ||
    sent.body.createdAt === undefined
  ) {
    throw new Error("Expected a no-credit send without a run");
  }
  const createdAt = Date.parse(sent.body.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new Error("Expected the no-credit send to return a timestamp");
  }
  return { threadId: sent.body.threadId, createdAt };
}

async function sendNoCreditMessage(
  actor: ApiTestUser,
  body: NoCreditMessageBody,
): Promise<string> {
  return (await sendNoCreditMessageResult(actor, body)).threadId;
}

async function advanceNoCreditMessageCreatedAt(
  actor: ApiTestUser,
  agentId: string,
  after: number,
): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const filler = await sendNoCreditMessageResult(actor, {
      agentId,
      prompt: `timestamp boundary ${randomUUID()}`,
    });
    if (filler.createdAt > after) {
      return filler.createdAt;
    }
  }
  throw new Error("Expected the chat API timestamp to advance");
}

/**
 * Runs a full chat run (send, runner claim, checkpoint + complete) so the
 * thread gains its run-finished marker through the production callback path.
 */
async function completeChatRunInThread(
  actor: ApiTestUser,
  runnerGroup: string,
  args: {
    readonly agentId: string;
    readonly threadId?: string;
    readonly prompt: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const run = await sendChatRun(actor, {
    agentId: args.agentId,
    ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
    prompt: args.prompt,
  });
  const { sandboxHeaders } = await claimChatRun(runnerGroup, run.runId);
  chatCallbacks.mockChatOutputEvents([]);
  await completeChatRunOk(run.runId, sandboxHeaders);
  await flushWaitUntilForTest();
  await waitForThreadEvents(actor, run.threadId, (events) => {
    return events.some((event) => {
      return event.runId === run.runId && event.eventType === "run.completed";
    });
  });
  return run;
}

const CHAT_THREAD_READ_CAPABILITIES = [
  "chat-thread:read",
] as const satisfies readonly Capability[];

function okouCapabilityHeaders(
  actor: ApiTestUser,
  runId: string,
  capabilities: readonly Capability[],
): { readonly authorization: string } {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor for Okou run authentication");
  }
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId,
      capabilities: [...capabilities],
      iat: seconds,
      exp: seconds + 600,
    })}`,
  };
}

/** Construct historical state without exposing a live Goal API. */
async function createThreadGoal(
  _actor: ApiTestUser,
  runId: string,
  objective: string,
): Promise<void> {
  await seedGoalForRunFixture(runId, objective);
}

async function completeThreadGoal(
  actor: ApiTestUser,
  runId: string,
): Promise<void> {
  await setHistoricalGoalStatusFixture(runId, "complete");
}

const malformedChatThreadIdRequests = [
  { method: "GET", path: "/api/chat-threads/:id", paramName: "id" },
  { method: "PATCH", path: "/api/chat-threads/:id", paramName: "id" },
  { method: "DELETE", path: "/api/chat-threads/:id", paramName: "id" },
  {
    method: "POST",
    path: "/api/chat-threads/:id/mark-read",
    paramName: "id",
  },
  {
    method: "POST",
    path: "/api/chat-threads/:id/mark-unread",
    paramName: "id",
  },
  {
    method: "POST",
    path: "/api/chat-threads/:id/model-selection",
    paramName: "id",
  },
  {
    method: "POST",
    path: "/api/chat-threads/:id/computer-use-host",
    paramName: "id",
  },
  { method: "POST", path: "/api/chat-threads/:id/pin", paramName: "id" },
  {
    method: "POST",
    path: "/api/chat-threads/:id/unpin",
    paramName: "id",
  },
  {
    method: "POST",
    path: "/api/chat-threads/:id/rename",
    paramName: "id",
  },
  {
    method: "GET",
    path: "/api/chat-threads/:id/artifacts",
    paramName: "threadId",
  },
  {
    method: "POST",
    path: "/api/chat-threads/:id/artifacts",
    paramName: "threadId",
  },
] as const;

describe("CHAT-01 thread detail, create, and delete cascades", () => {
  it("preserves model settings through snapshot compaction and patch replay", async () => {
    const { actor, providerId, thread } =
      await createSnapshotCursorScenario("Effort snapshot");
    await createBillingMediaApi(context).updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    });
    await api.updateOrgModelPolicies(actor, [
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
    await chat.updateThreadModelSelection(actor, thread.id, "claude-sonnet-5", {
      reasoningEffort: "high",
    });
    await compactChatThreadSnapshots(actor);
    const snapshot = await chat.getThreadSnapshot(actor);
    expect(snapshot.chatThreads).toContainEqual(
      expect.objectContaining({
        id: thread.id,
        modelSettings: { "claude-sonnet-5": { effort: "high" } },
      }),
    );
    if (snapshot.latestSeqId === null) {
      throw new Error("Expected snapshot cursor");
    }
    await chat.updateThreadModelSelection(actor, thread.id, "claude-opus-4-8", {
      reasoningEffort: "extra",
    });
    const events = await threadEventPage(actor, snapshot.latestSeqId);
    expect(
      replayChatThreadEvents(snapshot.chatThreads, events.events),
    ).toContainEqual(
      expect.objectContaining({
        id: thread.id,
        selectedModel: "claude-opus-4-8",
        modelSettings: {
          "claude-sonnet-5": { effort: "high" },
          "claude-opus-4-8": { effort: "extra" },
        },
      }),
    );
    await compactChatThreadSnapshots(actor);
    expect((await chat.getThreadSnapshot(actor)).chatThreads).toContainEqual(
      expect.objectContaining({
        id: thread.id,
        modelSettings: {
          "claude-sonnet-5": { effort: "high" },
          "claude-opus-4-8": { effort: "extra" },
        },
      }),
    );
  });

  it("rejects malformed thread ids before auth and unauthenticated clerk bearers", async () => {
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });

    for (const request of malformedChatThreadIdRequests) {
      const response = await app.request(request.path, {
        method: request.method,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        readonly error: { readonly code: string; readonly message: string };
      };
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain(request.paramName);
    }

    // A bearer that Clerk reports as unauthenticated is a plain 401, not a
    // crash on the session fall-through branch.
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const unauthenticated = await app.request("/api/chat-threads/snapshot", {
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(unauthenticated.status).toBe(401);
    const unauthenticatedBody = (await unauthenticated.json()) as {
      readonly error: { readonly code: string };
    };
    expect(unauthenticatedBody.error.code).toBe("UNAUTHORIZED");
  });

  it("allows chat-thread read agent tokens to sync snapshots and events", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await api.ensureOrgModelProvider(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          role: actor.orgRole ?? "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ],
    });
    const apiClient = setupApp({ context, routes: chatThreadRoutes })(
      chatThreadsContract,
    );
    const okouHeaders = okouCapabilityHeaders(
      actor,
      randomUUID(),
      CHAT_THREAD_READ_CAPABILITIES,
    );

    const snapshot = await accept(
      apiClient.snapshot({ headers: okouHeaders }),
      [200],
    );
    expect(snapshot.body).toStrictEqual({
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });
    const events = await accept(
      apiClient.events({ headers: okouHeaders, query: {} }),
      [200],
    );
    expect(events.body).toStrictEqual({
      events: [],
      hasMore: false,
    });

    const missingCapability = await accept(
      apiClient.snapshot({
        headers: okouCapabilityHeaders(actor, randomUUID(), ["file:write"]),
      }),
      [403],
    );
    expect(missingCapability.body).toStrictEqual({
      error: {
        message: "Missing required capability: chat-thread:read",
        code: "FORBIDDEN",
      },
    });
  });

  it("rejects thread creation for unknown, cross-org, and org-less callers", async () => {
    const unauthenticated = await chat.requestCreateThread(
      null,
      { agentId: randomUUID(), title: "no session" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const outsider = bdd.user();
    bdd.acceptAgentStorageWrites();
    const foreignAgent = await bdd.createAgent(outsider, {
      displayName: "Foreign-org compose agent",
    });

    const actor = bdd.user();
    const missing = await chat.requestCreateThread(
      actor,
      { agentId: randomUUID(), title: "missing compose" },
      [404],
    );
    expectApiError(missing.body);
    expect(missing.body.error).toStrictEqual({
      message: "Agent not found",
      code: "NOT_FOUND",
    });

    const crossOrg = await chat.requestCreateThread(
      actor,
      { agentId: foreignAgent.agentId, title: "hijacked" },
      [404],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.message).toBe("Agent not found");

    // Thread creation now resolves the model route up front, so callers must
    // have an active organization before body-level compose lookup runs.
    const orgless = bdd.user({ orgId: null });
    const noOrg = await chat.requestCreateThread(
      orgless,
      { agentId: foreignAgent.agentId, title: "no org" },
      [401],
    );
    expectApiError(noOrg.body);
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");

    // The foreign agent's event stream is unaffected by the rejected creates.
    expect(
      (await allThreadEvents(outsider)).some((event) => {
        return event.agentId === foreignAgent.agentId;
      }),
    ).toBeFalsy();
  });

  it("returns chat thread snapshot and lifecycle events with cursor expiry", async () => {
    const actor = bdd.user();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Thread event sourcing agent",
    });
    const createEventId = randomUUID();
    const renameEventId = randomUUID();
    const modelSelectionEventId = randomUUID();

    const emptySnapshot = await chat.getThreadSnapshot(actor);
    expect(emptySnapshot).toStrictEqual({
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });

    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Initial event title",
      eventId: createEventId,
    });
    await chat.renameThread(
      actor,
      thread.id,
      "Renamed event title",
      renameEventId,
    );
    await chat.updateThreadModelSelection(actor, thread.id, "claude-sonnet-5", {
      eventId: modelSelectionEventId,
    });

    const allEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(allEvents.status).toBe(200);
    if (allEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(allEvents.body.hasMore).toBeFalsy();
    expect(allEvents.body.events).toHaveLength(4);
    expect(
      allEvents.body.events.map((event) => {
        return event.seqId;
      }),
    ).toStrictEqual([1, 2, 3, 4]);
    expect(allEvents.body.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createEventId,
          kind: "created",
          chatThreadId: thread.id,
          agentId: agent.agentId,
          title: "Initial event title",
          createdAt: expect.any(String),
        }),
        expect.objectContaining({
          id: renameEventId,
          kind: "renamed",
          chatThreadId: thread.id,
          agentId: agent.agentId,
          title: "Renamed event title",
          createdAt: expect.any(String),
        }),
        expect.objectContaining({
          id: modelSelectionEventId,
          kind: "model_selection_updated",
          chatThreadId: thread.id,
          agentId: agent.agentId,
          title: null,
          selectedModel: "claude-sonnet-5",
          createdAt: expect.any(String),
        }),
        expect.objectContaining({
          kind: "service_tier_updated",
          chatThreadId: thread.id,
          agentId: agent.agentId,
          serviceTier: null,
          createdAt: expect.any(String),
        }),
      ]),
    );

    const modelSelectionEvent = allEvents.body.events.find((event) => {
      return event.id === modelSelectionEventId;
    });
    const serviceTierEvent = allEvents.body.events.find((event) => {
      return event.kind === "service_tier_updated";
    });
    if (
      !modelSelectionEvent ||
      modelSelectionEvent.seqId === undefined ||
      !serviceTierEvent ||
      serviceTierEvent.seqId === undefined
    ) {
      throw new Error("Expected model selection event pair");
    }
    expect(serviceTierEvent.createdAt).toBe(modelSelectionEvent.createdAt);
    expect(serviceTierEvent.seqId).toBe(modelSelectionEvent.seqId + 1);
    const afterCollidingTimestamp = await chat.requestThreadEvents(
      actor,
      { sinceSeqId: modelSelectionEvent.seqId },
      [200],
    );
    expect(afterCollidingTimestamp.status).toBe(200);
    if (afterCollidingTimestamp.status !== 200) {
      throw new Error("Expected colliding timestamp cursor page to load");
    }
    expect(afterCollidingTimestamp.body.events).toStrictEqual([
      serviceTierEvent,
    ]);

    const createEvent = allEvents.body.events.find((event) => {
      return event.id === createEventId;
    });
    if (!createEvent) {
      throw new Error("Expected created thread event");
    }

    const afterCreate = await chat.requestThreadEvents(
      actor,
      { sinceSeqId: createEvent.seqId },
      [200],
    );
    expect(afterCreate.status).toBe(200);
    if (afterCreate.status !== 200) {
      throw new Error("Expected chat thread events after cursor to load");
    }
    expect(afterCreate.body.events).toHaveLength(3);
    expect(afterCreate.body.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: renameEventId }),
        expect.objectContaining({ id: modelSelectionEventId }),
        expect.objectContaining({ kind: "service_tier_updated" }),
      ]),
    );

    const expired = await chat.requestThreadEvents(
      actor,
      { sinceSeqId: 999_999 },
      [410],
    );
    expect(expired.body).toStrictEqual({
      error: {
        message: "Chat thread events cursor has expired",
        code: "CHAT_THREAD_EVENTS_EXPIRED",
      },
    });
  });

  it("keeps no-snapshot cursors anchored to real scoped rows", async () => {
    const actor = bdd.user();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "No-snapshot cursor agent",
    });
    const firstEventId = randomUUID();
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "No-snapshot cursor thread",
      eventId: firstEventId,
    });
    const [firstEvent] = await allThreadEvents(actor);
    if (!firstEvent || firstEvent.id !== firstEventId) {
      throw new Error("Expected the initial chat-thread lifecycle event");
    }

    await expect(
      threadEventPage(actor, firstEvent.seqId),
    ).resolves.toStrictEqual({ events: [], hasMore: false });

    // Reusing the event ID commits the reserved sequence without inserting a
    // second event, matching an allocation gap from a failed/idempotent write.
    await chat.renameThread(
      actor,
      thread.id,
      "Reserve a lifecycle event gap",
      firstEventId,
    );
    await expectExpiredThreadEventCursor(actor, firstEvent.seqId + 1);
  });

  it("reads retained and exact markerless snapshot cursors atomically", async () => {
    const scenario = await createSnapshotCursorScenario("Markerless cursor");
    const { actor, agent, firstEvent, snapshot, thread } = scenario;

    await expect(
      threadEventPage(actor, firstEvent.seqId),
    ).resolves.toStrictEqual({
      events: [expect.objectContaining({ id: snapshot.latestEventId })],
      hasMore: false,
    });
    await deleteSnapshotCursorMarker(scenario);

    const held = await holdChatThreadEventInsertTransactionFixture({
      userId: actor.userId,
      orgId: scenario.orgId,
      chatThreadId: thread.id,
      agentId: agent.agentId,
      title: "Committed after the snapshot cursor read",
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });

    await expect(
      threadEventPage(actor, snapshot.latestSeqId),
    ).resolves.toStrictEqual({ events: [], hasMore: false });

    held.release();
    await held.done;
    await expect(
      threadEventPage(actor, snapshot.latestSeqId),
    ).resolves.toStrictEqual({
      events: [expect.objectContaining({ id: held.event.id })],
      hasMore: false,
    });
  });

  it("validates real cursors after a markerless snapshot watermark", async () => {
    const scenario = await createSnapshotCursorScenario("Real cursor");
    const { actor, snapshot, thread } = scenario;
    await deleteSnapshotCursorMarker(scenario);

    const laterEventId = randomUUID();
    await chat.renameThread(
      actor,
      thread.id,
      "Later real lifecycle event",
      laterEventId,
    );
    const afterSnapshotCursor = await threadEventPage(
      actor,
      snapshot.latestSeqId,
    );
    const [laterEvent] = afterSnapshotCursor.events;
    if (!laterEvent || laterEvent.id !== laterEventId) {
      throw new Error("Expected the later lifecycle event");
    }
    expect(afterSnapshotCursor.hasMore).toBeFalsy();

    await chat.renameThread(
      actor,
      thread.id,
      "Reserve a post-snapshot gap",
      laterEventId,
    );
    const postSnapshotGapSeqId = laterEvent.seqId + 1;
    await expectExpiredThreadEventCursor(actor, postSnapshotGapSeqId);

    const nextRealEventId = randomUUID();
    await chat.renameThread(
      actor,
      thread.id,
      "Real event after the allocation gap",
      nextRealEventId,
    );
    const afterLaterCursor = await threadEventPage(actor, laterEvent.seqId);
    const [nextRealEvent] = afterLaterCursor.events;
    if (!nextRealEvent || nextRealEvent.id !== nextRealEventId) {
      throw new Error("Expected the real lifecycle event after the gap");
    }
    expect(nextRealEvent.seqId).toBe(postSnapshotGapSeqId + 1);
    expect(afterLaterCursor.hasMore).toBeFalsy();

    await expect(
      threadEventPage(actor, nextRealEvent.seqId),
    ).resolves.toStrictEqual({
      events: [],
      hasMore: false,
    });

    const peer = bdd.user({ orgId: scenario.orgId });
    const peerAgent = await bdd.createAgent(peer, {
      displayName: "Cross-user cursor agent",
    });
    await chat.createThread(peer, {
      agentId: peerAgent.agentId,
      title: "Cross-user cursor thread",
    });
    await expectExpiredThreadEventCursor(peer, nextRealEvent.seqId);

    const otherOrgActor = bdd.user({ userId: actor.userId });
    await api.ensureOrgModelProvider(otherOrgActor);
    const otherOrgAgent = await bdd.createAgent(otherOrgActor, {
      displayName: "Cross-organization cursor agent",
    });
    await chat.createThread(otherOrgActor, {
      agentId: otherOrgAgent.agentId,
      title: "Cross-organization cursor thread",
    });
    await expectExpiredThreadEventCursor(otherOrgActor, nextRealEvent.seqId);
    await expectExpiredThreadEventCursor(actor, 999_999);
  });

  it("paginates a markerless snapshot tail without gaps or duplicates", async () => {
    const scenario = await createSnapshotCursorScenario("Paginated cursor");
    const { actor, snapshot, thread } = scenario;
    await deleteSnapshotCursorMarker(scenario);
    const lifecyclePageSize = 1000;
    const paginationEvents = Array.from(
      { length: lifecyclePageSize + 1 },
      (_, index) => {
        return {
          id: randomUUID(),
          title: `Pagination lifecycle event ${index}`,
        };
      },
    );
    await Promise.all(
      paginationEvents.map(async (event) => {
        await chat.renameThread(actor, thread.id, event.title, event.id);
      }),
    );

    const firstPage = await threadEventPage(actor, snapshot.latestSeqId);
    expect(firstPage.events).toHaveLength(lifecyclePageSize);
    expect(firstPage.hasMore).toBeTruthy();
    const firstPageCursor = firstPage.events.at(-1);
    if (!firstPageCursor) {
      throw new Error("Expected the first snapshot tail page cursor");
    }

    const secondPage = await threadEventPage(actor, firstPageCursor.seqId);
    expect(secondPage.events).toHaveLength(1);
    expect(secondPage.hasMore).toBeFalsy();

    const pagedEvents = [...firstPage.events, ...secondPage.events];
    const pagedSeqIds = pagedEvents.map((event) => {
      return event.seqId;
    });
    expect(pagedSeqIds).toStrictEqual(
      [...pagedSeqIds].sort((left, right) => {
        return left - right;
      }),
    );
    const pagedEventIds = pagedEvents.map((event) => {
      return event.id;
    });
    const expectedTailEventIds = paginationEvents.map((event) => {
      return event.id;
    });
    expect(new Set(pagedEventIds).size).toBe(expectedTailEventIds.length);
    expect([...pagedEventIds].sort()).toStrictEqual(
      [...expectedTailEventIds].sort(),
    );
  }, 90_000);

  it("keeps markerless snapshot watermarks monotonic across stale projection refresh", async () => {
    const snapshotAt = now();
    mockNow(snapshotAt);
    const scenario = await createSnapshotCursorScenario(
      "Monotonic markerless compaction",
    );
    const { actor, firstEvent, thread } = scenario;
    const removedAgent = await bdd.createAgent(actor, {
      displayName: "Removed snapshot projection agent",
    });
    const removedThreadEventId = randomUUID();
    const removedThread = await chat.createThread(actor, {
      agentId: removedAgent.agentId,
      title: "Removed snapshot projection thread",
      eventId: removedThreadEventId,
    });

    await compactChatThreadSnapshots(actor);
    const boundary = await chat.getThreadSnapshot(actor);
    expect(boundary.latestEventId).toBe(removedThreadEventId);
    expect(boundary.chatThreads).toContainEqual(
      expect.objectContaining({ id: removedThread.id }),
    );
    if (boundary.latestEventId === null || boundary.latestSeqId === null) {
      throw new Error("Expected the advanced snapshot boundary");
    }

    // Reusing an older retained event ID reserves a sequence but inserts no
    // event. The live thread still changes, giving stale compaction a
    // projection-only update to apply without treating the allocator gap as a
    // cursor boundary.
    await chat.renameThread(
      actor,
      thread.id,
      "Projection refreshed without a lifecycle event",
      firstEvent.id,
    );
    for (const event of [
      firstEvent,
      {
        id: scenario.snapshot.latestEventId,
        seqId: scenario.snapshot.latestSeqId,
      },
      { id: boundary.latestEventId, seqId: boundary.latestSeqId },
    ]) {
      await deleteChatThreadEventMarkerFixture({
        userId: actor.userId,
        orgId: scenario.orgId,
        eventId: event.id,
        seqId: event.seqId,
      });
    }
    chat.mockObjectStorageObjectsExist();
    await authOrg.deleteAgent(actor, removedAgent.agentId);
    await expect(
      threadEventPage(actor, boundary.latestSeqId),
    ).resolves.toStrictEqual({ events: [], hasMore: false });

    const unrelatedActor = bdd.user();
    const unrelatedAgent = await bdd.createAgent(unrelatedActor, {
      displayName: "Unrelated snapshot compaction agent",
    });
    await chat.createThread(unrelatedActor, {
      agentId: unrelatedAgent.agentId,
      title: "Unrelated event arriving before stale compaction",
    });

    mockNow(snapshotAt + DAY_MS + 1);
    const staleCompact = await compactChatThreadSnapshots(actor);
    expect(staleCompact.eventsApplied).toBe(0);
    expect(staleCompact.removedDeletedAgentThreads).toBeGreaterThanOrEqual(1);
    await expect(chat.getThreadSnapshot(unrelatedActor)).resolves.toStrictEqual(
      {
        chatThreads: [],
        latestEventId: null,
        latestSeqId: null,
      },
    );
    const preserved = await chat.getThreadSnapshot(actor);
    expect({
      latestEventId: preserved.latestEventId,
      latestSeqId: preserved.latestSeqId,
    }).toStrictEqual({
      latestEventId: boundary.latestEventId,
      latestSeqId: boundary.latestSeqId,
    });
    expect(preserved.chatThreads).toContainEqual(
      expect.objectContaining({
        id: thread.id,
        title: "Projection refreshed without a lifecycle event",
      }),
    );
    expect(
      preserved.chatThreads.some((entry) => {
        return entry.id === removedThread.id;
      }),
    ).toBeFalsy();
    await expect(
      readChatThreadEventIdsFixture({
        userId: actor.userId,
        orgId: scenario.orgId,
        eventIds: [
          firstEvent.id,
          scenario.snapshot.latestEventId,
          boundary.latestEventId,
        ],
      }),
    ).resolves.toStrictEqual([]);

    const laterEventId = randomUUID();
    await chat.renameThread(
      actor,
      thread.id,
      "Real lifecycle event after allocator gap",
      laterEventId,
    );
    const markerlessTail = await threadEventPage(actor, boundary.latestSeqId);
    expect(markerlessTail).toStrictEqual({
      events: [expect.objectContaining({ id: laterEventId })],
      hasMore: false,
    });
    const [laterEvent] = markerlessTail.events;
    if (!laterEvent) {
      throw new Error("Expected the real event after the allocator gap");
    }
    expect(laterEvent.seqId).toBe(boundary.latestSeqId + 2);
    await expectExpiredThreadEventCursor(actor, firstEvent.seqId);

    const advancedCompact = await compactChatThreadSnapshots(actor);
    expect(advancedCompact.eventsApplied).toBeGreaterThanOrEqual(1);
    const advanced = await chat.getThreadSnapshot(actor);
    expect({
      latestEventId: advanced.latestEventId,
      latestSeqId: advanced.latestSeqId,
    }).toStrictEqual({
      latestEventId: laterEvent.id,
      latestSeqId: laterEvent.seqId,
    });

    await compactChatThreadSnapshots(actor);
    const repeated = await chat.getThreadSnapshot(actor);
    expect({
      latestEventId: repeated.latestEventId,
      latestSeqId: repeated.latestSeqId,
    }).toStrictEqual({
      latestEventId: laterEvent.id,
      latestSeqId: laterEvent.seqId,
    });
  }, 90_000);

  it("isolates snapshot refresh and retention by both user and organization", async () => {
    const createdAt = now();
    mockNow(createdAt);
    const actor = bdd.user();
    const otherOrg = bdd.user({ userId: actor.userId });
    const otherUser = bdd.user({ orgId: actor.orgId });
    const fixtures = [];
    for (const owner of [actor, otherOrg, otherUser]) {
      const agent = await bdd.createAgent(owner, {
        displayName: "Scoped snapshot retention agent",
      });
      const createdEventId = randomUUID();
      const thread = await chat.createThread(owner, {
        agentId: agent.agentId,
        title: "Before scoped compaction",
        eventId: createdEventId,
      });
      fixtures.push({
        owner,
        thread,
        createdEventId,
        renamedEventId: randomUUID(),
      });
    }
    await compactChatThreadSnapshots(actor, otherOrg, otherUser);

    for (const fixture of fixtures) {
      await chat.renameThread(
        fixture.owner,
        fixture.thread.id,
        "After scoped compaction",
        fixture.renamedEventId,
      );
    }

    mockNow(createdAt + 8 * DAY_MS);
    await expect(compactChatThreadSnapshots(actor)).resolves.toStrictEqual({
      success: true,
      scopes: 1,
      eventsApplied: 1,
      removedDeletedAgentThreads: 0,
      eventsPruned: 2,
    });
    for (const fixture of fixtures) {
      const selected = fixture.owner === actor;
      const snapshot = await chat.getThreadSnapshot(fixture.owner);
      expect(snapshot.latestEventId).toBe(
        selected ? fixture.renamedEventId : fixture.createdEventId,
      );
      expect(snapshot.chatThreads).toStrictEqual([
        expect.objectContaining({
          id: fixture.thread.id,
          title: selected
            ? "After scoped compaction"
            : "Before scoped compaction",
        }),
      ]);
      const events = await allThreadEvents(fixture.owner);
      expect(
        events.map((event) => {
          return event.id;
        }),
      ).toStrictEqual(
        selected ? [] : [fixture.createdEventId, fixture.renamedEventId],
      );
    }
  });

  it("rejects snapshot compaction test requests in production", async () => {
    mockEnv("ENV", "production");
    const client = setupApp({
      context,
      routes: testChatThreadSnapshotCompactionRoutes,
    })(testChatThreadSnapshotCompactionContract);
    const response = await client.compact({
      body: {
        scopes: [
          { user_id: `user_${randomUUID()}`, org_id: `org_${randomUUID()}` },
        ],
      },
    });
    expect(response.status).toBe(404);
  });

  it("rejects snapshot compaction without explicitly owned scopes", async () => {
    const client = setupApp({
      context,
      routes: testChatThreadSnapshotCompactionRoutes,
    })(testChatThreadSnapshotCompactionContract);
    const response = await client.compact({ body: { scopes: [] } });
    expect(response.status).toBe(400);
  });

  it("prunes covered lifecycle events in retry-safe deterministic batches", async () => {
    mockOptionalEnv("CHAT_THREAD_EVENT_PRUNE_BATCH_SIZE", "2");
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped retention actor");
    }
    await api.ensureOrgModelProvider(actor);
    const liveAgent = await bdd.createAgent(actor, {
      displayName: "Bounded retention live agent",
    });
    const deletedAgent = await bdd.createAgent(actor, {
      displayName: "Bounded retention deleted agent",
    });
    const liveThread = await chat.createThread(actor, {
      agentId: liveAgent.agentId,
      title: "Bounded retention live thread",
    });
    const deletedThread = await chat.createThread(actor, {
      agentId: liveAgent.agentId,
      title: "Bounded retention deleted thread",
    });
    const deletedAgentThread = await chat.createThread(actor, {
      agentId: deletedAgent.agentId,
      title: "Bounded retention deleted Agent thread",
    });
    const retentionCutoff = Date.parse("1800-01-01T00:00:00.000Z");
    const retainedAtBoundary = new Date(retentionCutoff);

    const liveCovered = await insertChatThreadEventTransactionFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      chatThreadId: liveThread.id,
      agentId: liveAgent.agentId,
      title: "First covered retention event",
      createdAt: retainedAtBoundary,
    });
    const deletedThreadCovered = await insertChatThreadEventTransactionFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      chatThreadId: deletedThread.id,
      agentId: liveAgent.agentId,
      title: "Covered event for a deleted thread",
      createdAt: retainedAtBoundary,
    });
    const deletedAgentCovered = await insertChatThreadEventTransactionFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      chatThreadId: deletedAgentThread.id,
      agentId: deletedAgent.agentId,
      title: "Covered event for a deleted Agent",
      createdAt: retainedAtBoundary,
    });
    const secondLiveCovered = await insertChatThreadEventTransactionFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      chatThreadId: liveThread.id,
      agentId: liveAgent.agentId,
      title: "Second covered retention event",
      createdAt: retainedAtBoundary,
    });

    await chat.deleteThread(actor, deletedThread.id);
    chat.mockObjectStorageObjectsExist();
    await authOrg.deleteAgent(actor, deletedAgent.agentId);
    const nullAgentMarker = await insertCanonicalOrphanChatThreadEventFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      chatThreadId: deletedThread.id,
      createdAt: retainedAtBoundary,
    });
    const coveredEventIds = [
      liveCovered.id,
      deletedThreadCovered.id,
      deletedAgentCovered.id,
      secondLiveCovered.id,
      nullAgentMarker.id,
    ];
    const snapshotAt = new Date(retentionCutoff + 7 * DAY_MS);
    await setChatThreadSnapshotBoundaryFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      latestEventId: nullAgentMarker.id,
      latestEventSeqId: nullAgentMarker.seqId,
      updatedAt: snapshotAt,
    });

    mockNow(snapshotAt);
    const boundaryCompact = await compactChatThreadSnapshots(actor);
    expect(boundaryCompact).toMatchObject({ scopes: 0, eventsPruned: 0 });
    await expect(
      readChatThreadEventIdsFixture({
        userId: actor.userId,
        orgId: actor.orgId,
        eventIds: coveredEventIds,
      }),
    ).resolves.toStrictEqual(coveredEventIds);

    const concurrentAppend = await holdChatThreadEventInsertTransactionFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      chatThreadId: liveThread.id,
      agentId: liveAgent.agentId,
      title: "Concurrent event above the committed snapshot watermark",
      createdAt: retainedAtBoundary,
      signal: context.signal,
    });
    onTestFinished(async () => {
      concurrentAppend.release();
      await concurrentAppend.done;
    });

    mockNow(snapshotAt.getTime() + 1);
    const overlappingCompactions = await Promise.all([
      compactChatThreadSnapshots(actor),
      compactChatThreadSnapshots(actor),
    ]);
    expect(
      overlappingCompactions
        .map((result) => {
          return result.eventsPruned;
        })
        .sort((left, right) => {
          return left - right;
        }),
    ).toStrictEqual([2, 2]);
    await expect(
      readChatThreadEventIdsFixture({
        userId: actor.userId,
        orgId: actor.orgId,
        eventIds: coveredEventIds,
      }),
    ).resolves.toStrictEqual([nullAgentMarker.id]);

    const converged = await compactChatThreadSnapshots(actor);
    expect(converged.eventsPruned).toBe(1);
    await expect(
      readChatThreadEventIdsFixture({
        userId: actor.userId,
        orgId: actor.orgId,
        eventIds: coveredEventIds,
      }),
    ).resolves.toStrictEqual([]);
    const retry = await compactChatThreadSnapshots(actor);
    expect(retry.eventsPruned).toBe(0);

    concurrentAppend.release();
    await concurrentAppend.done;
    mockOptionalEnv("CHAT_THREAD_SNAPSHOT_COMPACTION_BATCH_SIZE", "1");
    const isolatedActor = bdd.user({ userId: actor.userId });
    if (!isolatedActor.orgId) {
      throw new Error("Expected an organization-scoped isolation actor");
    }
    expect(isolatedActor.orgId).not.toBe(actor.orgId);
    await api.ensureOrgModelProvider(isolatedActor);
    const isolatedAgent = await bdd.createAgent(isolatedActor, {
      displayName: "Same-user other-org retention agent",
    });
    const isolatedBoundaryId = randomUUID();
    const isolatedThread = await chat.createThread(isolatedActor, {
      agentId: isolatedAgent.agentId,
      title: "Same-user other-org retention thread",
      eventId: isolatedBoundaryId,
    });
    const isolatedBoundary = (await allThreadEvents(isolatedActor)).find(
      (threadEvent) => {
        return threadEvent.id === isolatedBoundaryId;
      },
    );
    if (!isolatedBoundary) {
      throw new Error("Expected the isolation snapshot boundary event");
    }
    await setChatThreadSnapshotBoundaryFixture({
      userId: isolatedActor.userId,
      orgId: isolatedActor.orgId,
      latestEventId: isolatedBoundary.id,
      latestEventSeqId: isolatedBoundary.seqId,
      updatedAt: new Date(snapshotAt.getTime() + 1),
    });
    const isolatedAboveWatermark =
      await insertChatThreadEventTransactionFixture({
        userId: isolatedActor.userId,
        orgId: isolatedActor.orgId,
        chatThreadId: isolatedThread.id,
        agentId: isolatedAgent.agentId,
        title: "Old event above only the isolated scope watermark",
        createdAt: retainedAtBoundary,
      });
    const compactionBlocker = bdd.user({ userId: actor.userId });
    await api.ensureOrgModelProvider(compactionBlocker);
    const blockerAgent = await bdd.createAgent(compactionBlocker, {
      displayName: "Above-watermark compaction blocker",
    });
    await chat.createThread(compactionBlocker, {
      agentId: blockerAgent.agentId,
      title: "Keep the retention scope out of this snapshot batch",
    });

    const aboveWatermarkCompact = await compactChatThreadSnapshots(
      actor,
      isolatedActor,
      compactionBlocker,
    );
    expect(aboveWatermarkCompact.eventsPruned).toBe(0);
    const unchangedBoundary = await chat.getThreadSnapshot(actor);
    expect({
      latestEventId: unchangedBoundary.latestEventId,
      latestSeqId: unchangedBoundary.latestSeqId,
    }).toStrictEqual({
      latestEventId: nullAgentMarker.id,
      latestSeqId: nullAgentMarker.seqId,
    });
    await expect(
      readChatThreadEventIdsFixture({
        userId: actor.userId,
        orgId: actor.orgId,
        eventIds: [concurrentAppend.event.id],
      }),
    ).resolves.toStrictEqual([concurrentAppend.event.id]);
    await expect(
      readChatThreadEventIdsFixture({
        userId: isolatedActor.userId,
        orgId: isolatedActor.orgId,
        eventIds: [isolatedAboveWatermark.id],
      }),
    ).resolves.toStrictEqual([isolatedAboveWatermark.id]);

    const nextTailEvent = await insertChatThreadEventTransactionFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      chatThreadId: liveThread.id,
      agentId: liveAgent.agentId,
      title: "Second event above the committed snapshot watermark",
      createdAt: retainedAtBoundary,
    });
    await expect(
      readChatThreadEventIdsFixture({
        userId: actor.userId,
        orgId: actor.orgId,
        eventIds: [concurrentAppend.event.id, nextTailEvent.id],
      }),
    ).resolves.toStrictEqual([concurrentAppend.event.id, nextTailEvent.id]);

    const markerlessTail = await threadEventPage(actor, nullAgentMarker.seqId);
    expect(
      markerlessTail.events.map((event) => {
        return { id: event.id, seqId: event.seqId };
      }),
    ).toStrictEqual([
      {
        id: concurrentAppend.event.id,
        seqId: concurrentAppend.event.seqId,
      },
      { id: nextTailEvent.id, seqId: nextTailEvent.seqId },
    ]);
    expect(markerlessTail.hasMore).toBeFalsy();
    await expectExpiredThreadEventCursor(actor, liveCovered.seqId);
  }, 90_000);

  it("keeps concurrent thread event sequence reservation atomic through commit", async () => {
    const owner = bdd.user();
    if (!owner.orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "Concurrent thread event agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: "thread event sequence serialization anchor",
    });
    const fixture = {
      userId: owner.userId,
      orgId: owner.orgId,
      chatThreadId: threadId,
      agentId: agent.agentId,
    } as const;
    const held = await holdChatThreadEventInsertTransactionFixture({
      ...fixture,
      title: "Held thread event",
      signal: context.signal,
    });
    const secondInsert = insertChatThreadEventTransactionFixture({
      ...fixture,
      title: "Blocked thread event",
    });
    onTestFinished(async () => {
      held.release();
      await Promise.allSettled([held.done, secondInsert]);
    });

    await expect.poll(held.blockedWaiterCount).toBe(1);
    const beforeCommit = await allThreadEvents(owner);
    expect(
      beforeCommit.some((event) => {
        return event.id === held.event.id;
      }),
    ).toBeFalsy();

    held.release();
    await held.done;
    const second = await secondInsert;
    const committed = (await allThreadEvents(owner)).filter((event) => {
      return event.id === held.event.id || event.id === second.id;
    });
    expect(
      committed.map((event) => {
        return event.id;
      }),
    ).toStrictEqual([held.event.id, second.id]);
    expect(held.event.seqId).toBeLessThan(second.seqId);
  }, 30_000);

  it("touches thread sort from existing direct user sends and run-finished markers", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Thread sort touch agent",
    );
    const directSendSortEventId = randomUUID();
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Existing sort touch thread",
    });

    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "move this thread when I send it",
      chatThreadSortEventId: directSendSortEventId,
    });
    await waitForThreadMessages(actor, run.threadId, (messages) => {
      return userMessages(messages).some((message) => {
        return (
          chatEventDisplayText(message) === "move this thread when I send it"
        );
      });
    });
    await flushWaitUntilForTest();

    let sortTouches = (await allThreadEvents(actor)).filter((event) => {
      return (
        event.chatThreadId === run.threadId && event.kind === "sort_touched"
      );
    });
    expect(sortTouches).toHaveLength(1);
    expect(sortTouches[0]?.id).toBe(directSendSortEventId);

    const claim = await claimChatRun(runnerGroup, run.runId);
    await completeChatRunOk(run.runId, claim.sandboxHeaders);
    await waitForThreadMessages(actor, run.threadId, (messages) => {
      return assistantMessages(messages).some((message) => {
        return (
          message.eventType === "run.completed" &&
          message.runId === run.runId &&
          message.runLifecycleEvent === "completed"
        );
      });
    });
    await flushWaitUntilForTest();

    sortTouches = (await allThreadEvents(actor)).filter((event) => {
      return (
        event.chatThreadId === run.threadId && event.kind === "sort_touched"
      );
    });
    expect(sortTouches).toHaveLength(2);
  }, 90_000);

  it("preserves UTC snapshot and event cutoff boundaries outside UTC", async () => {
    stubTestTimezone("Asia/Shanghai");
    onTestFinished(() => {
      clearMockNow();
      stubTestTimezone("UTC");
    });
    const actor = bdd.user();
    await api.ensureOrgModelProvider(actor);
    const liveAgent = await bdd.createAgent(actor, {
      displayName: "Snapshot compaction live agent",
    });
    const deletedAgent = await bdd.createAgent(actor, {
      displayName: "Snapshot compaction deleted agent",
    });
    const liveCreateEventId = randomUUID();
    const deletedCreateEventId = randomUUID();

    const liveThread = await chat.createThread(actor, {
      agentId: liveAgent.agentId,
      title: "Initial compact title",
      eventId: liveCreateEventId,
    });
    const deletedAgentThread = await chat.createThread(actor, {
      agentId: deletedAgent.agentId,
      title: "Deleted agent compact title",
      eventId: deletedCreateEventId,
    });

    const initialEvents = await allThreadEvents(actor);
    const liveCreateEvent = initialEvents.find((event) => {
      return event.id === liveCreateEventId;
    });
    const deletedCreateEvent = initialEvents.find((event) => {
      return event.id === deletedCreateEventId;
    });
    if (!liveCreateEvent || !deletedCreateEvent) {
      throw new Error("Expected both thread creation events");
    }
    const initialSnapshotAt =
      Math.max(
        Date.parse(liveCreateEvent.createdAt),
        Date.parse(deletedCreateEvent.createdAt),
      ) + 1000;
    mockNow(initialSnapshotAt);
    const initialCompact = await compactChatThreadSnapshots(actor);
    expect(initialCompact.eventsApplied).toBeGreaterThanOrEqual(2);

    const baselineSnapshot = await chat.getThreadSnapshot(actor);
    expect(baselineSnapshot.latestEventId).not.toBeNull();
    expect(baselineSnapshot.latestSeqId).not.toBeNull();
    expect(
      baselineSnapshot.chatThreads.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual(
      expect.arrayContaining([liveThread.id, deletedAgentThread.id]),
    );

    const renameEventId = randomUUID();
    const modelSelectionEventId = randomUUID();
    await chat.renameThread(
      actor,
      liveThread.id,
      "Renamed compact title",
      renameEventId,
    );
    await chat.updateThreadModelSelection(
      actor,
      liveThread.id,
      "claude-sonnet-5",
      { eventId: modelSelectionEventId },
    );
    await setChatThreadVideoModelFixture(liveThread.id, "fal-ai/veo3.1/fast");
    await chat.updateThreadImageModel(
      actor,
      liveThread.id,
      "fal-ai/qwen-image",
    );

    const incrementalSnapshotAt = initialSnapshotAt + 1000;
    mockNow(incrementalSnapshotAt);
    const incrementalCompact = await compactChatThreadSnapshots(actor);
    expect(incrementalCompact.eventsApplied).toBeGreaterThanOrEqual(1);

    chat.mockObjectStorageObjectsExist();
    await authOrg.deleteAgent(actor, deletedAgent.agentId);

    mockNow(incrementalSnapshotAt + DAY_MS);
    await compactChatThreadSnapshots(actor);
    const boundarySnapshot = await chat.getThreadSnapshot(actor);
    expect(
      boundarySnapshot.chatThreads.map((thread) => {
        return thread.id;
      }),
    ).toContain(deletedAgentThread.id);

    mockNow(incrementalSnapshotAt + DAY_MS + 1);
    const staleCompact = await compactChatThreadSnapshots(actor);
    expect(staleCompact.removedDeletedAgentThreads).toBeGreaterThanOrEqual(1);
    const compactedSnapshot = await chat.getThreadSnapshot(actor);
    expect(compactedSnapshot.latestEventId).not.toBeNull();
    expect(compactedSnapshot.latestSeqId).not.toBeNull();
    expect(compactedSnapshot.chatThreads).toStrictEqual([
      expect.objectContaining({
        id: liveThread.id,
        agentId: liveAgent.agentId,
        title: "Renamed compact title",
        renamedAt: expect.any(String),
        selectedModel: "claude-sonnet-5",
        // The compaction projection is hand-written SQL, so a column missing
        // from it survives every read until compaction runs and drops it.
        selectedVideoModel: "fal-ai/veo3.1/fast",
        selectedImageModel: "fal-ai/qwen-image",
      }),
    ]);

    const retentionBoundary =
      Date.parse(liveCreateEvent.createdAt) + 7 * DAY_MS;
    mockNow(retentionBoundary);
    await compactChatThreadSnapshots(actor);
    expect(
      (await allThreadEvents(actor)).some((event) => {
        return event.id === liveCreateEvent.id;
      }),
    ).toBeTruthy();
    const retainedBoundaryCursor = await chat.requestThreadEvents(
      actor,
      { sinceSeqId: liveCreateEvent.seqId },
      [200],
    );
    expect(retainedBoundaryCursor.status).toBe(200);

    mockNow(retentionBoundary + 1);
    const retentionCompact = await compactChatThreadSnapshots(actor);
    expect(retentionCompact.eventsPruned).toBeGreaterThanOrEqual(1);
    const prunedCursor = await chat.requestThreadEvents(
      actor,
      { sinceSeqId: liveCreateEvent.seqId },
      [410],
    );
    expect(prunedCursor.body).toStrictEqual({
      error: {
        message: "Chat thread events cursor has expired",
        code: "CHAT_THREAD_EVENTS_EXPIRED",
      },
    });

    mockNow(Date.parse(deletedCreateEvent.createdAt) + 7 * DAY_MS + 1);
    await compactChatThreadSnapshots(actor);
    const prunedDeletedAgentCursor = await chat.requestThreadEvents(
      actor,
      { sinceSeqId: deletedCreateEvent.seqId },
      [410],
    );
    expect(prunedDeletedAgentCursor.body).toStrictEqual({
      error: {
        message: "Chat thread events cursor has expired",
        code: "CHAT_THREAD_EVENTS_EXPIRED",
      },
    });
    expect(
      (await allThreadEvents(actor)).some((event) => {
        return event.agentId === deletedAgent.agentId;
      }),
    ).toBeFalsy();

    const markerlessSnapshotCursor = await chat.requestThreadEvents(
      actor,
      { sinceSeqId: compactedSnapshot.latestSeqId ?? undefined },
      [200],
    );
    expect(markerlessSnapshotCursor.status).toBe(200);
    if (markerlessSnapshotCursor.status !== 200) {
      throw new Error(
        "Expected the markerless snapshot cursor to remain valid",
      );
    }
    expect(markerlessSnapshotCursor.body.events).toStrictEqual([]);
  });
  it("keeps thread detail independent from thread model projection state", async () => {
    const { actor, agentId } = await entitledChatActor(
      "Thread detail model pin agent",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "pin the first run model",
      model: "claude-sonnet-5",
    });

    let detail = await chat.readThread(actor, run.threadId);
    expect(detail).not.toHaveProperty("selectedModel");
    await expect(chat.listActiveChatThreadIds(actor)).resolves.toContain(
      run.threadId,
    );

    await chat.updateThreadModelSelection(actor, run.threadId, null);
    detail = await chat.readThread(actor, run.threadId);
    expect(detail).not.toHaveProperty("selectedModel");
    expect(detail).not.toHaveProperty("modelProviderId");
    expect(detail).not.toHaveProperty("modelProviderType");
    expect(detail).not.toHaveProperty("modelProviderCredentialScope");

    await cancelChatRun(actor, run.runId);
    await expect(chat.listActiveChatThreadIds(actor)).resolves.not.toContain(
      run.threadId,
    );
  }, 90_000);

  it("rejects explicit thread models outside current workspace policy", async () => {
    const { actor, agentId, providerId } = await entitledChatActor(
      "Unavailable explicit thread model agent",
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const rejectedThreadId = randomUUID();
    const rejectedCreate = await chat.requestCreateThread(
      actor,
      {
        agentId,
        clientThreadId: rejectedThreadId,
        model: "claude-sonnet-5",
      },
      [400],
    );
    expectApiError(rejectedCreate.body);
    expect(rejectedCreate.body.error.message).toBe(
      "The selected model is not available in this workspace",
    );
    await chat.requestReadThread(actor, rejectedThreadId, [404]);

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-opus-4-8",
    });
    const rejectedUpdate = await chat.requestUpdateThreadModelSelection(
      actor,
      thread.id,
      "claude-sonnet-5",
      [400],
    );
    expectApiError(rejectedUpdate.body);
    expect(rejectedUpdate.body.error.message).toBe(
      "The selected model is not available in this workspace",
    );
  }, 90_000);

  it("allows free model pins and rejects all other models for limited-free-1 workspaces", async () => {
    const { actor, agentId } = await entitledChatActor(
      "Limited free model pin agent",
    );
    if (!actor.orgId) {
      throw new Error("Expected actor org");
    }
    // "limited-free-1" is only assigned by the Clerk org-creation bootstrap;
    // no product API can move an entitled org onto it, so downgrade the tier
    // through the shared system-config seed while keeping the pro balance.
    const billingStatus = await api.readBillingStatus(actor);
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "limited-free-1",
      credits: billingStatus.credits,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-flash",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "gpt-5.6-luna",
        isDefault: false,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const thread = await chat.createThread(actor, {
      agentId,
      model: "deepseek-v4-flash",
      title: "limited free model pin",
    });
    for (const selectedModel of [
      "gpt-5.6-sol",
      "gpt-5.5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
    ] as const) {
      const restrictedSelection = await chat.requestUpdateThreadModelSelection(
        actor,
        thread.id,
        selectedModel,
        [402],
      );
      expectApiError(restrictedSelection.body);
      expect(restrictedSelection.body.error).toStrictEqual({
        message:
          "Insufficient credits. Add credits or configure your own API key to continue.",
        code: "INSUFFICIENT_CREDITS",
      });

      await expect(
        chat.readThread(actor, thread.id),
      ).resolves.not.toHaveProperty("selectedModel");
    }

    await chat.updateThreadModelSelection(actor, thread.id, "gpt-5.6-luna");
    const detail = await chat.readThread(actor, thread.id);
    expect(detail).not.toHaveProperty("selectedModel");
  }, 90_000);

  it("updates the Computer Use host binding on a chat thread", async () => {
    const actor = bdd.user();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Computer-use thread agent",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Computer Use",
    });

    const host = await cu.startComputerUseHost(actor);
    await chat.updateThreadComputerUseHost(actor, thread.id, host.hostId);

    const missingHost = await chat.requestUpdateThreadComputerUseHost(
      actor,
      thread.id,
      randomUUID(),
      [404],
    );
    expectApiError(missingHost.body);
    expect(missingHost.body.error.message).toBe("Computer-use host not found");

    const peer = bdd.user({ orgId: actor.orgId });
    const peerUpdate = await chat.requestUpdateThreadComputerUseHost(
      peer,
      thread.id,
      host.hostId,
      [404],
    );
    expectApiError(peerUpdate.body);
    expect(peerUpdate.body.error.message).toBe("Chat thread not found");

    await chat.updateThreadComputerUseHost(actor, thread.id, null);

    const hostEvents = (await allThreadEvents(actor)).filter((event) => {
      return (
        event.chatThreadId === thread.id &&
        event.kind === "computer_use_host_updated"
      );
    });
    expect(hostEvents).toHaveLength(2);
    expect(
      hostEvents.map((event) => {
        return event.computerUseHostId;
      }),
    ).toStrictEqual([host.hostId, null]);

    const missingThread = await chat.requestUpdateThreadComputerUseHost(
      actor,
      randomUUID(),
      null,
      [404],
    );
    expectApiError(missingThread.body);
    expect(missingThread.body.error.message).toBe("Chat thread not found");
  });

  it("cancels in-flight runs and cascades schedules when a thread is deleted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Thread delete cascade agent",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const peer = bdd.user({ orgId: actor.orgId });

    const unauthenticated = await chat.requestDeleteThread(
      null,
      randomUUID(),
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const unknown = await chat.requestDeleteThread(actor, randomUUID(), [404]);
    expectApiError(unknown.body);
    expect(unknown.body.error).toStrictEqual({
      message: "Chat thread not found",
      code: "NOT_FOUND",
    });

    const malformed = await chat.requestDeleteThread(
      actor,
      "not-a-uuid",
      [400],
    );
    expectApiError(malformed.body);
    expect(malformed.body.error.message).toContain("id");

    // Main thread with a claimed (running) run.
    const main = await sendChatRun(actor, {
      agentId,
      prompt: "delete cascade anchor",
    });
    await api.heartbeatRunner(runnerGroup);
    await api.claimRunnerJob(main.runId);

    await expect(chat.listActiveChatThreadIds(actor)).resolves.toContain(
      main.threadId,
    );

    // A sibling thread whose run completes: terminal transition drops the
    // active-thread flag.
    const sibling = await sendChatRun(actor, {
      agentId,
      prompt: "sibling thread completes",
    });
    const siblingClaim = await claimChatRun(runnerGroup, sibling.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(sibling.runId, siblingClaim.sandboxHeaders);
    await setAgentRunCreatedAtFixture(
      main.runId,
      new Date(FORWARD_CLEANUP_TEST_CREATED_AT),
    );
    await setAgentRunCreatedAtFixture(
      sibling.runId,
      new Date(PRE_FORWARD_CLEANUP_TEST_CREATED_AT),
    );

    await expect(chat.listActiveChatThreadIds(actor)).resolves.not.toContain(
      sibling.threadId,
    );

    // A third thread with its own pending run must survive the delete.
    const other = await sendChatRun(actor, {
      agentId,
      prompt: "other thread stays active",
    });

    const peerDelete = await chat.requestDeleteThread(
      peer,
      main.threadId,
      [404],
    );
    expectApiError(peerDelete.body);
    expect(peerDelete.body.error.code).toBe("NOT_FOUND");
    await expect(chat.readThread(actor, main.threadId)).resolves.toStrictEqual({
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });

    context.mocks.ably.publish.mockClear();
    const deleted = await chat.requestDeleteThread(actor, main.threadId, [204]);
    expect(deleted.body).toBeUndefined();
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: main.runId,
      mode: "hard",
    });

    expect((await api.readRun(actor, main.runId)).status).toBe("cancelled");
    expect((await api.readRun(actor, sibling.runId)).status).toBe("completed");
    expect((await api.readRun(actor, other.runId)).status).toBe("pending");

    const goneRead = await chat.requestReadThread(actor, main.threadId, [404]);
    expectApiError(goneRead.body);
    await expect(allThreadEvents(actor)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "deleted",
          chatThreadId: main.threadId,
        }),
      ]),
    );

    // Terminal-only deletion does not have the active fast path. The sibling
    // predates the watermark, so only its matching post-watermark tombstone
    // admits it to the forward cleanup cohort.
    await chat.deleteThread(actor, sibling.threadId);
    const siblingDeletion = (await allThreadEvents(actor)).find((event) => {
      return (
        event.kind === "deleted" && event.chatThreadId === sibling.threadId
      );
    });
    if (!siblingDeletion) {
      throw new Error("Expected the sibling deletion tombstone");
    }
    expect(Date.parse(siblingDeletion.createdAt)).toBeGreaterThanOrEqual(
      FORWARD_CLEANUP_CUTOFF_MS,
    );
    const cleanupAt = now() + CANCELLATION_RECOVERY_STALE_AFTER_MS;
    mockNow(cleanupAt);
    onTestFinished(clearMockNow);
    const cleanup = await accept(
      setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
        testCronCleanupSandboxesStateContract,
      ).cleanup({
        body: {
          chatThreadIds: [],
          runIds: [main.runId, sibling.runId],
          orgIds: [],
          exportJobIds: [],
        },
      }),
      [200],
    );
    expect(cleanup.body.threadlessRuns.discovered).toBe(2);
    expect(cleanup.body.threadlessRuns.deleted).toBe(2);
    await expect(
      api.requestReadRun(actor, main.runId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      api.requestReadRun(actor, sibling.runId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(api.readRun(actor, other.runId)).resolves.toMatchObject({
      status: "pending",
    });

    await cancelChatRun(actor, other.runId);
  }, 120_000);
});

describe("CHAT-01 chat thread read state", () => {
  it("uses event type rather than legacy lifecycle payload for read cursors", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Read cursor event type agent",
    );
    const run = await completeChatRunInThread(actor, runnerGroup, {
      agentId,
      prompt: "read cursor event type",
    });
    const firstRead = await chat.markThreadRead(actor, run.threadId);
    if (!firstRead.lastReadAt) {
      throw new Error("Expected the completed run to establish a read cursor");
    }

    const conflicting =
      await insertOutputEventWithConflictingLegacyPayloadFixture({
        threadId: run.threadId,
        content: "explicit output event with stale lifecycle payload",
        createdAt: new Date(new Date(firstRead.lastReadAt).getTime() + 1000),
        legacyPayload: "run.completed",
      });
    const page = await chat.listThreadEvents(actor, run.threadId);
    expect(page.events).toContainEqual(
      expect.objectContaining({
        id: conflicting.id,
        eventType: "output.message",
      }),
    );

    await expect(chat.listThreadUnreads(actor, agentId)).resolves.toStrictEqual(
      [],
    );
    await expect(
      chat.markThreadRead(actor, run.threadId),
    ).resolves.toMatchObject({
      lastReadAt: firstRead.lastReadAt,
    });
  }, 120_000);

  it("lists unread agent and thread indicators", async () => {
    const {
      actor: owner,
      agentId: agentA,
      runnerGroup,
    } = await entitledChatActor("Unread agent A");
    const agentB = (
      await bdd.createAgent(owner, {
        displayName: "Unread agent B",
        visibility: "private",
      })
    ).agentId;

    const unauthenticated = await chat.requestIndicators(null, [401]);
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");
    const orgless = await chat.requestIndicators(
      bdd.user({ orgId: null }),
      [401],
    );
    expectApiError(orgless.body);
    expect(orgless.body.error.code).toBe("UNAUTHORIZED");

    const peer = bdd.user({ orgId: owner.orgId });
    await api.ensureOrgModelProvider(peer);
    const peerAgent = await bdd.createAgent(peer, {
      displayName: "Unread peer agent",
      visibility: "private",
    });
    const peerRun = await completeChatRunInThread(peer, runnerGroup, {
      agentId: peerAgent.agentId,
      prompt: "peer unread thread stays isolated",
    });

    const sameUserOtherOrg = bdd.user({ userId: owner.userId });
    await api.grantProEntitlement(sameUserOtherOrg);
    await api.ensureOrgModelProvider(sameUserOtherOrg);
    const otherOrgAgent = await bdd.createAgent(sameUserOtherOrg, {
      displayName: "Unread other org agent",
      visibility: "private",
    });
    const otherOrgRun = await completeChatRunInThread(
      sameUserOtherOrg,
      runnerGroup,
      {
        agentId: otherOrgAgent.agentId,
        prompt: "other org unread thread stays isolated",
      },
    );

    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);
    await expect(chat.listUnreadChatThreadIds(owner)).resolves.toStrictEqual(
      [],
    );
    await expect(chat.listUnreadChatThreadIds(peer)).resolves.toStrictEqual([
      peerRun.threadId,
    ]);
    await expect(
      chat.listUnreadChatThreadIds(sameUserOtherOrg),
    ).resolves.toStrictEqual([otherOrgRun.threadId]);

    // An active (claimed) run keeps its thread out of the unread aggregate
    // until it completes and leaves a run-finished marker.
    const activeRun = await sendChatRun(owner, {
      agentId: agentA,
      prompt: "unread aggregate with active run",
    });
    const activeClaim = await claimChatRun(runnerGroup, activeRun.runId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);
    await expect(chat.listUnreadChatThreadIds(owner)).resolves.toStrictEqual(
      [],
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(activeRun.runId, activeClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    await waitForThreadEvents(owner, activeRun.threadId, (events) => {
      return events.some((event) => {
        return (
          event.runId === activeRun.runId && event.eventType === "run.completed"
        );
      });
    });
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([agentA]);
    await expect(chat.listUnreadChatThreadIds(owner)).resolves.toStrictEqual([
      activeRun.threadId,
    ]);
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    const firstRead = await chat.markThreadRead(owner, activeRun.threadId);
    expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
      [`user-org:${owner.userId}:${owner.orgId}`],
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      {
        threadId: activeRun.threadId,
        agentId: agentA,
        lastReadAt: firstRead.lastReadAt,
      },
    );
    context.mocks.ably.publish.mockClear();
    const repeatedRead = await chat.markThreadRead(owner, activeRun.threadId);
    expect(repeatedRead.lastReadAt).toBe(firstRead.lastReadAt);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);
    await expect(chat.listUnreadChatThreadIds(owner)).resolves.toStrictEqual(
      [],
    );

    // Historical Goal status does not control current unread indicators.
    const activeGoalRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentA,
      prompt: "unread aggregate with active goal",
    });
    const completeGoalRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentB,
      prompt: "unread aggregate with complete goal",
    });
    await createThreadGoal(owner, activeGoalRun.runId, "bdd unread goal");
    await createThreadGoal(owner, completeGoalRun.runId, "bdd unread goal");
    await completeThreadGoal(owner, completeGoalRun.runId);
    expect(new Set(await chat.listUnreadAgents(owner))).toStrictEqual(
      new Set([agentA, agentB]),
    );
    expect(new Set(await chat.listUnreadChatThreadIds(owner))).toStrictEqual(
      new Set([activeGoalRun.threadId, completeGoalRun.threadId]),
    );
    await chat.markThreadRead(owner, activeGoalRun.threadId);
    await chat.markThreadRead(owner, completeGoalRun.threadId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);
    await expect(chat.listUnreadChatThreadIds(owner)).resolves.toStrictEqual(
      [],
    );

    const runA = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentA,
      prompt: "unread aggregate A",
    });
    const runB = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentB,
      prompt: "unread aggregate B",
    });

    const unreadAgents = await chat.listUnreadAgents(owner);
    expect(new Set(unreadAgents)).toStrictEqual(new Set([agentA, agentB]));
    expect(new Set(await chat.listUnreadChatThreadIds(owner))).toStrictEqual(
      new Set([runA.threadId, runB.threadId]),
    );

    await chat.markThreadRead(owner, runA.threadId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([agentB]);
    await expect(chat.listUnreadChatThreadIds(owner)).resolves.toStrictEqual([
      runB.threadId,
    ]);

    await chat.markThreadRead(owner, runB.threadId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);
    await expect(chat.listUnreadChatThreadIds(owner)).resolves.toStrictEqual(
      [],
    );
  }, 120_000);

  it("lists active thread ids without hiding the agent's unread state", async () => {
    const {
      actor: owner,
      agentId: ownerAgent,
      runnerGroup,
    } = await entitledChatActor("Active ids owner agent");
    const peer = bdd.user({ orgId: owner.orgId });
    const sameUserOtherOrg = bdd.user({ userId: owner.userId });

    const peerAgent = await bdd.createAgent(peer, {
      displayName: "Active ids peer agent",
      visibility: "private",
    });
    const otherOrgAgent = await bdd.createAgent(sameUserOtherOrg, {
      displayName: "Active ids other org agent",
      visibility: "private",
    });
    await api.grantProEntitlement(sameUserOtherOrg);
    await api.ensureOrgModelProvider(sameUserOtherOrg);

    // A completed run's thread must not appear in the active list. Run it
    // first so the pro-tier concurrency slots stay free for the runs below.
    const completedRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId: ownerAgent,
      prompt: "terminal completed thread",
    });

    // Peer-user and cross-org active runs must not leak into the owner list.
    await sendChatRun(peer, {
      agentId: peerAgent.agentId,
      prompt: "peer active thread",
    });
    await sendChatRun(sameUserOtherOrg, {
      agentId: otherOrgAgent.agentId,
      prompt: "other org active thread",
    });

    // Owner: one claimed (running) run and one send over the org concurrency
    // cap, which admits as a queued run.
    const runningRun = await sendChatRun(owner, {
      agentId: ownerAgent,
      prompt: "active running thread",
    });
    const runningClaim = await claimChatRun(runnerGroup, runningRun.runId);
    const queuedRun = await sendChatRun(owner, {
      agentId: ownerAgent,
      prompt: "active queued thread",
    });

    expect(new Set(await chat.listActiveChatThreadIds(owner))).toStrictEqual(
      new Set([runningRun.threadId, queuedRun.threadId]),
    );
    await expect(chat.listIndicators(owner)).resolves.toStrictEqual({
      agents: { [ownerAgent]: "unread" },
      threads: {
        [completedRun.threadId]: "unread",
        [runningRun.threadId]: "active",
        [queuedRun.threadId]: "active",
      },
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(runningRun.runId, runningClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    await waitForThreadEvents(owner, runningRun.threadId, (events) => {
      return events.some((event) => {
        return (
          event.runId === runningRun.runId &&
          event.eventType === "run.completed"
        );
      });
    });

    expect(new Set(await chat.listActiveChatThreadIds(owner))).toStrictEqual(
      new Set([queuedRun.threadId]),
    );
    await expect(chat.listIndicators(owner)).resolves.toStrictEqual({
      agents: { [ownerAgent]: "unread" },
      threads: {
        [completedRun.threadId]: "unread",
        [runningRun.threadId]: "unread",
        [queuedRun.threadId]: "active",
      },
    });
  }, 120_000);

  it("limits unified unread indicators to seven days without limiting active threads", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Bounded indicator window agent",
    );
    const currentTime = now();

    await withMockNowForTest(currentTime, async () => {
      mockNow(currentTime - 7 * DAY_MS - 1);
      await completeChatRunInThread(actor, runnerGroup, {
        agentId,
        prompt: "expired unread indicator",
      });

      mockNow(currentTime);
      const recentRun = await completeChatRunInThread(actor, runnerGroup, {
        agentId,
        prompt: "recent unread indicator",
      });

      mockNow(currentTime - 7 * DAY_MS - 1);
      const activeRun = await sendChatRun(actor, {
        agentId,
        prompt: "old active indicator",
      });

      mockNow(currentTime);
      await expect(chat.listIndicators(actor)).resolves.toStrictEqual({
        agents: { [agentId]: "unread" },
        threads: {
          [recentRun.threadId]: "unread",
          [activeRun.threadId]: "active",
        },
      });
    });
  }, 120_000);

  it("returns the 50 newest unread indicators across the organization", async () => {
    const {
      actor,
      agentId: agentA,
      runnerGroup,
    } = await entitledChatActor("Bounded indicator agent A");
    const agentB = (
      await bdd.createAgent(actor, {
        displayName: "Bounded indicator agent B",
        visibility: "private",
      })
    ).agentId;
    const firstCompletedAt = now() - 60_000;

    await withMockNowForTest(firstCompletedAt, async () => {
      const runs: { readonly runId: string; readonly threadId: string }[] = [];
      for (let index = 0; index < 51; index += 1) {
        mockNow(firstCompletedAt + index * 1000);
        runs.push(
          await completeChatRunInThread(actor, runnerGroup, {
            agentId: index % 2 === 0 ? agentA : agentB,
            prompt: `bounded unread indicator ${index}`,
          }),
        );
      }

      mockNow(firstCompletedAt + 60_000);
      const indicators = await chat.listIndicators(actor);
      expect(indicators.agents).toStrictEqual({
        [agentA]: "unread",
        [agentB]: "unread",
      });
      expect(Object.keys(indicators.threads)).toHaveLength(50);
      const oldestRun = runs[0];
      if (!oldestRun) {
        throw new Error("Expected an oldest completed run");
      }
      expect(indicators.threads).not.toHaveProperty(oldestRun.threadId);
      for (const run of runs.slice(1)) {
        expect(indicators.threads[run.threadId]).toBe("unread");
      }
    });
  }, 240_000);

  it("excludes active runs while preserving unread state in historical Goal threads", async () => {
    const {
      actor: owner,
      agentId,
      runnerGroup,
    } = await entitledChatActor("Unread active state agent");

    // A claimed (running) run keeps its thread out of the unread list.
    const runningRun = await sendChatRun(owner, {
      agentId,
      prompt: "unread thread with active run",
    });
    const runningClaim = await claimChatRun(runnerGroup, runningRun.runId);

    const completedRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId,
      prompt: "unread thread with completed run",
    });
    const activeGoalRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId,
      prompt: "unread thread with active goal",
    });
    const completeGoalRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId,
      prompt: "unread thread with complete goal",
    });
    await createThreadGoal(owner, activeGoalRun.runId, "bdd unread goal");
    await createThreadGoal(owner, completeGoalRun.runId, "bdd unread goal");
    await completeThreadGoal(owner, completeGoalRun.runId);

    expect(
      new Set(
        (await chat.listThreadUnreads(owner, agentId)).map((unread) => {
          return unread.threadId;
        }),
      ),
    ).toStrictEqual(
      new Set([
        completedRun.threadId,
        activeGoalRun.threadId,
        completeGoalRun.threadId,
      ]),
    );
    await expect(chat.listIndicators(owner)).resolves.toStrictEqual({
      agents: { [agentId]: "unread" },
      threads: {
        [runningRun.threadId]: "active",
        [completedRun.threadId]: "unread",
        [completeGoalRun.threadId]: "unread",
        [activeGoalRun.threadId]: "unread",
      },
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(runningRun.runId, runningClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    await waitForThreadEvents(owner, runningRun.threadId, (events) => {
      return events.some((event) => {
        return (
          event.runId === runningRun.runId &&
          event.eventType === "run.completed"
        );
      });
    });
    expect(
      new Set(
        (await chat.listThreadUnreads(owner, agentId)).map((unread) => {
          return unread.threadId;
        }),
      ),
    ).toStrictEqual(
      new Set([
        runningRun.threadId,
        completedRun.threadId,
        completeGoalRun.threadId,
        activeGoalRun.threadId,
      ]),
    );
    await expect(chat.listIndicators(owner)).resolves.toStrictEqual({
      agents: { [agentId]: "unread" },
      threads: {
        [runningRun.threadId]: "unread",
        [completedRun.threadId]: "unread",
        [completeGoalRun.threadId]: "unread",
        [activeGoalRun.threadId]: "unread",
      },
    });
  }, 120_000);

  it("marks all unread chat threads for one agent", async () => {
    const {
      actor: owner,
      agentId: agentA,
      runnerGroup,
    } = await entitledChatActor("Mark-read agent A");
    const agentB = (
      await bdd.createAgent(owner, {
        displayName: "Mark-read agent B",
        visibility: "private",
      })
    ).agentId;

    const firstRunA = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentA,
      prompt: "mark all read A one",
    });
    const secondRunA = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentA,
      prompt: "mark all read A two",
    });
    const runB = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentB,
      prompt: "mark all read B",
    });

    expect(
      new Set(
        (await chat.listThreadUnreads(owner, agentA)).map((unread) => {
          return unread.threadId;
        }),
      ),
    ).toStrictEqual(new Set([firstRunA.threadId, secondRunA.threadId]));
    expect(new Set(await chat.listUnreadAgents(owner))).toStrictEqual(
      new Set([agentA, agentB]),
    );

    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    await chat.markAgentThreadsRead(owner, agentA);
    expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
      [`user-org:${owner.userId}:${owner.orgId}`],
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      {
        agentId: agentA,
        threadIds: expect.arrayContaining([
          firstRunA.threadId,
          secondRunA.threadId,
        ]),
      },
    );
    context.mocks.ably.publish.mockClear();
    await chat.markAgentThreadsRead(owner, agentA);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    await expect(chat.listThreadUnreads(owner, agentA)).resolves.toStrictEqual(
      [],
    );
    await expect(chat.listThreadUnreads(owner, agentB)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: runB.threadId }),
      ]),
    );
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([agentB]);
  }, 120_000);

  it("tails thread event rows after a sequence cursor", async () => {
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "Message cursor agent",
    });

    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: "cursor round one",
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: "cursor round two",
    });

    const full = await chat.listThreadEvents(owner, threadId);
    expect(
      full.events.map((event) => {
        return [event.eventType, event.content] as const;
      }),
    ).toStrictEqual([
      ["input.prompt", null],
      ["input.rejected", null],
      ["output.error", expect.stringContaining("Insufficient credits")],
      ["input.prompt", null],
      ["input.rejected", null],
      ["output.error", expect.stringContaining("Insufficient credits")],
    ]);
    expect(full.events.map(chatEventDisplayText)).toStrictEqual([
      "cursor round one",
      "cursor round one",
      expect.stringContaining("Insufficient credits"),
      "cursor round two",
      "cursor round two",
      expect.stringContaining("Insufficient credits"),
    ]);
    const seqIds = full.events.map((message) => {
      return message.seqId;
    });
    expect(seqIds).toStrictEqual(
      [...seqIds].sort((left, right) => {
        return left - right;
      }),
    );
    expect(new Set(seqIds).size).toBe(seqIds.length);
    const [
      firstQueuedUserMessage,
      ,
      firstAssistantMessage,
      secondQueuedUserMessage,
      secondReplacementMessage,
      secondAssistantMessage,
    ] = full.events;
    if (
      !firstQueuedUserMessage ||
      !firstAssistantMessage ||
      !secondQueuedUserMessage ||
      !secondReplacementMessage ||
      !secondAssistantMessage
    ) {
      throw new Error("Expected six messages across the two sends");
    }
    const firstQueuedUser = firstQueuedUserMessage.id;
    const secondQueuedUser = secondQueuedUserMessage.id;
    const secondReplacement = secondReplacementMessage.id;
    const secondAssistant = secondAssistantMessage.id;
    const firstAssistantSeqId = firstAssistantMessage.seqId;
    expect(full.events[1]).toMatchObject({
      eventType: "input.rejected",
      error: "insufficient_credits",
      revokesEventId: firstQueuedUser,
    });
    expect(full.events[4]).toMatchObject({
      eventType: "input.rejected",
      error: "insufficient_credits",
      revokesEventId: secondQueuedUser,
    });

    // Raw-row tailing is strictly after the cursor.
    const since = await chat.listThreadEvents(owner, threadId, {
      sinceEventId: firstAssistantMessage.id,
      sinceSeqId: firstAssistantSeqId,
    });
    expect(
      since.events.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([secondQueuedUser, secondReplacement, secondAssistant]);
  }, 30_000);

  it("serializes concurrent message sequence writes through commit", async () => {
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "Concurrent message sequence agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: "sequence serialization anchor",
    });

    const firstContent = `held sequence message ${randomUUID()}`;
    const secondContent = `blocked sequence message ${randomUUID()}`;
    const held = await holdChatEventInsertTransactionFixture({
      threadId,
      content: firstContent,
      signal: context.signal,
    });
    const secondInsert = await startChatEventInsertTransactionFixture({
      threadId,
      content: secondContent,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await Promise.allSettled([held.done, secondInsert.done]);
    });

    await expect
      .poll(() => {
        return held.blocks(secondInsert.pid);
      })
      .toBe(true);
    const beforeCommit = await chat.listThreadEvents(owner, threadId);
    expect(
      beforeCommit.events.some((message) => {
        return (
          chatEventDisplayText(message) === firstContent ||
          chatEventDisplayText(message) === secondContent
        );
      }),
    ).toBeFalsy();

    held.release();
    await held.done;
    const second = await secondInsert.done;
    const committed = await chat.listThreadEvents(owner, threadId);
    const concurrentRows = committed.events.filter((message) => {
      return message.id === held.event.id || message.id === second.id;
    });
    expect(
      concurrentRows.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([held.event.id, second.id]);
    expect(held.event.seqId).toBeLessThan(second.seqId);
  }, 30_000);
});

describe("CHAT-03 run usage events", () => {
  it("emits aggregate-only usage with the run completion timestamp", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Hourly usage event agent",
    );
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "record compacted usage",
    });
    const { sandboxHeaders } = await claimChatRun(runnerGroup, run.runId);
    const provider = `hourly-chat-${randomUUID().slice(0, 8)}`;
    await store.set(
      insertUsageEvent$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: run.runId,
        kind: "connector",
        provider,
        category: "api_request",
        quantity: 3,
        status: "processed",
        creditsCharged: 7,
        processedAt: new Date("2020-01-01T12:25:00.000Z"),
      },
      context.signal,
    );
    await expect(
      store.set(
        materializeHourlyUsage$,
        {
          orgId: actor.orgId,
          userId: actor.userId,
          runId: run.runId,
        },
        context.signal,
      ),
    ).resolves.toBe(1);

    const completedAt = new Date(now() + 1000);
    mockNow(completedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    await completeChatRunOk(run.runId, sandboxHeaders);
    await flushWaitUntilForTest();

    const usageEvents = await usageEventsForRun(actor, run.threadId, run.runId);
    expect(usageEvents).toStrictEqual([
      expect.objectContaining({
        createdAt: completedAt.toISOString(),
        usage: {
          version: 1,
          totalCredits: 7,
          settledAt: completedAt.toISOString(),
          breakdown: [
            {
              kind: "connector",
              credits: 7,
              providers: [{ provider, credits: 7 }],
            },
          ],
        },
      }),
    ]);
  }, 60_000);

  it("revises run usage when later usage settles", async () => {
    const { actor, agentId } = await entitledChatActorWithoutRunner(
      "Usage message agent",
    );
    const provider = `bdd-usage-${randomUUID().slice(0, 8)}`;
    const missingProvider = `${provider}-free`;
    const category = "api_request";
    await seedUsagePricingRows([
      { kind: "connector", provider, category, unitPrice: 7, unitSize: 2 },
    ]);

    const { runId, threadId } = await sendChatRun(actor, {
      agentId,
      prompt: "record billable usage",
    });
    const sandboxHeaders = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}`,
    };
    await webhooks.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider,
            category,
            quantity: 5,
          },
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: missingProvider,
            category,
            quantity: 1,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    const conflicting =
      await insertOutputEventWithConflictingLegacyPayloadFixture({
        threadId,
        runId,
        content: "explicit output event with stale usage payload",
        legacyPayload: "usage.recorded",
      });
    const page = await chat.listThreadEvents(actor, threadId);
    expect(page.events).toContainEqual(
      expect.objectContaining({
        id: conflicting.id,
        eventType: "output.message",
      }),
    );

    const billing = createBillingMediaApi(context);
    await billing.processOrgUsageEvents(actor);

    let usageEvents = await usageEventsForRun(actor, threadId, runId);
    expect(usageEvents).toHaveLength(1);
    const initialUsageEvent = usageEvents[0];
    if (!initialUsageEvent) {
      throw new Error("Expected one usage event");
    }
    expect(initialUsageEvent).toMatchObject({
      eventType: "usage.recorded",
      content: null,
      usage: {
        version: 1,
        totalCredits: 18,
        settledAt: expect.any(String),
        breakdown: [
          {
            kind: "connector",
            credits: 18,
            providers: expect.arrayContaining([
              { provider, credits: 18 },
              { provider: missingProvider, credits: 0 },
            ]),
          },
        ],
      },
    });

    onTestFinished(() => {
      clearMockNow();
    });
    // Sandbox tokens are validated against the mockable clock, so record late
    // usage before advancing time for settlement.
    await webhooks.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: missingProvider,
            category,
            quantity: 1,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    mockNow(new Date("2030-01-01T00:00:00.000Z"));
    await billing.processOrgUsageEvents(actor);
    usageEvents = await usageEventsForRun(actor, threadId, runId);
    expect(usageEvents).toStrictEqual([initialUsageEvent]);

    clearMockNow();
    await webhooks.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider,
            category,
            quantity: 3,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    mockNow(new Date("2030-01-01T00:00:01.000Z"));
    await billing.processOrgUsageEvents(actor);
    usageEvents = await usageEventsForRun(actor, threadId, runId);
    expect(usageEvents).toHaveLength(2);
    const firstRevision = usageEvents[1];
    if (!firstRevision) {
      throw new Error("Expected the first usage revision");
    }
    expect(firstRevision).toMatchObject({
      eventType: "usage.recorded",
      content: null,
      revokesEventId: initialUsageEvent.id,
      usage: {
        version: 1,
        totalCredits: 29,
        settledAt: initialUsageEvent.usage.settledAt,
        breakdown: [
          {
            kind: "connector",
            credits: 29,
            providers: expect.arrayContaining([
              { provider, credits: 29 },
              { provider: missingProvider, credits: 0 },
            ]),
          },
        ],
      },
    });

    clearMockNow();
    await webhooks.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider,
            category,
            quantity: 2,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    mockNow(new Date("2030-01-01T00:00:02.000Z"));
    await billing.processOrgUsageEvents(actor);
    usageEvents = await usageEventsForRun(actor, threadId, runId);
    expect(usageEvents).toHaveLength(3);
    expect(usageEvents[2]).toMatchObject({
      eventType: "usage.recorded",
      content: null,
      revokesEventId: firstRevision.id,
      usage: {
        version: 1,
        totalCredits: 36,
        settledAt: initialUsageEvent.usage.settledAt,
        breakdown: [
          {
            kind: "connector",
            credits: 36,
            providers: expect.arrayContaining([
              { provider, credits: 36 },
              { provider: missingProvider, credits: 0 },
            ]),
          },
        ],
      },
    });
  }, 60_000);

  it("emits complete allowance-covered usage in one event", async () => {
    const fixture = await seedBuiltInDefaultModelKey(context);
    const selectedModel = DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
    expect(fixture.selectedModel).toBe(selectedModel);

    const { actor, agentId } = await entitledChatActorWithoutRunner(
      "Allowance usage message agent",
    );
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected allowance chat actor to have an org");
    }
    await seedOrgMetadata({ orgId, tier: "pro", credits: 10 });
    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId,
      userId: actor.userId,
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      effectiveAt: new Date(now()),
      expiresAt: new Date(now() + 365 * 24 * 60 * 60 * 1000),
      shortWindowSeconds: 5 * 60 * 60,
      shortWindowUnits: 100,
      weeklyWindowSeconds: 7 * 24 * 60 * 60,
      weeklyWindowUnits: 100,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: selectedModel,
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const provider = `allowance-chat-${randomUUID().slice(0, 8)}`;
    const category = "api_request";
    await seedUsagePricingRows([
      { kind: "connector", provider, category, unitPrice: 1, unitSize: 1 },
    ]);
    const { runId, threadId } = await sendChatRun(actor, {
      agentId,
      prompt: "record allowance-covered usage",
      model: selectedModel,
    });
    const sandboxHeaders = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}`,
    };
    await webhooks.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider,
            category,
            quantity: 70,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await createBillingMediaApi(context).processOrgUsageEvents(actor);

    const usageEvents = await usageEventsForRun(actor, threadId, runId);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      eventType: "usage.recorded",
      content: null,
      usage: {
        version: 1,
        breakdown: [
          {
            kind: "connector",
            credits: 70,
            providers: [{ provider, credits: 70 }],
          },
        ],
        totalCredits: 70,
        settledAt: expect.any(String),
      },
    });
    const billingStatus = await api.readBillingStatus(actor);
    if (!billingStatus.usageAllowance) {
      throw new Error("Expected allowance windows for chat usage");
    }
    expect(
      Object.fromEntries(
        billingStatus.usageAllowance.windows.map((window) => {
          return [window.kind, window.consumedUnits];
        }),
      ),
    ).toStrictEqual({ short: 70, weekly: 70 });
  }, 60_000);

  it("emits zero-credit usage events and skips runs without usage", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Zero-credit usage message agent",
    );

    const agentRun = await sendChatRun(actor, {
      agentId,
      prompt: "record zero-credit usage",
    });
    const { sandboxHeaders: okouSandboxHeaders } = await claimChatRun(
      runnerGroup,
      agentRun.runId,
    );
    await webhooks.requestAgentUsageEvent(
      {
        runId: agentRun.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: `missing-${randomUUID().slice(0, 8)}`,
            category: "api_request",
            quantity: 1,
          },
        ],
      },
      okouSandboxHeaders,
      [200],
    );
    await completeChatRunOk(agentRun.runId, okouSandboxHeaders);
    await flushWaitUntilForTest();

    const [zeroUsageEvent] = await usageEventsForRun(
      actor,
      agentRun.threadId,
      agentRun.runId,
    );
    expect(zeroUsageEvent?.usage).toMatchObject({
      version: 1,
      totalCredits: 0,
      breakdown: [
        {
          kind: "connector",
          credits: 0,
          providers: [expect.objectContaining({ credits: 0 })],
        },
      ],
    });

    // A run that never recorded usage settles nothing, so completion must not
    // append a usage message. (The former pending-suppression variant is not
    // product-reachable: both production emitters settle the org's pending
    // usage immediately before emitting.)
    const quietRun = await sendChatRun(actor, {
      agentId,
      prompt: "complete without recording usage",
    });
    const { sandboxHeaders: quietSandboxHeaders } = await claimChatRun(
      runnerGroup,
      quietRun.runId,
    );
    await completeChatRunOk(quietRun.runId, quietSandboxHeaders);
    await flushWaitUntilForTest();
    await expect(
      usageEventsForRun(actor, quietRun.threadId, quietRun.runId),
    ).resolves.toHaveLength(0);
  }, 60_000);
});

const CHAT_EVENT_SEARCH_CRON_SECRET = "chat-event-search-cron-secret";

async function projectChatEventSearch() {
  mockEnv("CRON_SECRET", CHAT_EVENT_SEARCH_CRON_SECRET);
  const client = setupApp({
    context,
    routes: cronProjectChatEventSearchRoutes,
  })(cronProjectChatEventSearchContract);
  const response = await accept(
    client.project({
      headers: { authorization: `Bearer ${CHAT_EVENT_SEARCH_CRON_SECRET}` },
    }),
    [200],
  );
  return response.body;
}

describe("CHAT-01 chat search", () => {
  it("rejects search without an org session or the chat-event:read capability", async () => {
    const unauthenticated = await chat.requestSearchChat(
      null,
      "hello",
      {},
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const orgless = await chat.requestSearchChat(
      bdd.user({ orgId: null }),
      "hello",
      {},
      [401],
    );
    expectApiError(orgless.body);
    expect(orgless.body.error.code).toBe("UNAUTHORIZED");

    const sandboxBearer = api.sandboxTokenForRun(bdd.user(), randomUUID());
    const forbidden = await chat.searchChatWithBearer(
      `Bearer ${sandboxBearer}`,
      "hello",
      [403],
    );
    expectApiError(forbidden.body);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    expect(forbidden.body.error.message).toContain("chat-event:read");
  });

  it("searches own matched messages with filters", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    bdd.acceptAgentStorageWrites();
    const agentA = await bdd.createAgent(owner, {
      displayName: "Search agent A",
    });
    const agentB = await bdd.createAgent(owner, {
      displayName: "Search agent B",
    });

    const emptyResults = await chat.searchChat(owner, "quokka");
    expect(emptyResults).toStrictEqual({ results: [] });

    const blankKeyword = await chat.requestSearchChat(owner, "   ", {}, [400]);
    expectApiError(blankKeyword.body);

    // Peer-user isolation inside one org.
    const peerAgent = await bdd.createAgent(peer, {
      displayName: "Peer search agent",
    });
    await sendNoCreditMessage(peer, {
      agentId: peerAgent.agentId,
      prompt: "peer says supercalifragilistic",
    });
    const ownerThreadA = await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "owner says supercalifragilistic",
    });
    await projectChatEventSearch();
    const isolation = await chat.searchChat(owner, "supercalifragilistic");
    expect(isolation.results).toHaveLength(1);
    expect(isolation.results[0]?.chatThreadId).toBe(ownerThreadA);
    expect(isolation.results[0]?.matchedMessage.content).toBe(
      "owner says supercalifragilistic",
    );
    expect(isolation.results[0]?.matchedRanges).toStrictEqual([
      { start: 11, end: 31 },
    ]);
    expect(isolation.results[0]?.agentName).toStrictEqual(expect.any(String));

    // Canonical userMessage fields, not the legacy content projection, own
    // both matching and the returned display text.
    const canonicalKeyword = `canonical-${randomUUID()}`;
    const legacyKeyword = `legacy-${randomUUID()}`;
    const canonicalDisplay = `Find [Chat thread: ${canonicalKeyword} archive]`;
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: legacyKeyword,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Find " },
          {
            type: "chat_thread",
            threadId: ownerThreadA,
            titleSnapshot: `${canonicalKeyword} archive`,
          },
        ],
      },
    });
    await projectChatEventSearch();
    const canonicalSearch = await chat.searchChat(owner, canonicalKeyword);
    expect(canonicalSearch.results).toHaveLength(1);
    expect(canonicalSearch.results[0]?.matchedMessage.content).toBe(
      canonicalDisplay,
    );
    const legacySearch = await chat.searchChat(owner, legacyKeyword);
    expect(legacySearch.results).toStrictEqual([]);

    // Agent mention parts contribute their name snapshot to both keyword
    // matching and the canonical display projection.
    const mentionKeyword = `mention-${randomUUID()}`;
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: `legacy-${randomUUID()}`,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Ask " },
          {
            type: "agent",
            agentId: agentB.agentId,
            nameSnapshot: `${mentionKeyword} agent`,
          },
        ],
      },
    });
    await projectChatEventSearch();
    const mentionSearch = await chat.searchChat(owner, mentionKeyword);
    expect(mentionSearch.results).toHaveLength(1);
    expect(mentionSearch.results[0]?.matchedMessage.content).toBe(
      `Ask [Agent: ${mentionKeyword} agent]`,
    );

    // Cross-org isolation for the same user.
    const sameUserOtherOrg = bdd.user({ userId: owner.userId });
    const otherOrgAgent = await bdd.createAgent(sameUserOtherOrg, {
      displayName: "Other org search agent",
    });
    await sendNoCreditMessage(sameUserOtherOrg, {
      agentId: otherOrgAgent.agentId,
      prompt: "other-org supercalifragilistic sighting",
    });
    await projectChatEventSearch();
    const crossOrg = await chat.searchChat(owner, "supercalifragilistic");
    expect(crossOrg.results).toHaveLength(1);
    expect(crossOrg.results[0]?.chatThreadId).toBe(ownerThreadA);

    // The since filter keeps only messages at or after the boundary.
    const ancient = await sendNoCreditMessageResult(owner, {
      agentId: agentA.agentId,
      prompt: "ancient quokka spotted",
    });
    const sinceBoundary = await advanceNoCreditMessageCreatedAt(
      owner,
      agentA.agentId,
      ancient.createdAt,
    );
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "recent quokka spotted",
    });
    await projectChatEventSearch();
    const since = await chat.searchChat(owner, "quokka", {
      since: sinceBoundary,
    });
    expect(since.results).toHaveLength(1);
    expect(since.results[0]?.matchedMessage.content).toBe(
      "recent quokka spotted",
    );

    // The agentId filter scopes matches to one agent's threads.
    await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      prompt: "agent B mentions narwhal",
    });
    const narwhalThreadA = await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "agent A mentions narwhal",
    });
    await projectChatEventSearch();
    const byAgent = await chat.searchChat(owner, "narwhal", {
      agentId: agentA.agentId,
    });
    expect(byAgent.results).toHaveLength(1);
    expect(byAgent.results[0]?.chatThreadId).toBe(narwhalThreadA);
    expect(byAgent.results[0]?.matchedMessage.content).toBe(
      "agent A mentions narwhal",
    );

    // The old context request remains accepted during rollout, but only the
    // matched message is returned.
    const contextThread = await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      prompt: "context round one",
    });
    await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      threadId: contextThread,
      prompt: "the okapi was here",
    });
    await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      threadId: contextThread,
      prompt: "context round three",
    });
    await projectChatEventSearch();
    const contextual = await chat.searchChat(owner, "okapi");
    expect(contextual.results).toHaveLength(1);
    const match = contextual.results[0];
    if (!match) {
      throw new Error("Expected one okapi match");
    }
    expect(match.matchedMessage.content).toBe("the okapi was here");
  }, 60_000);

  it("returns batched matched messages without context across threads", async () => {
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agentA = await bdd.createAgent(owner, {
      displayName: "Batched search agent A",
    });
    const agentB = await bdd.createAgent(owner, {
      displayName: "Batched search agent B",
    });
    const marker = `batched-${randomUUID()}`;
    const alphaPrompt = `${marker} needle alpha`;
    const betaPrompt = `${marker} needle beta`;
    const gammaPrompt = `${marker} needle gamma`;

    const threadA = await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: alphaPrompt,
    });
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      threadId: threadA,
      prompt: betaPrompt,
    });

    const threadB = await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      prompt: gammaPrompt,
    });

    await projectChatEventSearch();
    const contextual = await chat.searchChat(owner, `${marker} needle`);
    expect(
      contextual.results
        .map((result) => {
          return result.matchedMessage.content;
        })
        .sort(),
    ).toStrictEqual([alphaPrompt, betaPrompt, gammaPrompt].sort());

    const matchesByContent = new Map(
      contextual.results.map((result) => {
        return [result.matchedMessage.content, result] as const;
      }),
    );
    const alpha = matchesByContent.get(alphaPrompt);
    const beta = matchesByContent.get(betaPrompt);
    const gamma = matchesByContent.get(gammaPrompt);
    if (!alpha || !beta || !gamma) {
      throw new Error("Expected all batched chat-search matches");
    }
    expect(alpha.chatThreadId).toBe(threadA);
    expect(beta.chatThreadId).toBe(threadA);
    expect(gamma.chatThreadId).toBe(threadB);
  }, 60_000);
});

describe("CHAT-01 chat search index", () => {
  function assistantOutputEvent(
    sequenceNumber: number,
    text: string,
  ): Record<string, unknown> {
    return {
      eventType: "assistant",
      sequenceNumber,
      eventData: { message: { content: [{ type: "text", text }] } },
    };
  }

  it("serves index-backed keyword search from the projection by default", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "Search index agent",
    });
    const peerAgent = await bdd.createAgent(peer, {
      displayName: "Search index peer agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: "今天天气很好，今天天气，vercel 部署完成",
    });
    await sendNoCreditMessage(peer, {
      agentId: peerAgent.agentId,
      prompt: "peer 今天天气 message",
    });

    // The projector has not indexed either thread yet, so search recalls
    // nothing until the first projection tick.
    const beforeProjection = await chat.searchChat(owner, "天气");
    expect(beforeProjection.results).toStrictEqual([]);

    const firstTick = await projectChatEventSearch();
    expect(firstTick.success).toBeTruthy();
    expect(firstTick.threads).toBeGreaterThanOrEqual(2);
    expect(firstTick.indexedEvents).toBeGreaterThanOrEqual(2);

    // CJK bigram recall: one bigram, an adjacent phrase, and a CJK+word AND.
    for (const keyword of ["天气", "今天天气", "天气 vercel"]) {
      const found = await chat.searchChat(owner, keyword);
      expect(found.results).toHaveLength(1);
      expect(found.results[0]?.chatThreadId).toBe(threadId);
      expect(found.results[0]?.matchedMessage.content).toBe(
        "今天天气很好，今天天气，vercel 部署完成",
      );
    }
    const repeatedCjk = await chat.searchChat(owner, "今天天气");
    expect(repeatedCjk.results[0]?.matchedRanges).toStrictEqual([
      { start: 0, end: 4 },
      { start: 7, end: 11 },
    ]);

    // Neither a single CJK character nor punctuation has an indexable form,
    // so those keywords cannot match.
    const singleChar = await chat.searchChat(owner, "好");
    expect(singleChar.results).toStrictEqual([]);
    const punctuation = await chat.searchChat(owner, "，");
    expect(punctuation.results).toStrictEqual([]);

    // Word tokens match whole words only under the index path.
    const partialWord = await chat.searchChat(owner, "verce");
    expect(partialWord.results).toStrictEqual([]);
    const wholeWord = await chat.searchChat(owner, "vercel");
    expect(wholeWord.results).toHaveLength(1);
    expect(wholeWord.results[0]?.matchedRanges).toStrictEqual([
      { start: 12, end: 18 },
    ]);

    // Re-running the projector is idempotent for already-indexed threads.
    const secondTick = await projectChatEventSearch();
    expect(secondTick.success).toBeTruthy();
    const stable = await chat.searchChat(owner, "天气");
    expect(stable.results).toHaveLength(1);
  }, 60_000);

  it("excludes future follow-up content from indexed matches and context", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Follow-up search exclusion agent",
    );
    const visibleNeedle = `visiblemessage${randomUUID().replaceAll("-", "")}`;
    const followupOnlyNeedle = `futurefollowup${randomUUID().replaceAll("-", "")}`;
    mockOptionalEnv("OPENROUTER_API_KEY", "follow-up-search-key");
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const body = await request.text();
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: body.includes("recommended follow-up messages")
                    ? JSON.stringify([
                        { prompt: followupOnlyNeedle, kind: "talk" },
                      ])
                    : "Follow-up search exclusion",
                },
              },
            ],
          });
        },
      ),
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: visibleNeedle,
    });
    const { sandboxHeaders } = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantOutputEvent(0, "Follow-up search response"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders);
    await waitForThreadMessages(actor, run.threadId, (messages) => {
      return messages.some((message) => {
        return (
          message.eventType === "output.followups" &&
          (message.content?.includes(followupOnlyNeedle) ?? false)
        );
      });
    });

    const tick = await projectChatEventSearch();
    expect(tick.success).toBeTruthy();

    const visibleHit = await chat.searchChat(actor, visibleNeedle);
    expect(visibleHit.results).toHaveLength(1);

    const followupHit = await chat.searchChat(actor, followupOnlyNeedle);
    expect(followupHit.results).toStrictEqual([]);
  }, 60_000);

  it("indexes assistant output through the projection", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Search index assistant agent",
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "帮我查询部署状态基线",
    });
    const { sandboxHeaders } = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantOutputEvent(0, "axolotl 部署一切正常"),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders);
    await waitForThreadMessages(actor, run.threadId, (messages) => {
      return messages.some((message) => {
        return (
          message.eventType === "output.message" &&
          (message.content?.includes("axolotl") ?? false)
        );
      });
    });

    const tick = await projectChatEventSearch();
    expect(tick.success).toBeTruthy();

    const assistantHit = await chat.searchChat(actor, "axolotl");
    expect(assistantHit.results).toHaveLength(1);
    expect(assistantHit.results[0]?.matchedMessage.role).toBe("assistant");
    expect(assistantHit.results[0]?.matchedMessage.content).toBe(
      "axolotl 部署一切正常",
    );
    // The prompt and the assistant reply share the 部署 bigram; run
    // lifecycle rows around them stay out of the index.
    const both = await chat.searchChat(actor, "部署");
    expect(both.results).toHaveLength(2);
  }, 60_000);

  it("ignores a thread deleted before projection", async () => {
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "Search deletion race agent",
    });
    const marker = `projectiondelete${randomUUID().replaceAll("-", "")}`;
    const threadA = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${marker} alpha`,
    });
    const threadB = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${marker} beta`,
    });
    await chat.deleteThread(owner, threadB);
    const tick = await projectChatEventSearch();
    expect(tick.success).toBeTruthy();

    const found = await chat.searchChat(owner, marker);
    expect(found.results).toHaveLength(1);
    expect(found.results[0]?.chatThreadId).toBe(threadA);
    const deleted = await chat.requestReadThread(owner, threadB, [404]);
    expectApiError(deleted.body);
  }, 60_000);

  it("applies agent and since filters inside the projection", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    bdd.acceptAgentStorageWrites();
    const agentA = await bdd.createAgent(owner, {
      displayName: "Index filter agent A",
    });
    const agentB = await bdd.createAgent(owner, {
      displayName: "Index filter agent B",
    });

    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "旧的水豚记录一",
    });
    const oldMessage = await sendNoCreditMessageResult(owner, {
      agentId: agentA.agentId,
      prompt: "旧的水豚记录二",
    });
    const sinceBoundary = await advanceNoCreditMessageCreatedAt(
      owner,
      agentA.agentId,
      oldMessage.createdAt,
    );
    const recentMessageA = await sendNoCreditMessageResult(owner, {
      agentId: agentA.agentId,
      prompt: "新的水豚记录",
    });
    await advanceNoCreditMessageCreatedAt(
      owner,
      agentA.agentId,
      recentMessageA.createdAt,
    );
    const threadB = await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      prompt: "另一个水豚记录",
    });
    const recentThreadA = recentMessageA.threadId;
    const tick = await projectChatEventSearch();
    expect(tick.success).toBeTruthy();

    const all = await chat.searchChat(owner, "水豚");
    expect(all.results).toHaveLength(4);

    // `since` is answered by the projection's own created_at.
    const since = await chat.searchChat(owner, "水豚", {
      since: sinceBoundary,
    });
    expect(
      since.results.map((result) => {
        return result.chatThreadId;
      }),
    ).toStrictEqual([threadB, recentThreadA]);

    // The Agent scope comes from the canonical Agent reference, so no join
    // takes part in selecting rows.
    const byAgent = await chat.searchChat(owner, "水豚", {
      agentId: agentB.agentId,
    });
    expect(byAgent.results).toHaveLength(1);
    expect(byAgent.results[0]?.chatThreadId).toBe(threadB);
  }, 60_000);
});

describe("CHAT-03 thread artifacts and google drive status", () => {
  it.each(["hosted-site", "presentation-html"] as const)(
    "exports private %s as an owned bundle to Google Drive",
    async (artifactKind) => {
      const { actor, agentId } = await entitledChatActor(
        "Private HTML Drive owner",
      );
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      await createBillingMediaApi(context).updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PrivateArtifacts]: true,
      });
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Create a private HTML artifact",
      });
      const objectStore = chatCallbacks.acceptChatObjectStorage();
      context.mocks.s3.getSignedUrl.mockResolvedValue(
        "https://r2.example.com/hosted-upload?sig=test",
      );
      const index =
        '<!doctype html><link rel="stylesheet" href="/assets/style.css"><h1>Private report</h1>';
      const css = "h1 { color: green }";
      const bearer = okouCapabilityHeaders(actor, run.runId, [
        "host:write",
      ]).authorization;
      const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
        site: `private-drive-${randomUUID().slice(0, 8)}`,
        artifactKind,
        spaFallback: false,
        files: [
          hostedTextFile("/index.html", index),
          hostedTextFile("/assets/style.css", css),
        ],
      });
      for (const [path, body] of [
        ["/index.html", index],
        ["/assets/style.css", css],
      ] as const) {
        objectStore.addObject({
          bucket: "test-hosted-sites",
          key: `private-sites/okou/${prepared.deploymentId}${path}`,
          size: Buffer.byteLength(body),
          body: Buffer.from(body),
        });
      }
      await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
      const artifacts = await chat.listThreadArtifacts(actor, run.threadId);
      const artifact = artifacts.runs
        .flatMap((item) => {
          return item.files;
        })
        .find((file) => {
          return file.url === prepared.url;
        });
      if (!artifact) {
        throw new Error("Expected private hosted artifact");
      }
      mockGoogleDriveConnectorOAuth();
      const start = await connectorsApi.startOauth(
        actor,
        "google-drive",
        "oauth",
      );
      await connectorsApi.completeOauthCallback("google-drive", {
        code: "drive-ok",
        state: stateFromAuthorizationUrl(start.authorizationUrl),
      });
      await api.enableAgentConnectors(actor, agentId, ["google-drive"]);
      const upload = mockGoogleDriveArtifactUpload({
        id: "private-drive-file",
        name: "private-report.zip",
      });
      const synced = await chat.requestSyncThreadArtifact(
        actor,
        run.threadId,
        { runId: run.runId, fileId: artifact.id },
        [200],
      );
      expect(synced.body).toMatchObject({ id: "private-drive-file" });
      const multipart = Buffer.from(upload.bodies[0]!);
      expect(multipart.toString("utf8")).toContain("application/zip");
      const zip = new AdmZip(
        multipart.subarray(
          multipart.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
        ),
      );
      expect(
        zip
          .getEntries()
          .map((entry) => {
            return entry.entryName;
          })
          .sort(),
      ).toStrictEqual(["assets/style.css", "index.html"]);
      expect(zip.readAsText("index.html")).toBe(index);
      expect(zip.readAsText("assets/style.css")).toBe(css);
      expect(
        objectStore.puts.filter((put) => {
          return put.key.startsWith("artifacts/");
        }),
      ).toStrictEqual([]);
    },
  );

  it("groups run uploads and reports google drive sync status", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Artifacts drive status agent",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const peer = bdd.user({ orgId: actor.orgId });

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "produce thread artifacts",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const runBearer = `Bearer ${okouTokenFromClaim(claim)}`;

    const unauthenticated = await chat.requestListThreadArtifacts(
      null,
      run.threadId,
      [401],
    );
    expectApiError(unauthenticated.body);
    const crossUser = await chat.requestListThreadArtifacts(
      peer,
      run.threadId,
      [404],
    );
    expectApiError(crossUser.body);
    expect(crossUser.body.error.code).toBe("NOT_FOUND");

    // Two uploads recorded under the run through its sandbox-scoped token.
    // The csv complete omits contentType so the route infers it from the key.
    const csvId = randomUUID();
    const pdfId = randomUUID();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${csvId}/data.csv`,
      size: 2048,
    });
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${pdfId}/report.pdf`,
      size: 512,
    });
    await chat.completeUploadWithBearer(runBearer, { id: csvId }, [200]);
    await chat.completeUploadWithBearer(runBearer, { id: pdfId }, [200]);

    let artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expect(artifacts.runs).toHaveLength(1);
    expect(artifacts.runs[0]?.runId).toBe(run.runId);
    expect(artifacts.runs[0]?.files).toHaveLength(2);
    const csvFile = artifacts.runs[0]?.files.find((file) => {
      return file.id === csvId;
    });
    expect(csvFile).toMatchObject({
      filename: "data.csv",
      contentType: "text/csv",
      size: 2048,
      url: expect.stringContaining(`/${csvId}/data.csv`),
      googleDriveSync: { status: "disconnected" },
    });
    const pdfFile = artifacts.runs[0]?.files.find((file) => {
      return file.id === pdfId;
    });
    expect(pdfFile).toMatchObject({
      filename: "report.pdf",
      contentType: "application/pdf",
      googleDriveSync: { status: "disconnected" },
    });
    expectDriveStatuses(artifacts, {
      status: "disconnected",
      recovery: { action: "connect" },
    });

    // Sync requires a connected Drive.
    const noConnector = await chat.requestSyncThreadArtifact(
      actor,
      run.threadId,
      { runId: run.runId, fileId: csvId },
      [400],
    );
    expectApiError(noConnector.body);
    expect(noConnector.body.error.message).toBe(
      "Connect Google Drive before syncing artifacts",
    );

    // Connect Google Drive through the public OAuth routes.
    mockGoogleDriveConnectorOAuth();
    const start = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-ok",
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });
    const connected = await connectorsApi.readConnectorBySlug(
      actor,
      "google-drive",
    );
    expect(connected.connectionStatus).toBe("connected");

    // A connected Drive still needs to be enabled for the thread's agent.
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expectDriveStatuses(artifacts, {
      status: "disconnected",
      recovery: { action: "authorize" },
    });
    const disabledForAgent = await chat.requestSyncThreadArtifact(
      actor,
      run.threadId,
      { runId: run.runId, fileId: csvId },
      [400],
    );
    expectApiError(disabledForAgent.body);
    expect(disabledForAgent.body.error.message).toBe(
      "Connect Google Drive before syncing artifacts",
    );

    const unknownArtifact = await chat.requestSyncThreadArtifact(
      actor,
      run.threadId,
      { runId: randomUUID(), fileId: randomUUID() },
      [404],
    );
    expectApiError(unknownArtifact.body);
    expect(unknownArtifact.body.error.message).toBe("Artifact file not found");

    const invalidBody = await chat.requestSyncThreadArtifactUnchecked(
      actor,
      run.threadId,
      { runId: 7 },
      [400],
    );
    expectApiError(invalidBody.body);
    expect(invalidBody.body.error.code).toBe("BAD_REQUEST");

    await api.enableAgentConnectors(actor, agentId, ["google-drive"]);

    const uploadRecorder = mockGoogleDriveArtifactUpload({
      id: "drive-uploaded-file",
      name: "data.csv",
      webViewLink: "https://drive.google.com/file/d/drive-uploaded-file/view",
    });
    const synced = await chat.requestSyncThreadArtifact(
      actor,
      run.threadId,
      { runId: run.runId, fileId: csvId },
      [200],
    );
    expect(synced.body).toStrictEqual({
      id: "drive-uploaded-file",
      name: "data.csv",
      webViewLink: "https://drive.google.com/file/d/drive-uploaded-file/view",
    });
    expect(uploadRecorder.authorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-ok",
    ]);
    expect(uploadRecorder.folderQueries).toHaveLength(2);
    expect(uploadRecorder.contentTypeHeaders[0]).toMatch(
      /^multipart\/related; boundary=multipart-/u,
    );
    // Fetch derives this forbidden request header from the Buffer body at the
    // transport layer. Supplying it explicitly is rejected by instrumented
    // Node/Undici and would be visible to MSW here.
    expect(uploadRecorder.contentLengthHeaders).toStrictEqual([null]);

    // Drive lists one mirrored file: csv synced, pdf not synced.
    const listRecorder = mockGoogleDriveFilesList(() => {
      return {
        status: 200,
        files: [
          {
            id: "drive-file-1",
            name: "data.csv",
            webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
            appProperties: {
              vm0Artifact: "true",
              vm0ThreadId: run.threadId,
              vm0RunId: run.runId,
              vm0FileId: csvId,
            },
          },
        ],
      };
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expect(
      artifacts.runs[0]?.files.find((file) => {
        return file.id === csvId;
      })?.googleDriveSync,
    ).toStrictEqual({
      status: "synced",
      accountReady: true,
      id: "drive-file-1",
      name: "data.csv",
      webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
    });
    expect(
      artifacts.runs[0]?.files.find((file) => {
        return file.id === pdfId;
      })?.googleDriveSync,
    ).toStrictEqual({ status: "not_synced", accountReady: true });
    expect(listRecorder.queries[0]).toContain("vm0Artifact");
    expect(listRecorder.queries[0]).toContain(run.threadId);

    // A successful refresh is persisted, so the next poll uses the refreshed
    // access token without another token request.
    const successfulRefresh = mockGoogleDriveConnectorOAuth({
      refreshOutcome: {
        type: "ok",
        accessToken: "drive-access-refreshed",
      },
    });
    const refreshedList = mockGoogleDriveFilesList((request) => {
      if (
        request.headers.get("authorization") !== "Bearer drive-access-refreshed"
      ) {
        return { status: 401 };
      }
      return {
        status: 200,
        files: [
          {
            id: "drive-file-refreshed",
            name: "data.csv",
            appProperties: {
              vm0Artifact: "true",
              vm0ThreadId: run.threadId,
              vm0RunId: run.runId,
              vm0FileId: csvId,
            },
          },
        ],
      };
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expect(
      artifacts.runs[0]?.files.find((file) => {
        return file.id === csvId;
      })?.googleDriveSync,
    ).toMatchObject({
      status: "synced",
      accountReady: true,
      id: "drive-file-refreshed",
    });
    await chat.listThreadArtifacts(actor, run.threadId);
    expect(successfulRefresh.refreshBodies).toHaveLength(1);
    expect(refreshedList.authorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-ok",
      "Bearer drive-access-refreshed",
      "Bearer drive-access-refreshed",
    ]);

    // Transient OAuth failures remain connected and retry on later polls.
    const transientRefresh = mockGoogleDriveConnectorOAuth({
      refreshOutcome: { type: "server-error" },
    });
    mockGoogleDriveFilesList(() => {
      return { status: 401 };
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      artifacts = await chat.listThreadArtifacts(actor, run.threadId);
      expectDriveStatuses(artifacts, {
        status: "unknown",
        accountReady: true,
      });
    }
    expect(transientRefresh.refreshBodies).toHaveLength(2);
    await expect(
      connectorsApi.readConnectorBySlug(actor, "google-drive"),
    ).resolves.toMatchObject({ connectionStatus: "connected" });

    // A terminal failure is persisted and immediately becomes disconnected.
    // The stored state prevents both Drive and token requests on later polls.
    const terminalRefresh = mockGoogleDriveConnectorOAuth();
    const terminalList = mockGoogleDriveFilesList(() => {
      return { status: 401 };
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expectDriveStatuses(artifacts, {
      status: "disconnected",
      recovery: { action: "reconnect", connectionId: connected.id },
    });
    await expect(
      connectorsApi.readConnectorBySlug(actor, "google-drive"),
    ).resolves.toMatchObject({
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expectDriveStatuses(artifacts, {
      status: "disconnected",
      recovery: { action: "reconnect", connectionId: connected.id },
    });
    expect(terminalRefresh.refreshBodies).toHaveLength(1);
    expect(terminalList.authorizationHeaders).toHaveLength(1);

    // Reconnecting clears the terminal state and restores normal status
    // resolution before another terminal provider failure occurs.
    const reconnectStart = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: connected.id },
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-reconnected",
      state: stateFromAuthorizationUrl(reconnectStart.authorizationUrl),
    });
    await expect(
      connectorsApi.readConnectorBySlug(actor, "google-drive"),
    ).resolves.toMatchObject({
      connectionStatus: "connected",
      reconnectReason: null,
    });
    mockGoogleDriveFilesList((request) => {
      if (
        request.headers.get("authorization") !==
        "Bearer drive-access-drive-reconnected"
      ) {
        return { status: 401 };
      }
      return {
        status: 200,
        files: [
          {
            id: "drive-file-reconnected",
            name: "data.csv",
            appProperties: {
              vm0Artifact: "true",
              vm0ThreadId: run.threadId,
              vm0RunId: run.runId,
              vm0FileId: csvId,
            },
          },
        ],
      };
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expect(
      artifacts.runs[0]?.files.find((file) => {
        return file.id === csvId;
      })?.googleDriveSync,
    ).toMatchObject({
      status: "synced",
      accountReady: true,
      id: "drive-file-reconnected",
    });

    // Google session-control expiry retains its precise reconnect reason.
    const sessionExpiredRefresh = mockGoogleDriveConnectorOAuth({
      refreshOutcome: {
        type: "invalid-grant",
        errorSubtype: "invalid_rapt",
      },
    });
    mockGoogleDriveFilesList(() => {
      return { status: 401 };
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expectDriveStatuses(artifacts, {
      status: "disconnected",
      recovery: { action: "reconnect", connectionId: connected.id },
    });
    expect(sessionExpiredRefresh.refreshBodies).toHaveLength(1);
    await expect(
      connectorsApi.readConnectorBySlug(actor, "google-drive"),
    ).resolves.toMatchObject({
      connectionStatus: "reconnect-required",
      reconnectReason: "provider_session_expired",
    });

    // Unknown subtypes stay terminal without inventing a reconnect reason.
    const unknownSubtypeRefresh = mockGoogleDriveConnectorOAuth({
      refreshOutcome: {
        type: "invalid-grant",
        errorSubtype: "unknown_subtype",
      },
    });
    const secondReconnectStart = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: connected.id },
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-reconnected-again",
      state: stateFromAuthorizationUrl(secondReconnectStart.authorizationUrl),
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expectDriveStatuses(artifacts, {
      status: "disconnected",
      recovery: { action: "reconnect", connectionId: connected.id },
    });
    expect(unknownSubtypeRefresh.refreshBodies).toHaveLength(1);
    await expect(
      connectorsApi.readConnectorBySlug(actor, "google-drive"),
    ).resolves.toMatchObject({
      connectionStatus: "reconnect-required",
      reconnectReason: null,
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders);
  }, 120_000);

  it("uses the selected google drive account for artifact status and sync", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Artifacts selected drive account agent",
    );
    if (!actor.orgId) {
      throw new Error("Expected an entitled chat actor with an organization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const objectStore = chatCallbacks.acceptChatObjectStorage();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "produce an account-bound artifact",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const runBearer = `Bearer ${okouTokenFromClaim(claim)}`;
    const fileId = randomUUID();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${fileId}/account.txt`,
      size: 64,
    });
    await chat.completeUploadWithBearer(runBearer, { id: fileId }, [200]);

    mockGoogleDriveConnectorOAuth({
      userInfo: {
        id: "bdd-drive-default-user-id",
        email: "bdd-drive-default@example.test",
        name: "BDD Drive Default",
      },
    });
    const defaultStart = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
      undefined,
      { intent: "add", displayName: "Default Drive" },
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-default",
      state: stateFromAuthorizationUrl(defaultStart.authorizationUrl),
    });

    mockGoogleDriveConnectorOAuth({
      userInfo: {
        id: "bdd-drive-selected-user-id",
        email: "bdd-drive-selected@example.test",
        name: "BDD Drive Selected",
      },
    });
    const selectedStart = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
      undefined,
      { intent: "add", displayName: "Selected Drive" },
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-selected",
      state: stateFromAuthorizationUrl(selectedStart.authorizationUrl),
    });

    const accounts = await connectorsApi.listBuiltinConnectorAccounts(
      actor,
      "google-drive",
    );
    expect(accounts).toHaveLength(2);
    const defaultAccount = accounts.find((account) => {
      return account.externalEmail === "bdd-drive-default@example.test";
    });
    const selectedAccount = accounts.find((account) => {
      return account.externalEmail === "bdd-drive-selected@example.test";
    });
    if (!defaultAccount || !selectedAccount) {
      throw new Error("Expected two distinct Google Drive accounts");
    }
    expect(defaultAccount).toMatchObject({
      isDefault: true,
      connectionStatus: "connected",
    });
    expect(selectedAccount).toMatchObject({
      isDefault: false,
      connectionStatus: "connected",
    });
    await api.enableAgentConnectors(actor, agentId, ["google-drive"]);

    const defaultRefresh = mockGoogleDriveConnectorOAuth();
    const defaultStatusRecorder = mockGoogleDriveFilesList(() => {
      return { status: 401 };
    });
    let artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expectDriveStatuses(artifacts, {
      status: "disconnected",
      recovery: {
        action: "reconnect",
        connectionId: defaultAccount.id,
      },
    });
    expect(defaultStatusRecorder.authorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-default",
    ]);
    expect(defaultRefresh.refreshBodies).toHaveLength(1);

    const selected = await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(actor),
        params: { id: run.threadId },
        body: {
          connectionId: selectedAccount.id,
          target: { kind: "builtin", connectorSlug: "google-drive" },
        },
      }),
      [200],
    );
    expect(selected.body.connectionId).toBe(selectedAccount.id);

    await api.enableAgentConnectors(actor, agentId, []);
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expectDriveStatuses(artifacts, {
      status: "disconnected",
      recovery: { action: "authorize" },
    });
    expect(defaultStatusRecorder.authorizationHeaders).toHaveLength(1);

    await api.enableAgentConnectors(actor, agentId, ["google-drive"]);
    const selectedStatusRecorder = mockGoogleDriveFilesList(() => {
      return { status: 200, files: [] };
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expectDriveStatuses(artifacts, {
      status: "not_synced",
      accountReady: true,
    });
    expect(selectedStatusRecorder.authorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-selected",
    ]);

    const uploadRecorder = mockGoogleDriveArtifactUpload({
      id: "drive-selected-upload",
      name: "account.txt",
      webViewLink: "https://drive.google.com/file/d/drive-selected-upload/view",
    });
    const synced = await chat.requestSyncThreadArtifact(
      actor,
      run.threadId,
      { runId: run.runId, fileId },
      [200],
    );
    expect(synced.body).toMatchObject({
      id: "drive-selected-upload",
      name: "account.txt",
    });
    expect(uploadRecorder.folderAuthorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-selected",
      "Bearer drive-access-drive-selected",
    ]);
    expect(uploadRecorder.authorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-selected",
    ]);

    mockGoogleDriveConnectorOAuth({
      userInfo: {
        id: "bdd-drive-default-user-id",
        email: "bdd-drive-default@example.test",
        name: "BDD Drive Default",
      },
    });
    const defaultReconnectStart = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: defaultAccount.id },
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-default-reconnected",
      state: stateFromAuthorizationUrl(defaultReconnectStart.authorizationUrl),
    });

    const terminalRefresh = mockGoogleDriveConnectorOAuth();
    const terminalStatusRecorder = mockGoogleDriveFilesList(() => {
      return { status: 401 };
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expectDriveStatuses(artifacts, {
      status: "disconnected",
      recovery: {
        action: "reconnect",
        connectionId: selectedAccount.id,
      },
    });
    expect(terminalStatusRecorder.authorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-selected",
    ]);
    expect(terminalRefresh.refreshBodies).toHaveLength(1);
    expect(terminalRefresh.refreshBodies[0]?.get("refresh_token")).toBe(
      "drive-refresh-drive-selected",
    );

    const refreshedAccounts = await connectorsApi.listBuiltinConnectorAccounts(
      actor,
      "google-drive",
    );
    expect(
      refreshedAccounts.find((account) => {
        return account.id === defaultAccount.id;
      }),
    ).toMatchObject({
      connectionStatus: "connected",
      reconnectReason: null,
    });
    expect(
      refreshedAccounts.find((account) => {
        return account.id === selectedAccount.id;
      }),
    ).toMatchObject({
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    });

    const unavailable = await chat.requestSyncThreadArtifact(
      actor,
      run.threadId,
      { runId: run.runId, fileId },
      [400],
    );
    expectApiError(unavailable.body);
    expect(unavailable.body.error.message).toBe(
      "Connect Google Drive before syncing artifacts",
    );
    expect(terminalStatusRecorder.authorizationHeaders).toHaveLength(1);
    expect(uploadRecorder.folderAuthorizationHeaders).toHaveLength(2);
    expect(uploadRecorder.authorizationHeaders).toHaveLength(1);

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders);
  }, 120_000);

  it("dedupes artifact urls and filters hosted-site runs", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Artifacts dedupe agent",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const objectStore = chatCallbacks.acceptChatObjectStorage();

    // Run 1 uploads its own file plus the shared one.
    const run1 = await sendChatRun(actor, {
      agentId,
      prompt: "first artifact run",
    });
    const claim1 = await claimChatRun(runnerGroup, run1.runId);
    const bearer1 = `Bearer ${okouTokenFromClaim(claim1.claim)}`;
    const ownId = randomUUID();
    const sharedId = randomUUID();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${ownId}/page-a.html`,
      size: 128,
    });
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${sharedId}/page.html`,
      size: 256,
    });
    await chat.completeUploadWithBearer(bearer1, { id: ownId }, [200]);
    await chat.completeUploadWithBearer(bearer1, { id: sharedId }, [200]);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run1.runId, claim1.sandboxHeaders);
    // Run 1's completion drains the thread queue via waitUntil side effects;
    // flush them so the drain cannot claim run 2's queued message first.
    await flushWaitUntilForTest();

    // Run 2 in the same thread re-completes the shared upload: the later
    // run owns the deduplicated URL.
    const run2 = await sendChatRun(actor, {
      agentId,
      threadId: run1.threadId,
      prompt: "second artifact run",
    });
    const claim2 = await claimChatRun(runnerGroup, run2.runId);
    const bearer2 = `Bearer ${okouTokenFromClaim(claim2.claim)}`;
    await chat.completeUploadWithBearer(bearer2, { id: sharedId }, [200]);

    let artifacts = await chat.listThreadArtifacts(actor, run1.threadId);
    expect(artifacts.runs).toHaveLength(2);
    const run1Group = artifacts.runs.find((group) => {
      return group.runId === run1.runId;
    });
    const run2Group = artifacts.runs.find((group) => {
      return group.runId === run2.runId;
    });
    expect(
      run1Group?.files.map((file) => {
        return file.id;
      }),
    ).toStrictEqual([ownId]);
    expect(
      run2Group?.files.map((file) => {
        return file.id;
      }),
    ).toStrictEqual([sharedId]);

    // A hosted-site deployment on run 2 hides its plain uploads while the
    // plain run keeps its files. With run 2's plain copy of the shared URL
    // filtered out, the URL dedupe no longer applies and run 1 surfaces its
    // own copy again.
    const prepared = await chat.prepareHostedSiteWithBearer(bearer2, {
      site: `bdd-artifact-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>artifact run</main>")],
    });
    await chat.completeHostedSiteWithBearer(bearer2, prepared.deploymentId);

    artifacts = await chat.listThreadArtifacts(actor, run1.threadId);
    const hostedGroup = artifacts.runs.find((group) => {
      return group.runId === run2.runId;
    });
    expect(hostedGroup?.files).toHaveLength(1);
    expect(hostedGroup?.files[0]).toMatchObject({
      artifactKind: "hosted-site",
      url: prepared.artifactUrl,
      aliasUrl: prepared.url,
      contentType: "text/html",
    });
    const plainGroup = artifacts.runs.find((group) => {
      return group.runId === run1.runId;
    });
    expect(
      plainGroup?.files.map((file) => {
        return file.id;
      }),
    ).toStrictEqual([ownId, sharedId]);

    // A Drive connection without a refresh token resolves 401s to "unknown".
    mockGoogleDriveConnectorOAuth({ omitRefreshToken: true });
    const start = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-no-refresh",
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });
    await api.enableAgentConnectors(actor, agentId, ["google-drive"]);
    mockGoogleDriveFilesList(() => {
      return { status: 401 };
    });
    artifacts = await chat.listThreadArtifacts(actor, run1.threadId);
    for (const group of artifacts.runs) {
      for (const file of group.files) {
        expect(file.googleDriveSync).toStrictEqual({
          status: "unknown",
          accountReady: true,
        });
      }
    }

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run2.runId, claim2.sandboxHeaders);
  }, 120_000);
});
