import { utils as compoundUtils, write as writeCompoundFile } from "cfb";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { hostRoutes } from "../host";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  type GoogleDriveUploadMode,
} from "@okouai/core/google-workspace-conversion";
import { chatThreadsArtifactsSyncRoutes } from "../chat-threads-artifacts-sync";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
  chatThreadUsageContract,
  type ChatEvent,
  type ChatEventUsagePayload,
  type ChatThreadArtifactGoogleDriveSync,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import AdmZip from "adm-zip";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { webDownloadRoutes } from "../web-download";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGoogleDriveArtifactUpload,
  mockGoogleDriveArtifactUploadRejection,
  mockGoogleDriveConnectorOAuth,
  mockGoogleDriveFilesList,
  mockGoogleSlidesReadback,
  mockGoogleWorkspaceReadback,
} from "./helpers/api-bdd-connectors";
import {
  hostedTextFile,
  installHostedUploadTransport,
  uploadHostedTextFiles,
} from "./helpers/api-bdd-host-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { chatEventDisplayText } from "./helpers/chat-event";
import { readThreadMessagesAfterBackgroundWork } from "./helpers/chat-events-fixture";
import {
  docsImportFixture,
  uploadedDocsText,
} from "./helpers/docs-import-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createPublicComputerUseHosts } from "./helpers/public-computer-use-hosts";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { createPublicFirewallFixture } from "./helpers/public-firewall-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import {
  mockSlidesImportFonts,
  slidesImportFixture,
  slidesPictureCropFixture,
  slidesPictureCropNoopFixture,
  uploadedSlidesPictures,
  uploadedSlidesText,
} from "./helpers/slides-import-fixture";
const TEST_APP_ROUTES = Object.freeze([...chatThreadRoutes]);

/**
 * CHAT-01 / CHAT-03: chat thread lifecycle beyond the mutation chain that
 * lives in chat-files.bdd.test.ts — event snapshots and read state, thread
 * detail model pins, create/delete cascades, search, thread artifacts with
 * Google Drive sync status.
 *
 * Most Given state is constructed through public APIs (Stripe-webhook
 * entitlement, personal model provider routes, runner heartbeat/claim, sandbox
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
const connectorsApi = createConnectorBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const routeMocks = createRouteMocks(context);
const DAY_MS = 24 * 60 * 60 * 1000;
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

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
}

type EntitledChatActorWithoutRunner = Omit<EntitledChatActor, "runnerGroup">;

async function selectNativeClaudeModel(actor: ApiTestUser) {
  await api.updateUserModelPreference(actor, "claude-fable-5-1");
}

async function entitledChatActorWithoutRunner(
  displayName: string,
): Promise<EntitledChatActorWithoutRunner> {
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
  chatCallbacks.disableVapid();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensurePersonalSubscriptionModel(actor);
  // Thread lifecycle tests claim and complete a native-harness run. Fable is
  // the permanently native Claude route now that Pi has no off switch.
  await selectNativeClaudeModel(actor);
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
    readonly model?: string | null;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const { runId, threadId } = await chat.sendAndLaunch(actor, body);
  return { runId, threadId };
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

const waitForThreadMessages = readThreadMessagesAfterBackgroundWork.bind(
  null,
  chat,
);

async function waitForThreadEvents(
  actor: ApiTestUser,
  threadId: string,
  predicate: (events: readonly ChatEvent[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadEvents>> | undefined;
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      page = await chat.listThreadEvents(actor, threadId);
      return predicate(page.events);
    })(),
  ).resolves.toBeTruthy();
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
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      const run = await api.readRun(actor, runId);
      return run.status;
    })(),
  ).resolves.toBe(status);
}

/**
 * Complete with native history and exitCode 0. Successful completion requires
 * the native session identity and output references.
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

  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      completion: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${runId}`,
        cliAgentSessionHistoryDisposition: "native_only",
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

async function settledUsageForRun(
  actor: ApiTestUser,
  threadId: string,
  runId: string,
): Promise<ChatEventUsagePayload | undefined> {
  const response = await accept(
    setupApp({ context, routes: chatThreadRoutes })(
      chatThreadUsageContract,
    ).read({
      headers: authHeaders(actor),
      params: { id: threadId },
      body: { runIds: [runId] },
    }),
    [200],
  );
  return response.body.runs.find((run) => {
    return run.runId === runId;
  })?.usage;
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
  // An unconfigured Auto workspace has no credits and needs no personal
  // subscription fixture to persist a rejected message for search assertions.
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201 || sent.body.createdAt === undefined) {
    throw new Error("Expected a no-credit send without a run");
  }
  const createdAt = Date.parse(sent.body.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new Error("Expected the no-credit send to return a timestamp");
  }
  // The background pick rejects the input for insufficient credits.
  await flushWaitUntilForTest();
  return { threadId: sent.body.threadId, createdAt };
}

async function sendNoCreditMessage(
  actor: ApiTestUser,
  body: NoCreditMessageBody,
): Promise<string> {
  return (await sendNoCreditMessageResult(actor, body)).threadId;
}

/**
 * Runs a full chat run (send, runner claim, output publication + completion) so the
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
    method: "POST",
    path: "/api/chat-threads/:id/archive",
    paramName: "id",
  },
  {
    method: "POST",
    path: "/api/chat-threads/:id/unarchive",
    paramName: "id",
  },
  {
    method: "GET",
    path: "/api/chat-threads/:id/artifacts",
    paramName: "threadId",
  },
] as const;

describe("CHAT-01 thread detail, create, and delete cascades", () => {
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

  it("allows claimed agent tokens to sync their owner's snapshots and events", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const { actor, agentId } = owned;
      const run = await owned.sendChatRun(actor, {
        agentId,
        prompt: "Read chat snapshots",
      });
      const claimed = await owned.claimChatRun(owned.runnerGroup, run.runId);
      const apiClient = setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      );
      const okouHeaders = {
        authorization: `Bearer ${okouTokenFromClaim(claimed.claim)}`,
      };
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
      expect(events.body.events).toContainEqual(
        expect.objectContaining({
          kind: "created",
          chatThreadId: run.threadId,
          agentId,
        }),
      );
      createRouteMocks(context).clerk.session(
        actor.userId,
        actor.orgId,
        actor.orgRole,
      );
      const sessionHeaders = { authorization: "Bearer clerk-session" };
      const ownerSnapshot = await accept(
        apiClient.snapshot({ headers: sessionHeaders }),
        [200],
      );
      const ownerEvents = await accept(
        apiClient.events({ headers: sessionHeaders, query: {} }),
        [200],
      );
      expect(snapshot.body).toStrictEqual(ownerSnapshot.body);
      expect(events.body).toStrictEqual(ownerEvents.body);
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
    await api.ensurePersonalSubscriptionModel(actor);
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
    await chat.updateThreadModelSelection(
      actor,
      thread.id,
      "claude-sonnet-5-5",
      {
        eventId: modelSelectionEventId,
      },
    );

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
          selectedModel: "claude-sonnet-5-5",
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
    await api.ensurePersonalSubscriptionModel(actor);
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

  it("removes all deleted Agent threads from the sidebar event stream", async () => {
    const actor = bdd.user();
    await api.ensurePersonalSubscriptionModel(actor);
    const removedAgent = await bdd.createAgent(actor, {
      displayName: "Agent with sidebar threads to delete",
    });
    const keptAgent = await bdd.createAgent(actor, {
      displayName: "Agent with a retained sidebar thread",
    });
    const removedThreads = await Promise.all(
      ["First deleted thread", "Second deleted thread"].map(async (title) => {
        return await chat.createThread(actor, {
          agentId: removedAgent.agentId,
          title,
        });
      }),
    );
    const keptThread = await chat.createThread(actor, {
      agentId: keptAgent.agentId,
      title: "Retained sidebar thread",
    });
    const initialEvents = await allThreadEvents(actor);
    const before = {
      chatThreads: replayChatThreadEvents([], initialEvents),
      latestSeqId: initialEvents.at(-1)?.seqId,
    };
    expect(before.chatThreads).toHaveLength(3);
    if (before.latestSeqId === undefined) {
      throw new Error("Expected a sidebar lifecycle cursor");
    }

    chat.mockObjectStorageObjectsExist();
    await authOrg.deleteAgent(actor, removedAgent.agentId);
    // The App renders its list from the snapshot plus this external event API.
    const tail = await threadEventPage(actor, before.latestSeqId);
    expect(tail.events).toHaveLength(2);
    expect(tail.hasMore).toBeFalsy();
    expect(
      tail.events.map((event) => {
        return { kind: event.kind, chatThreadId: event.chatThreadId };
      }),
    ).toStrictEqual(
      expect.arrayContaining(
        removedThreads.map((thread) => {
          return { kind: "deleted", chatThreadId: thread.id };
        }),
      ),
    );
    expect(
      replayChatThreadEvents(before.chatThreads, tail.events).map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual([keptThread.id]);
    for (const thread of removedThreads) {
      expect(
        (await chat.requestReadThread(actor, thread.id, [404])).status,
      ).toBe(404);
    }
  });

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
  it("keeps thread detail independent from thread model projection state", async () => {
    const { actor, agentId } = await entitledChatActor(
      "Thread detail model pin agent",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "pin the first run model",
      model: "claude-fable-5-1",
    });

    let detail = await chat.readThread(actor, run.threadId);
    expect(detail).not.toHaveProperty("selectedModel");
    await expect(chat.listActiveChatThreadIds(actor)).resolves.toContain(
      run.threadId,
    );

    await chat.updateThreadModelSelection(actor, run.threadId, null);
    detail = await chat.readThread(actor, run.threadId);
    expect(detail).not.toHaveProperty("selectedModel");

    await cancelChatRun(actor, run.runId);
    await expect(chat.listActiveChatThreadIds(actor)).resolves.not.toContain(
      run.threadId,
    );
  }, 90_000);

  it("rejects explicit thread models without the member's subscription", async () => {
    const { actor, agentId } = await entitledChatActor(
      "Unavailable explicit thread model agent",
    );
    await api.updateUserModelPreference(actor, "claude-opus-5-5");

    const rejectedThreadId = randomUUID();
    const rejectedCreate = await chat.requestCreateThread(
      actor,
      {
        agentId,
        clientThreadId: rejectedThreadId,
        model: "gpt-6-astra",
      },
      [400],
    );
    expectApiError(rejectedCreate.body);
    expect(rejectedCreate.body.error.message).toBe(
      "Select Auto or a model from your connected personal subscription",
    );
    await chat.requestReadThread(actor, rejectedThreadId, [404]);

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-opus-5-5",
    });
    const rejectedUpdate = await chat.requestUpdateThreadModelSelection(
      actor,
      thread.id,
      "gpt-6-astra",
      [400],
    );
    expectApiError(rejectedUpdate.body);
    expect(rejectedUpdate.body.error.message).toBe(
      "Select Auto or a model from your connected personal subscription",
    );
  }, 90_000);

  it("rejects the internal Auto run model as a thread selection", async () => {
    const { actor, agentId } = await entitledChatActorWithoutRunner(
      "Auto run model selection agent",
    );

    const rejectedThreadId = randomUUID();
    const rejectedCreate = await chat.requestCreateThread(
      actor,
      { agentId, clientThreadId: rejectedThreadId, model: "okou-1.0" },
      [400],
    );
    expectApiError(rejectedCreate.body);
    await chat.requestReadThread(actor, rejectedThreadId, [404]);

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    const rejectedUpdate = await chat.requestUpdateThreadModelSelection(
      actor,
      thread.id,
      "okou-1.0",
      [400],
    );
    expectApiError(rejectedUpdate.body);
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({ selectedModel: "claude-fable-5-1" });
  }, 90_000);

  it("creates a thread without a model as Auto when the member has no preference", async () => {
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "Auto default thread agent",
    });
    const eventId = randomUUID();
    const created = await accept(
      setupApp({ context, routes: chatThreadCreateRoutes })(
        chatThreadsContract,
      ).create({
        headers: authHeaders(actor),
        body: { agentId: agent.agentId, eventId },
      }),
      [201],
    );
    expect(created.body.selectedModel).toBe("auto");
    await expect(
      chat.readThreadMetadata(actor, created.body.id),
    ).resolves.toMatchObject({ selectedModel: "auto" });
    await expect(allThreadEvents(actor)).resolves.toContainEqual(
      expect.objectContaining({
        id: eventId,
        kind: "created",
        chatThreadId: created.body.id,
        selectedModel: "auto",
      }),
    );
  });

  it.each([null, "auto"])(
    "stores canonical Auto intent %s for limited-free-1 workspaces",
    async (model) => {
      const fixture = createPublicFirewallFixture(context);
      await fixture.run(async () => {
        api.configureRunnerGroup();
        chatCallbacks.acceptChatObjectStorage();
        api.acceptStorageDownloads();
        api.acceptTelemetryIngest();
        mockOptionalEnv("OPENROUTER_API_KEY", undefined);
        chatCallbacks.disableVapid();
        const actor = fixture.actor;
        const subscription = await fixture.fund();
        await api.ensurePersonalSubscriptionModel(actor);
        await selectNativeClaudeModel(actor);
        const agent = await bdd.createAgent(actor, {
          displayName: "Limited free model pin agent",
          visibility: "private",
        });
        const agentId = agent.agentId;
        const billingStatus = await api.readBillingStatus(actor);
        await createWebhookCallbackApi(context).postStripeEvent(
          {
            type: "customer.subscription.deleted",
            data: {
              object: {
                id: subscription.subscriptionId,
                customer: subscription.customerId,
                status: "canceled",
                metadata: {},
                items: { data: [{ price: { id: "price_bdd_pro" } }] },
              },
            },
          },
          [200],
        );
        await flushWaitUntilForTest();
        await expect(api.readBillingStatus(actor)).resolves.toMatchObject({
          tier: "limited-free-1",
          status: "active",
          credits: billingStatus.credits,
        });
        const thread = await chat.createThread(actor, {
          agentId,
          model,
          title: "limited free model pin",
        });
        expect(thread.title).toBe("limited free model pin");
        await chat.updateThreadModelSelection(actor, thread.id, model);
        await expect(
          chat.readThreadMetadata(actor, thread.id),
        ).resolves.toMatchObject({ selectedModel: "auto" });
      });
    },
    90_000,
  );

  it("updates the Computer Use host binding on a chat thread", async () => {
    const hosts = createPublicComputerUseHosts(context);
    const owned = createPublicConnectorActor(context, {
      beforeWorkspaceCleanup: hosts.cleanup,
    });
    const { actor } = owned;
    await owned.run(() => {
      return bdd.completeOnboarding(actor);
    });
    await owned.run(() => {
      return api.ensurePersonalSubscriptionModel(actor);
    });
    const agent = await owned.run(() => {
      return bdd.createAgent(actor, {
        displayName: "Computer-use thread agent",
      });
    });
    const thread = await owned.run(() => {
      return chat.createThread(actor, {
        agentId: agent.agentId,
        title: "Computer Use",
      });
    });

    const host = await hosts.start(actor, owned.run);
    await owned.run(() => {
      return chat.updateThreadComputerUseHost(actor, thread.id, host.hostId);
    });

    const missingHost = await owned.run(() => {
      return chat.requestUpdateThreadComputerUseHost(
        actor,
        thread.id,
        randomUUID(),
        [404],
      );
    });
    expectApiError(missingHost.body);
    expect(missingHost.body.error.message).toBe("Computer-use host not found");

    const peer = bdd.user({ orgId: actor.orgId });
    const peerUpdate = await owned.run(() => {
      return chat.requestUpdateThreadComputerUseHost(
        peer,
        thread.id,
        host.hostId,
        [404],
      );
    });
    expectApiError(peerUpdate.body);
    expect(peerUpdate.body.error.message).toBe("Chat thread not found");

    await owned.run(() => {
      return chat.updateThreadComputerUseHost(actor, thread.id, null);
    });

    const hostEvents = (
      await owned.run(() => {
        return allThreadEvents(actor);
      })
    ).filter((event) => {
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

    const missingThread = await owned.run(() => {
      return chat.requestUpdateThreadComputerUseHost(
        actor,
        randomUUID(),
        null,
        [404],
      );
    });
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

    await cancelChatRun(actor, other.runId);
  }, 120_000);
});

describe("CHAT-01 chat thread read state", () => {
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
    await bdd.readOnboardingStatus(peer);
    await bdd.completeOnboarding(peer);
    if (!peer.orgId) {
      throw new Error("Expected an organization-scoped peer");
    }

    await api.ensurePersonalSubscriptionModel(peer);
    await selectNativeClaudeModel(peer);
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
    await api.ensurePersonalSubscriptionModel(sameUserOtherOrg);
    await selectNativeClaudeModel(sameUserOtherOrg);
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

  it("does not let a muted thread hide another unread thread under the same agent", async () => {
    const { actor, agentId, runnerGroup } =
      await entitledChatActor("Mixed mute states");
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: actor.orgRole },
      { [FeatureSwitchKey.ChatThreadMuting]: true },
    );
    const muted = await completeChatRunInThread(actor, runnerGroup, {
      agentId,
      prompt: "Muted unread task",
    });
    const other = await completeChatRunInThread(actor, runnerGroup, {
      agentId,
      prompt: "Unmuted unread task",
    });
    await chat.requestSetThreadMuted(actor, muted.threadId, true, [204]);
    await expect(chat.listUnreadChatThreadIds(actor)).resolves.toStrictEqual([
      other.threadId,
    ]);
    await expect(chat.listUnreadAgents(actor)).resolves.toStrictEqual([
      agentId,
    ]);
    await chat.markThreadRead(actor, other.threadId);
    await expect(chat.listUnreadAgents(actor)).resolves.toStrictEqual([]);
    await chat.requestSetThreadMuted(actor, muted.threadId, false, [204]);
    await expect(chat.listUnreadChatThreadIds(actor)).resolves.toStrictEqual([
      muted.threadId,
    ]);
    await expect(chat.listUnreadAgents(actor)).resolves.toStrictEqual([
      agentId,
    ]);
  });

  it("lists active thread ids without hiding the agent's unread state", async () => {
    const {
      actor: owner,
      agentId: ownerAgent,
      runnerGroup,
    } = await entitledChatActor("Active ids owner agent");
    const peer = bdd.user({ orgId: owner.orgId });
    await bdd.readOnboardingStatus(peer);
    await bdd.completeOnboarding(peer);
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
    await api.ensurePersonalSubscriptionModel(sameUserOtherOrg);
    await api.ensurePersonalSubscriptionModel(peer, {
      model: "claude-fable-5-1",
    });

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
      unreadAt: { [completedRun.threadId]: expect.any(String) },
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
      unreadAt: {
        [completedRun.threadId]: expect.any(String),
        [runningRun.threadId]: expect.any(String),
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
        unreadAt: { [recentRun.threadId]: expect.any(String) },
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
      if (!indicators.unreadAt) {
        throw new Error("Expected unread timestamps from the current API");
      }
      expect(Object.keys(indicators.threads)).toHaveLength(50);
      expect(Object.keys(indicators.unreadAt)).toHaveLength(50);
      const oldestRun = runs[0];
      if (!oldestRun) {
        throw new Error("Expected an oldest completed run");
      }
      expect(indicators.threads).not.toHaveProperty(oldestRun.threadId);
      expect(indicators.unreadAt).not.toHaveProperty(oldestRun.threadId);
      for (const run of runs.slice(1)) {
        expect(indicators.threads[run.threadId]).toBe("unread");
        expect(indicators.unreadAt[run.threadId]).toStrictEqual(
          expect.any(String),
        );
      }
    });
  }, 240_000);

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
});

describe("CHAT-03 run usage events", () => {
  it("reads zero-credit usage and omits runs without settled usage", async () => {
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

    await expect(
      settledUsageForRun(actor, agentRun.threadId, agentRun.runId),
    ).resolves.toMatchObject({
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

    // A run with no usage has no monetary receipt; it must not inherit another
    // run's amount merely because both belong to the same member.
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
      settledUsageForRun(actor, quietRun.threadId, quietRun.runId),
    ).resolves.toBeUndefined();
    await expect(
      settledUsageForRun(actor, quietRun.threadId, agentRun.runId),
    ).resolves.toBeUndefined();
  }, 60_000);
});

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

    const owned = await publicChatActor(context);
    const source = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "check sandbox search authorization",
    });
    const { claim } = await owned.claimChatRun(owned.runnerGroup, source.runId);
    await owned.run(async () => {
      const sandboxBearer = claim.sandboxToken;
      const forbidden = await chat.searchChatWithBearer(
        `Bearer ${sandboxBearer}`,
        "hello",
        [403],
      );
      expectApiError(forbidden.body);
      expect(forbidden.body.error.code).toBe("FORBIDDEN");
      expect(forbidden.body.error.message).toContain("chat-event:read");
    });
  });
});

describe("CHAT-03 thread artifacts and google drive status", () => {
  it.each(["hosted-site", "presentation-html"] as const)(
    "exports a hosted %s as an owned bundle to Google Drive",
    async (artifactKind) => {
      const owned = await publicChatActor(context);
      const { actor, agentId } = owned;
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      const run = await owned.sendChatRun(actor, {
        agentId,
        prompt: "Create a hosted HTML artifact",
      });
      const claimed = await owned.claimChatRun(owned.runnerGroup, run.runId);
      const objectStore = chatCallbacks.acceptChatObjectStorage();
      installHostedUploadTransport(context, objectStore);
      const index =
        '<!doctype html><link rel="stylesheet" href="/assets/style-5e0c7a94.css"><h1>Private report</h1>';
      const css = "h1 { color: green }";
      const bearer = `Bearer ${okouTokenFromClaim(claimed.claim)}`;
      const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
        site: `private-drive-${randomUUID().slice(0, 8)}`,
        artifactKind,
        spaFallback: false,
        files: [
          hostedTextFile("/index.html", index),
          hostedTextFile("/assets/style-5e0c7a94.css", css),
        ],
      });
      await uploadHostedTextFiles(prepared, {
        "/index.html": index,
        "/assets/style-5e0c7a94.css": css,
      });
      await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
      const artifacts = await chat.listThreadArtifacts(actor, run.threadId);
      const artifact = artifacts.runs
        .flatMap((item) => {
          return item.files;
        })
        .find((file) => {
          return file.url === prepared.artifactUrl;
        });
      if (!artifact?.artifactId) {
        throw new Error("Expected hosted artifact with a catalog id");
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
      const synced = await chat.requestUploadArtifactToGoogleDrive(
        actor,
        artifact.artifactId,
        { agentId },
        [200],
      );
      expect(synced.body).toMatchObject({ id: "private-drive-file" });
      expect(upload.contentTypeHeaders).toStrictEqual(["application/zip"]);
      expect(upload.contentRangeHeaders[0]).toMatch(/^bytes 0-\d+\/\d+$/u);
      const zip = new AdmZip(Buffer.from(upload.bodies[0]!));
      expect(
        zip
          .getEntries()
          .map((entry) => {
            return entry.entryName;
          })
          .sort(),
      ).toStrictEqual(["assets/style-5e0c7a94.css", "index.html"]);
      expect(zip.readAsText("index.html")).toBe(index);
      expect(zip.readAsText("assets/style-5e0c7a94.css")).toBe(css);
      expect(
        objectStore.puts.filter((put) => {
          return put.key.startsWith("artifacts/");
        }),
      ).toStrictEqual([]);
    },
  );

  // The reported defect: a public deck is neither owner-private nor a
  // `hosted-site`, so the old condition uploaded its entry document alone.
  it("exports a public presentation deck to Google Drive as an owned bundle", async () => {
    const owned = await publicChatActor(context);
    const { actor, agentId } = owned;
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    const run = await owned.sendChatRun(actor, {
      agentId,
      prompt: "Create a public HTML deck",
    });
    const claimed = await owned.claimChatRun(owned.runnerGroup, run.runId);
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    installHostedUploadTransport(context, objectStore);
    const index =
      '<!doctype html><link rel="stylesheet" href="/assets/deck-8c4a2f60.css"><h1>Deck</h1>';
    const css = "h1 { color: teal }";
    const bearer = `Bearer ${okouTokenFromClaim(claimed.claim)}`;
    const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
      site: `public-deck-${randomUUID().slice(0, 8)}`,
      artifactKind: "presentation-html",
      spaFallback: false,
      files: [
        hostedTextFile("/index.html", index),
        hostedTextFile("/assets/deck-8c4a2f60.css", css),
      ],
    });
    await uploadHostedTextFiles(prepared, {
      "/index.html": index,
      "/assets/deck-8c4a2f60.css": css,
    });
    await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
    // A public publication lists its canonical artifact URL and keeps the
    // brand host as `aliasUrl`; only an owner-private one lists the alias.
    const { artifactUrl } = prepared;
    if (!artifactUrl) {
      throw new Error("Expected a canonical artifact URL");
    }
    const artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    const artifact = artifacts.runs
      .flatMap((item) => {
        return item.files;
      })
      .find((file) => {
        return file.url === artifactUrl;
      });
    if (!artifact?.artifactId) {
      throw new Error("Expected a public hosted artifact with a catalog id");
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
      id: "public-deck-drive-file",
      name: "deck.zip",
    });
    await chat.requestUploadArtifactToGoogleDrive(
      actor,
      artifact.artifactId,
      { agentId },
      [200],
    );

    expect(upload.contentTypeHeaders).toStrictEqual(["application/zip"]);
    expect(upload.contentRangeHeaders[0]).toMatch(/^bytes 0-\d+\/\d+$/u);
    const zip = new AdmZip(Buffer.from(upload.bodies[0]!));
    expect(
      zip
        .getEntries()
        .map((entry) => {
          return entry.entryName;
        })
        .sort(),
    ).toStrictEqual(["assets/deck-8c4a2f60.css", "index.html"]);
    expect(zip.readAsText("index.html")).toBe(index);
    expect(zip.readAsText("assets/deck-8c4a2f60.css")).toBe(css);
  });

  it("exports a self-contained hosted page to Google Drive as that page", async () => {
    const owned = await publicChatActor(context);
    const { actor, agentId } = owned;
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    const run = await owned.sendChatRun(actor, {
      agentId,
      prompt: "Create a self-contained HTML artifact",
    });
    const claimed = await owned.claimChatRun(owned.runnerGroup, run.runId);
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    installHostedUploadTransport(context, objectStore);
    const index =
      "<!doctype html><style>h1{color:green}</style><h1>Report</h1>";
    const bearer = `Bearer ${okouTokenFromClaim(claimed.claim)}`;
    const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
      site: `single-page-${randomUUID().slice(0, 8)}`,
      artifactKind: "presentation-html",
      spaFallback: false,
      files: [hostedTextFile("/index.html", index)],
    });
    await uploadHostedTextFiles(prepared, { "/index.html": index });
    await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
    const artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    const artifact = artifacts.runs
      .flatMap((item) => {
        return item.files;
      })
      .find((file) => {
        return file.url === prepared.artifactUrl;
      });
    if (!artifact?.artifactId) {
      throw new Error("Expected a hosted artifact with a catalog id");
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
      id: "single-page-drive-file",
      name: "report.html",
    });
    await chat.requestUploadArtifactToGoogleDrive(
      actor,
      artifact.artifactId,
      { agentId },
      [200],
    );

    expect(upload.contentTypeHeaders[0]).toContain("text/html");
    expect(upload.contentTypeHeaders[0]).not.toContain("application/zip");
    expect(Buffer.from(upload.bodies[0]!).toString("utf8")).toBe(index);
  });

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

    // Uploading requires a connected and Agent-authorized Drive account.
    const noConnector = await chat.requestUploadArtifactToGoogleDrive(
      actor,
      await chat.resolveCatalogArtifactId(actor, run.threadId, csvId),
      { agentId },
      [400],
    );
    expectApiError(noConnector.body);
    expect(noConnector.body.error.message).toBe(
      "Connect and authorize Google Drive for this agent before uploading artifacts",
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
    const disabledForAgent = await chat.requestUploadArtifactToGoogleDrive(
      actor,
      await chat.resolveCatalogArtifactId(actor, run.threadId, csvId),
      { agentId },
      [400],
    );
    expectApiError(disabledForAgent.body);
    expect(disabledForAgent.body.error.message).toBe(
      "Connect and authorize Google Drive for this agent before uploading artifacts",
    );

    const unknownArtifact = await chat.requestUploadArtifactToGoogleDrive(
      actor,
      randomUUID(),
      { agentId },
      [404],
    );
    expectApiError(unknownArtifact.body);
    expect(unknownArtifact.body.error.message).toBe("Artifact file not found");

    const invalidBody = await chat.requestUploadArtifactToGoogleDriveUnchecked(
      actor,
      csvId,
      { agentId: 7 },
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
    const synced = await chat.requestUploadArtifactToGoogleDrive(
      actor,
      await chat.resolveCatalogArtifactId(actor, run.threadId, csvId),
      { agentId },
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
    // The session carries the metadata; the content request carries the bytes.
    expect(uploadRecorder.metadata[0]).toContain('"name":"data.csv"');
    expect(uploadRecorder.contentTypeHeaders[0]).toBe("text/csv");
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
      originalUploaded: true,
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

    // Upload refresh must publish its token before retrying the provider. A
    // later status request can use it even when Google refuses another refresh.
    mockGoogleDriveConnectorOAuth({
      refreshOutcome: { type: "ok", accessToken: "drive-upload-refreshed" },
    });
    mockGoogleDriveArtifactUpload({
      id: "drive-upload-after-refresh",
      name: "data.csv",
    });
    mockGoogleDriveFilesList((request) => {
      if (
        request.headers.get("authorization") !== "Bearer drive-upload-refreshed"
      ) {
        return { status: 401 };
      }
      return {
        status: 200,
        files: [{ id: "drive-folder", name: "artifacts" }],
      };
    });
    const refreshedUpload = await chat.requestUploadArtifactToGoogleDrive(
      actor,
      await chat.resolveCatalogArtifactId(actor, run.threadId, csvId),
      { agentId },
      [200],
    );
    expect(refreshedUpload.body).toMatchObject({
      id: "drive-upload-after-refresh",
    });
    mockGoogleDriveConnectorOAuth();
    mockGoogleDriveFilesList((request) => {
      if (
        request.headers.get("authorization") !== "Bearer drive-upload-refreshed"
      ) {
        return { status: 401 };
      }
      return {
        status: 200,
        files: [
          {
            id: "drive-upload-after-refresh",
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
      id: "drive-upload-after-refresh",
    });

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

  async function setupSlidesConversionSync(params: {
    readonly agentLabel: string;
    readonly conversionEnabled: boolean;
    readonly workspaceConversionEnabled?: boolean;
    readonly source?: { readonly filename: string; readonly body: Buffer };
  }) {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      params.agentLabel,
    );
    if (params.conversionEnabled) {
      await createBillingMediaApi(context).updateFeatureSwitches(actor, {
        [FeatureSwitchKey.GoogleSlidesConversion]: true,
      });
    }
    if (params.workspaceConversionEnabled !== undefined) {
      await createBillingMediaApi(context).updateFeatureSwitches(actor, {
        [FeatureSwitchKey.GoogleDocsSheetsConversion]:
          params.workspaceConversionEnabled,
      });
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const objectStore = chatCallbacks.acceptChatObjectStorage();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "produce an artifact",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const deckId = randomUUID();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${deckId}/${params.source?.filename ?? "deck.pptx"}`,
      size: params.source?.body.byteLength ?? 4096,
      ...(params.source ? { body: params.source.body } : {}),
    });
    await chat.completeUploadWithBearer(
      `Bearer ${okouTokenFromClaim(claim)}`,
      { id: deckId },
      [200],
    );

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

    return { actor, agentId, deckId, run, sandboxHeaders };
  }

  async function workspaceSource(
    filename: string,
    body: Buffer,
    enabled = true,
    slidesEnabled = false,
  ) {
    const prepared = await setupSlidesConversionSync({
      agentLabel: "Workspace conversion agent",
      conversionEnabled: slidesEnabled,
      workspaceConversionEnabled: enabled,
      source: { filename, body },
    });
    mockGoogleDriveFilesList(() => {
      return { status: 200, files: [] };
    });
    const artifacts = await chat.listThreadArtifacts(
      prepared.actor,
      prepared.run.threadId,
    );
    const artifactId = artifacts.runs[0]?.files[0]?.artifactId;
    if (!artifactId) {
      throw new Error("Expected a canonical artifact from public upload");
    }
    const client = setupApp({
      context,
      routes: chatThreadsArtifactsSyncRoutes,
    })(artifactGoogleDriveContract);
    return {
      ...prepared,
      upload: (mode: GoogleDriveUploadMode = "original") => {
        return accept(
          client.uploadWithMode({
            headers: authHeaders(prepared.actor),
            params: { artifactId },
            body: {
              agentId: prepared.agentId,
              mode,
            },
          }),
          [200, 400],
        );
      },
      finish: async () => {
        chatCallbacks.mockChatOutputEvents([]);
        await completeChatRunOk(prepared.run.runId, prepared.sandboxHeaders);
      },
    };
  }

  function officeSource(kind: "docx" | "xlsx"): Buffer {
    const zip = new AdmZip();
    const word = kind === "docx";
    const main = word ? "word/document.xml" : "xl/workbook.xml";
    const mime = word
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
    zip.addFile(
      "[Content_Types].xml",
      Buffer.from(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="${mime}"/></Types>`,
      ),
    );
    zip.addFile(
      main,
      Buffer.from(
        word
          ? '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>'
          : '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Data" sheetId="1"/></sheets></workbook>',
      ),
    );
    return zip.toBuffer();
  }

  function legacyOfficeSource(extension: "doc" | "xls"): Buffer {
    const container = compoundUtils.cfb_new();
    compoundUtils.cfb_add(
      container,
      extension === "doc" ? "WordDocument" : "Workbook",
      Buffer.alloc(32),
    );
    const bytes: unknown = writeCompoundFile(container, { type: "buffer" });
    if (!Buffer.isBuffer(bytes)) {
      throw new Error("Expected binary Office fixture");
    }
    return Buffer.from(bytes);
  }

  function openDocumentSource(extension: "odt" | "ods"): Buffer {
    const zip = new AdmZip();
    zip.addFile(
      "mimetype",
      Buffer.from(
        `application/vnd.oasis.opendocument.${extension === "odt" ? "text" : "spreadsheet"}`,
      ),
    );
    zip.addFile(
      "content.xml",
      Buffer.from(
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body/></office:document-content>',
      ),
    );
    return zip.toBuffer();
  }

  it.each([
    {
      filename: "report.doc",
      source: () => {
        return legacyOfficeSource("doc");
      },
      target: "document",
      sourceMime: "application/msword",
    },
    {
      filename: "table.xls",
      source: () => {
        return legacyOfficeSource("xls");
      },
      target: "spreadsheet",
      sourceMime: "application/vnd.ms-excel",
    },
    {
      filename: "report.odt",
      source: () => {
        return openDocumentSource("odt");
      },
      target: "document",
      sourceMime: "application/vnd.oasis.opendocument.text",
    },
    {
      filename: "table.ods",
      source: () => {
        return openDocumentSource("ods");
      },
      target: "spreadsheet",
      sourceMime: "application/vnd.oasis.opendocument.spreadsheet",
    },
    {
      filename: "report.docx",
      source: () => {
        return officeSource("docx");
      },
      target: "document",
      sourceMime:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    {
      filename: "report.md",
      source: () => {
        return Buffer.from(
          "# Heading\n\n**Bold** and [a link](https://example.com)\n",
        );
      },
      target: "document",
      sourceMime: "text/markdown",
    },
    {
      filename: "report.txt",
      source: () => {
        return Buffer.from("Hello document");
      },
      target: "document",
      sourceMime: "text/plain",
    },
    {
      filename: "report.rtf",
      source: () => {
        return Buffer.from(String.raw`{\rtf1 Hello}`);
      },
      target: "document",
      sourceMime: "application/rtf",
    },
    {
      filename: "table.xlsx",
      source: () => {
        return officeSource("xlsx");
      },
      target: "spreadsheet",
      sourceMime:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  ] as const)(
    "workspace conversion preserves the $filename source and verifies the native result",
    async ({ filename, source, target, sourceMime }) => {
      const bytes = source();
      const fixture = await workspaceSource(filename, bytes);
      const native = {
        id: "native-file",
        name: filename.replace(/\.[^.]+$/u, ""),
        mimeType: GOOGLE_WORKSPACE_MIME_TYPES[target],
        webViewLink: `https://docs.google.com/${target === "document" ? "document" : "spreadsheets"}/d/native-file/edit`,
      };
      const upload = mockGoogleDriveArtifactUpload(native);
      const readback = mockGoogleWorkspaceReadback(native);
      const response = await fixture.upload("google");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject(native);
      expect(upload.metadata[0]).toContain(`"mimeType":"${native.mimeType}"`);
      expect(upload.uploadContentTypeHeaders).toStrictEqual([sourceMime]);
      expect(Buffer.from(upload.bodies[0]!)).toStrictEqual(bytes);
      expect(readback.readFileIds).toStrictEqual(["native-file"]);
      expect(readback.trashedFileIds).toStrictEqual([]);
      await fixture.finish();
    },
    120_000,
  );

  it("google docs conversion preserves Chinese and Latin font choices in Word text", async () => {
    const bytes = docsImportFixture();
    const fixture = await publicOfficeConversionSource(bytes, "docx");
    const native = {
      id: "native-doc",
      name: "bilingual",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
    };
    const upload = mockGoogleDriveArtifactUpload(native);
    mockGoogleWorkspaceReadback(native);
    const response = await fixture.upload("google");
    expect(response.status).toBe(200);
    const prepared = Buffer.from(upload.bodies[0]!);
    const runs = uploadedDocsText(prepared);
    expect(
      runs
        .map((run) => {
          return run.text;
        })
        .join(""),
    ).toBe(
      uploadedDocsText(bytes)
        .map((run) => {
          return run.text;
        })
        .join(""),
    );
    for (const [text, font] of [
      ["合同（中文），", "Noto Serif SC"],
      ["尾款", "Noto Serif SC"],
      ["正文", "Noto Serif SC"],
      ["标题", "Noto Sans SC"],
      ["链接", "Noto Sans SC"],
      ["表格", "Noto Sans SC"],
      ["文本框", "Noto Serif SC"],
      ["页眉", "Noto Serif SC"],
      ["页脚", "Noto Serif SC"],
    ]) {
      expect(
        runs.find((run) => {
          return run.text === text;
        }),
      ).toMatchObject({
        fonts: { ascii: font, hAnsi: font, eastAsia: font, cs: font },
      });
    }
    for (const text of ["Hello ", "Inherited ", "Header ", "Footer "]) {
      expect(
        runs.find((run) => {
          return run.text === text;
        })?.fonts.ascii,
      ).toBe("Times New Roman");
    }
    expect(
      runs.find((run) => {
        return run.text === "Title ";
      })?.fonts.ascii,
    ).toBe("Arial");
    for (const text of [
      "Hello ",
      "合同（中文），",
      "& 2026 ",
      "尾款",
      "\t",
      "\n",
    ]) {
      expect(
        runs.find((run) => {
          return run.text === text;
        }),
      ).toMatchObject({ size: "24", color: "123456", bold: true });
    }
    expect(
      runs.find((run) => {
        return run.text === "链接";
      }),
    ).toMatchObject({ italic: true });
    expect(
      runs.find((run) => {
        return run.text === "Custom 自定义";
      })?.fonts,
    ).toStrictEqual({
      ascii: "Georgia",
      hAnsi: "Georgia",
      eastAsia: "Unlisted CJK",
    });
    expect(
      runs.find((run) => {
        return run.text === "Theme 主题";
      })?.fonts,
    ).toStrictEqual({
      asciiTheme: "minorHAnsi",
      hAnsiTheme: "minorHAnsi",
      eastAsiaTheme: "minorEastAsia",
    });
    expect(
      runs.find((run) => {
        return run.text === "条件字体";
      })?.fonts.eastAsia,
    ).toBeUndefined();
    const archive = new AdmZip(prepared);
    const document = archive.readAsText("word/document.xml");
    for (const property of [
      '<w:spacing w:after="120" w:line="276">',
      '<w:tblW w:w="5000" w:type="dxa">',
      '<w:pgSz w:w="11906" w:h="16838">',
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440">',
      '<w:hyperlink r:id="link" w:tooltip="First&#10;second">',
    ]) {
      expect(document).toContain(property);
    }
    expect(archive.readAsText("word/footer1.xml")).toContain(
      '<instrText xml:space="preserve"> PAGE </instrText>',
    );
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
    ]) {
      expect(archive.readFile(part)).toStrictEqual(
        new AdmZip(bytes).readFile(part),
      );
    }
    await expect(fixture.sourceBytes()).resolves.toStrictEqual(bytes);
  }, 120_000);

  it("google docs conversion accepts UTF-16 Word XML", async () => {
    const archive = new AdmZip(docsImportFixture());
    archive.addFile(
      "word/document.xml",
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(archive.readAsText("word/document.xml"), "utf16le"),
      ]),
    );
    const bytes = archive.toBuffer();
    const fixture = await publicOfficeConversionSource(bytes, "docx");
    const native = {
      id: "native-doc",
      name: "bilingual",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
    };
    const upload = mockGoogleDriveArtifactUpload(native);
    mockGoogleWorkspaceReadback(native);
    expect((await fixture.upload("google")).status).toBe(200);
    expect(
      uploadedDocsText(upload.bodies[0]!).find((run) => {
        return run.text === "合同（中文），";
      })?.fonts.ascii,
    ).toBe("Noto Serif SC");
    await expect(fixture.sourceBytes()).resolves.toStrictEqual(bytes);
  }, 120_000);

  it("original uploads keep DOCX font declarations intact", async () => {
    const bytes = docsImportFixture();
    const fixture = await publicOfficeConversionSource(bytes, "docx");
    const upload = mockGoogleDriveArtifactUpload({
      id: "original-doc",
      name: "bilingual.docx",
    });
    expect((await fixture.upload("original")).status).toBe(200);
    expect(Buffer.from(upload.bodies[0]!)).toStrictEqual(bytes);
    await expect(fixture.sourceBytes()).resolves.toStrictEqual(bytes);
  }, 120_000);

  it.each(["DTD", "cyclic styles"])(
    "google docs conversion rejects %s before creating a Drive file",
    async (invalid) => {
      const archive = new AdmZip(docsImportFixture());
      if (invalid === "DTD") {
        archive.addFile(
          "word/document.xml",
          Buffer.from(
            `<!DOCTYPE document [<!ENTITY text "example">]>${archive.readAsText("word/document.xml")}`,
          ),
        );
      } else {
        archive.addFile(
          "word/styles.xml",
          Buffer.from(
            archive
              .readAsText("word/styles.xml")
              .replace(
                '<w:basedOn w:val="HeadingBase"/>',
                '<w:basedOn w:val="Heading"/>',
              ),
          ),
        );
      }
      const bytes = archive.toBuffer();
      const fixture = await publicOfficeConversionSource(bytes, "docx");
      const upload = mockGoogleDriveArtifactUpload({
        id: "unexpected",
        name: "bilingual.docx",
      });
      const response = await fixture.upload("google", [400]);
      expect(response.status).toBe(400);
      expectApiError(response.body);
      expect(upload.bodies).toHaveLength(0);
      await expect(fixture.sourceBytes()).resolves.toStrictEqual(bytes);
    },
    120_000,
  );

  it.each([
    { extension: "csv", delimiter: "," },
    { extension: "tsv", delimiter: "\t" },
  ])(
    "workspace conversion preserves $extension fields as literal text",
    async ({ extension, delimiter }) => {
      const bytes = Buffer.from(
        `\ufeff00123${delimiter}12345678901234567890${delimiter}=SUM(A1:A2)${delimiter}2026-01-02${delimiter}"line 1\nline 2"${delimiter}"a""b"${delimiter}a&b <c>\u00a0文${delimiter}_x0041_\r\n`,
      );
      const fixture = await workspaceSource(`table.${extension}`, bytes);
      const native = {
        id: "native-sheet",
        name: "table",
        mimeType: GOOGLE_WORKSPACE_MIME_TYPES.spreadsheet,
      };
      const upload = mockGoogleDriveArtifactUpload(native);
      mockGoogleWorkspaceReadback(native);
      const response = await fixture.upload("google");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mimeType: native.mimeType,
        webViewLink: "https://docs.google.com/spreadsheets/d/native-sheet/edit",
      });
      expect(upload.uploadContentTypeHeaders).toStrictEqual([
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ]);
      const workbook = new AdmZip(Buffer.from(upload.bodies[0]!));
      const sheet = workbook.readAsText("xl/worksheets/sheet1.xml");
      for (const value of [
        "00123",
        "12345678901234567890",
        "=SUM(A1:A2)",
        "2026-01-02",
        "line 1\nline 2",
        "a&quot;b",
        "a&amp;b &lt;c&gt;\u00a0文",
        "_x005F_x0041_",
      ]) {
        expect(sheet).toContain(`<t xml:space="preserve">${value}</t>`);
      }
      expect(sheet.match(/t="inlineStr"/gu)).toHaveLength(8);
      expect(sheet).not.toContain("<f>");
      await fixture.finish();
    },
    120_000,
  );

  it.each([
    {
      filename: "renamed.docx",
      bytes: () => {
        return officeSource("xlsx");
      },
      message: "does not match",
    },
    {
      filename: "script.py",
      bytes: () => {
        return Buffer.from("print('hello')");
      },
      message: "cannot be converted",
    },
    {
      filename: "table.csv",
      bytes: () => {
        return Buffer.from('"unfinished');
      },
      message: "unclosed quoted field",
    },
    {
      filename: "table.tsv",
      bytes: () => {
        return Buffer.from([0xff, 0xfe, 0x00, 0xd8]);
      },
      message: "UTF-8 text file",
    },
    {
      filename: "table.csv",
      bytes: () => {
        return Buffer.from("x".repeat(50_001));
      },
      message: "50,000",
    },
  ] as const)(
    "workspace conversion rejects invalid $filename before creating a Drive file",
    async ({ filename, bytes, message }) => {
      const fixture = await workspaceSource(filename, bytes());
      const upload = mockGoogleDriveArtifactUpload({
        id: "unexpected",
        name: filename,
      });
      const response = await fixture.upload("google");
      expect(response.status).toBe(400);
      expectApiError(response.body);
      expect(response.body.error.message).toContain(message);
      expect(upload.bodies).toHaveLength(0);
      await fixture.finish();
    },
    120_000,
  );

  it("workspace conversion is enforced server-side while original uploads remain available", async () => {
    const bytes = Buffer.from("Hello");
    const fixture = await workspaceSource("report.txt", bytes, false);
    const upload = mockGoogleDriveArtifactUpload({
      id: "raw-file",
      name: "report.txt",
      mimeType: "text/plain",
    });
    const blocked = await fixture.upload("google");
    expect(blocked.status).toBe(400);
    expect(upload.bodies).toHaveLength(0);
    const original = await fixture.upload();
    expect(original.status).toBe(200);
    expect(Buffer.from(upload.bodies[0]!)).toStrictEqual(bytes);
    expect(upload.metadata[0]).toContain('"mimeType":"text/plain"');
    await fixture.finish();
  }, 120_000);

  it.each([
    {
      mode: "original",
      slidesEnabled: true,
      docsEnabled: false,
      expected: 200,
    },
    { mode: "google", slidesEnabled: true, docsEnabled: false, expected: 200 },
    { mode: "google", slidesEnabled: false, docsEnabled: true, expected: 400 },
  ] as const)(
    "slides uses explicit $mode with its own switch ($slidesEnabled)",
    async ({ mode, slidesEnabled, docsEnabled, expected }) => {
      const bytes = Buffer.from("presentation source");
      const fixture = await workspaceSource(
        "deck.pptx",
        bytes,
        docsEnabled,
        slidesEnabled,
      );
      const native = mode === "google" && slidesEnabled;
      const result = {
        id: "uploaded-deck",
        name: "deck.pptx",
        mimeType: native
          ? GOOGLE_WORKSPACE_MIME_TYPES.presentation
          : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      };
      const upload = mockGoogleDriveArtifactUpload(result);
      if (native) {
        mockGoogleWorkspaceReadback(result);
        mockGoogleSlidesReadback([{ pageElementCount: 2 }]);
      }
      const response = await fixture.upload(mode);
      expect(response.status).toBe(expected);
      if (expected === 200) {
        expect(response.body).toMatchObject(result);
        expect(upload.metadata[0]).toContain(`"mimeType":"${result.mimeType}"`);
        expect(Buffer.from(upload.bodies[0]!)).toStrictEqual(bytes);
      } else {
        expect(upload.bodies).toHaveLength(0);
        expectApiError(response.body);
        expect(response.body.error.message).toContain(
          "Google Slides conversion is not enabled",
        );
      }
      await fixture.finish();
    },
    120_000,
  );

  const picturePptxMime =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";

  async function publicOfficeConversionSource(
    bytes: Buffer,
    format: "docx" | "pptx" = "pptx",
  ) {
    const filename = format === "docx" ? "bilingual.docx" : "deck.pptx";
    const contentType =
      format === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : picturePptxMime;
    const owned = await publicChatActor(context);
    const { actor, agentId } = owned;
    owned.ownsFeatureSwitches();
    await owned.run(() => {
      return createBillingMediaApi(context).updateFeatureSwitches(actor, {
        [FeatureSwitchKey.GoogleSlidesConversion]: format === "pptx",
        [FeatureSwitchKey.GoogleDocsSheetsConversion]: format === "docx",
      });
    });
    const run = await owned.sendChatRun(actor, {
      agentId,
      prompt: "Create an Office document for Google conversion",
    });
    const { claim } = await owned.claimChatRun(owned.runnerGroup, run.runId);
    // Drive imports consume public-storage files. Use the supported org-less
    // upload producer, then publish with this user's real Run claim. Do not
    // fabricate a legacy object key or relax the private-artifact boundary.
    installSharedThreadStorage(context);
    const prepared = await owned.run(() => {
      return chat.prepareUpload(
        { ...actor, orgId: null },
        {
          filename,
          contentType,
          size: bytes.byteLength,
          purpose: "artifact",
        },
      );
    });
    if (!("uploadUrl" in prepared)) {
      throw new Error("Expected a single-part artifact upload");
    }
    const put = await owned.run(() => {
      return fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: prepared.uploadHeaders,
        body: Uint8Array.from(bytes),
      });
    });
    expect(put.status).toBe(200);
    await owned.run(() => {
      return chat.completeUploadWithBearer(
        `Bearer ${okouTokenFromClaim(claim)}`,
        { id: prepared.id },
        [200],
      );
    });
    const artifactId = await owned.run(async () => {
      const catalog = await chat.listArtifactCatalog(actor, {
        chatThreadId: run.threadId,
      });
      expect(catalog.artifacts).toHaveLength(1);
      const detail = await chat.getArtifactCatalogEntry(
        actor,
        catalog.artifacts[0]!.id,
      );
      expect(detail).toMatchObject({
        kind: "file",
        file: {
          url: prepared.url,
          filename,
          contentType,
          size: bytes.byteLength,
        },
      });
      return detail.id;
    });
    mockGoogleDriveConnectorOAuth();
    const oauth = await owned.run(() => {
      return connectorsApi.startOauth(actor, "google-drive", "oauth");
    });
    await owned.run(() => {
      return connectorsApi.completeOauthCallback("google-drive", {
        code: "drive-picture-crop",
        state: stateFromAuthorizationUrl(oauth.authorizationUrl),
      });
    });
    await owned.run(() => {
      return api.enableAgentConnectors(actor, agentId, ["google-drive"]);
    });
    const client = setupApp({
      context,
      routes: chatThreadsArtifactsSyncRoutes,
    })(artifactGoogleDriveContract);
    const files = setupApp({ context, routes: webDownloadRoutes })(
      webFilesContract,
    );
    return {
      upload: (
        mode: GoogleDriveUploadMode,
        statuses: readonly (200 | 400)[] = [200],
      ) => {
        return owned.run(() => {
          return accept(
            client.uploadWithMode({
              headers: authHeaders(actor),
              params: { artifactId },
              body: { agentId, mode },
            }),
            statuses,
          );
        });
      },
      uploadLegacy: () => {
        return owned.run(() => {
          return chat.requestUploadArtifactToGoogleDrive(
            actor,
            artifactId,
            { agentId },
            [200],
          );
        });
      },
      sourceBytes: () => {
        return owned.run(async () => {
          const download = await accept(
            files.download({
              headers: authHeaders(actor),
              query: { file_id: prepared.id },
            }),
            [200],
          );
          return Buffer.from(await download.body.arrayBuffer());
        });
      },
    };
  }

  function outgoingPictureDeck(
    uploaded: ReturnType<typeof mockGoogleDriveArtifactUpload>,
    mimeType: string,
  ): Buffer {
    // Drive's JSON session POST and raw PUT are distinct, not multipart MIME.
    expect(uploaded.metadata).toHaveLength(1);
    expect(JSON.parse(uploaded.metadata[0]!)).toMatchObject({ mimeType });
    expect(uploaded.uploadContentTypeHeaders).toStrictEqual([picturePptxMime]);
    expect(uploaded.contentTypeHeaders).toStrictEqual([picturePptxMime]);
    expect(uploaded.bodies).toHaveLength(1);
    const outgoing = Buffer.from(uploaded.bodies[0]!);
    expect(uploaded.contentRangeHeaders).toStrictEqual([
      `bytes 0-${String(outgoing.byteLength - 1)}/${String(outgoing.byteLength)}`,
    ]);
    return outgoing;
  }

  function expectPicturePackagePreserved(source: Buffer, outgoing: Buffer) {
    const before = new AdmZip(source);
    const after = new AdmZip(outgoing);
    const parts = before.getEntries().map((entry) => {
      return entry.entryName;
    });
    expect(
      after
        .getEntries()
        .map((entry) => {
          return entry.entryName;
        })
        .sort(),
    ).toStrictEqual([...parts].sort());
    // Keep the source pixels, image relationships, slide list and page size.
    for (const part of parts) {
      if (
        part.startsWith("ppt/media/") ||
        part.endsWith(".rels") ||
        part === "ppt/presentation.xml" ||
        part === "[Content_Types].xml"
      ) {
        expect(after.readFile(part)).toStrictEqual(before.readFile(part));
      }
    }
  }

  function expectReportedPicture(
    picture: ReturnType<typeof uploadedSlidesPictures>[number],
  ) {
    expect(picture).toMatchObject({
      id: "2",
      name: "reported-arc-yellow",
      embed: "rIdImage",
      preset: "rect",
      frame: { x: 6_339_840, y: 757_637, cx: 5_852_160, cy: 6_100_363 },
    });
    expect(picture.crop).not.toBeNull();
    expect(picture.crop!.l).toBe(0);
    expect(picture.crop!.t).toBe(0);
    expect(Math.abs(picture.crop!.r - 22_581)).toBeLessThanOrEqual(1);
    expect(Math.abs(picture.crop!.b - 20_511)).toBeLessThanOrEqual(1);
  }

  it.each(["google", "original"] as const)(
    "uploads native cropped picture frames only for Google Slides conversion (%s)",
    async (mode) => {
      const bytes = slidesPictureCropFixture();
      const fixture = await publicOfficeConversionSource(bytes);
      const native = {
        id: "picture-deck",
        name: "deck",
        mimeType:
          mode === "google"
            ? GOOGLE_WORKSPACE_MIME_TYPES.presentation
            : picturePptxMime,
      };
      const uploaded = mockGoogleDriveArtifactUpload(native);
      if (mode === "google") {
        mockGoogleWorkspaceReadback(native);
        mockGoogleSlidesReadback([{ pageElementCount: 5 }]);
      }
      const response = await fixture.upload(mode);
      expect(response.body).toMatchObject(native);
      const outgoing = outgoingPictureDeck(uploaded, native.mimeType);
      expectPicturePackagePreserved(bytes, outgoing);
      const pictures = uploadedSlidesPictures(outgoing);
      expect(
        pictures.map((picture) => {
          return [picture.id, picture.name, picture.grouped];
        }),
      ).toStrictEqual([
        ["2", "reported-arc-yellow", false],
        ["3", "left-top", false],
        ["4", "already-cropped-all-edges", false],
        ["5", "in-bounds-control", false],
        ["7", "nested-off-page", true],
      ]);
      for (const picture of pictures) {
        expect(picture).toMatchObject({ embed: "rIdImage", preset: "rect" });
      }
      if (mode === "original") {
        expect(outgoing).toStrictEqual(bytes);
      } else {
        expectReportedPicture(pictures[0]!);
        expect(pictures[1]).toMatchObject({
          frame: { x: 0, y: 0, cx: 10_972_800, cy: 6_172_200 },
          crop: { l: 10_000, t: 10_000, r: 0, b: 0 },
        });
        expect(pictures[2]).toMatchObject({
          frame: { x: 0, y: 0, cx: 12_192_000, cy: 6_858_000 },
          crop: { l: 16_000, t: 27_000, r: 36_000, b: 17_000 },
        });
        expect(pictures[3]).toMatchObject({
          frame: { x: 1_219_200, y: 685_800, cx: 2_438_400, cy: 1_371_600 },
          crop: null,
        });
        for (const picture of pictures) {
          if (!picture.grouped) {
            expect(picture.frame.x).toBeGreaterThanOrEqual(0);
            expect(picture.frame.y).toBeGreaterThanOrEqual(0);
            expect(picture.frame.x + picture.frame.cx).toBeLessThanOrEqual(
              12_192_000,
            );
            expect(picture.frame.y + picture.frame.cy).toBeLessThanOrEqual(
              6_858_000,
            );
          }
        }
        expect(pictures[4]).toMatchObject({
          frame: { x: -1_219_200, y: 0, cx: 2_438_400, cy: 1_371_600 },
          crop: null,
        });
      }
      await expect(fixture.sourceBytes()).resolves.toStrictEqual(bytes);
    },
    120_000,
  );

  it("uploads native cropped picture frames through the legacy Slides conversion route", async () => {
    const bytes = slidesPictureCropFixture();
    const fixture = await publicOfficeConversionSource(bytes);
    const native = {
      id: "legacy-picture-deck",
      name: "deck",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.presentation,
    };
    const uploaded = mockGoogleDriveArtifactUpload(native);
    mockGoogleSlidesReadback([{ pageElementCount: 5 }]);
    const response = await fixture.uploadLegacy();
    expect(response.body).toMatchObject(native);
    const outgoing = outgoingPictureDeck(uploaded, native.mimeType);
    expectReportedPicture(uploadedSlidesPictures(outgoing)[0]!);
    expectPicturePackagePreserved(bytes, outgoing);
    await expect(fixture.sourceBytes()).resolves.toStrictEqual(bytes);
  }, 120_000);

  it("preserves unsupported, fully outside and timed pictures during Slides conversion", async () => {
    const bytes = slidesPictureCropNoopFixture();
    const fixture = await publicOfficeConversionSource(bytes);
    const native = {
      id: "conservative-picture-deck",
      name: "deck",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.presentation,
    };
    const uploaded = mockGoogleDriveArtifactUpload(native);
    mockGoogleWorkspaceReadback(native);
    mockGoogleSlidesReadback([
      { pageElementCount: 13 },
      { pageElementCount: 1 },
      { pageElementCount: 1 },
      { pageElementCount: 1 },
    ]);
    const response = await fixture.upload("google");
    expect(response.body).toMatchObject(native);
    const outgoing = outgoingPictureDeck(uploaded, native.mimeType);
    expect(uploadedSlidesPictures(outgoing)).toStrictEqual(
      uploadedSlidesPictures(bytes),
    );
    expect(outgoing).toStrictEqual(bytes);
    expectPicturePackagePreserved(bytes, outgoing);
    await expect(fixture.sourceBytes()).resolves.toStrictEqual(bytes);
  }, 120_000);

  it.each(["google", "original"] as const)(
    "prepares editable presentation text only for Slides conversion (%s)",
    async (mode) => {
      const bytes = slidesImportFixture();
      const fixture = await workspaceSource("deck.pptx", bytes, false, true);
      mockSlidesImportFonts();
      const native = {
        id: "prepared-deck",
        name: "deck",
        mimeType:
          mode === "original"
            ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            : GOOGLE_WORKSPACE_MIME_TYPES.presentation,
      };
      const uploaded = mockGoogleDriveArtifactUpload(native);
      if (mode !== "original") {
        mockGoogleWorkspaceReadback(native);
        mockGoogleSlidesReadback([{ pageElementCount: 12 }]);
      }
      const response = await fixture.upload(mode);
      expect(response.status).toBe(200);
      if (mode === "original") {
        expect(Buffer.from(uploaded.bodies[0]!)).toStrictEqual(bytes);
      } else {
        const text = uploadedSlidesText(uploaded.bodies[0]!);
        expect(text).toHaveLength(12);
        expect(
          text.find((item) => {
            return item.id === "2";
          }),
        ).toMatchObject({ text: "05", sizes: [192] });
        // The 259.2pt glyph advance needs spare capacity in the editor;
        // preserving only that exact width is not a successful reservation.
        const numberWidth = text.find((item) => {
          return item.id === "2";
        })!.width;
        expect(numberWidth).toBeGreaterThanOrEqual(259.2 + 0.75);
        expect(numberWidth).toBeLessThanOrEqual(259.2 + 2);
        expect(
          text.find((item) => {
            return item.id === "3";
          })?.width,
        ).toBeCloseTo(300.52, 4);
        expect(
          text.find((item) => {
            return item.id === "4";
          }),
        ).toMatchObject({
          text: "White Green",
          colors: ["FFFFFF", "00FF00"],
          sizes: [20, 20],
        });
        expect(
          text.filter((item) => {
            return item.text.startsWith("Column");
          }),
        ).toHaveLength(2);
        expect(
          text.find((item) => {
            return item.id === "8";
          })?.width,
        ).toBe(251);
        expect(
          text.find((item) => {
            return item.id === "10";
          })?.width,
        ).toBe(235);
        expect(
          text.find((item) => {
            return item.id === "11";
          }),
        ).toMatchObject({ text: "Unknown font", width: 100 });
        expect(
          text.find((item) => {
            return item.id === "12";
          }),
        ).toMatchObject({ text: "05", width: 27, sizes: [20] });
        expect(
          text.find((item) => {
            return item.id === "14";
          }),
        ).toMatchObject({ text: "05", width: 27, sizes: [20] });
      }
      await fixture.finish();
    },
    120_000,
  );

  it.each([false, true])(
    "reserves positive font kerning for editable Slides text (split runs: %s)",
    async (splitTopicNumber) => {
      const bytes = slidesImportFixture({
        topicNumber: "06",
        splitTopicNumber,
      });
      const fixture = await workspaceSource("deck.pptx", bytes, false, true);
      mockSlidesImportFonts();
      const native = {
        id: "kerned-deck",
        name: "deck",
        mimeType: GOOGLE_WORKSPACE_MIME_TYPES.presentation,
      };
      const uploaded = mockGoogleDriveArtifactUpload(native);
      mockGoogleWorkspaceReadback(native);
      mockGoogleSlidesReadback([{ pageElementCount: 12 }]);
      const response = await fixture.upload("google");
      expect(response.status).toBe(200);
      const number = uploadedSlidesText(uploaded.bodies[0]!).find((item) => {
        return item.id === "2";
      });
      expect(number).toMatchObject({
        text: "06",
        sizes: splitTopicNumber ? [192, 192] : [192],
        colors: splitTopicNumber ? ["242121", "00FF00"] : ["242121"],
      });
      // The fixture's 0/6 pair adds 30 units to its 1300-unit advance.
      // A color boundary must not hide that positive kerning adjustment.
      expect(number!.width).toBeGreaterThanOrEqual(255.36 + 0.75);
      expect(number!.width).toBeLessThanOrEqual(255.36 + 2);
      await fixture.finish();
    },
    120_000,
  );

  it("preserves a slide with transformed obstacles instead of guessing text clearance", async () => {
    const archive = new AdmZip(slidesImportFixture());
    const slide = archive.readAsText("ppt/slides/slide1.xml");
    archive.addFile(
      "ppt/slides/slide1.xml",
      Buffer.from(slide.replace("<a:xfrm>", '<a:xfrm rot="5400000">')),
    );
    const bytes = archive.toBuffer();
    const fixture = await workspaceSource("deck.pptx", bytes, false, true);
    const native = {
      id: "transformed-deck",
      name: "deck",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.presentation,
    };
    const uploaded = mockGoogleDriveArtifactUpload(native);
    mockGoogleWorkspaceReadback(native);
    mockGoogleSlidesReadback([{ pageElementCount: 13 }]);
    const response = await fixture.upload("google");
    expect(response.status).toBe(200);
    expect(Buffer.from(uploaded.bodies[0]!)).toStrictEqual(bytes);
    await fixture.finish();
  }, 120_000);

  it("reports a font provider outage before uploading a partly prepared deck", async () => {
    const fixture = await workspaceSource(
      "deck.pptx",
      slidesImportFixture(),
      false,
      true,
    );
    mockSlidesImportFonts(503);
    const uploaded = mockGoogleDriveArtifactUpload({
      id: "unexpected",
      name: "deck",
    });
    const response = await fixture.upload("google");
    expect(response.status).toBe(400);
    expectApiError(response.body);
    expect(response.body.error.message).toContain("Could not load the fonts");
    expect(uploaded.bodies).toHaveLength(0);
    await fixture.finish();
  }, 120_000);

  it("explicit Google conversion still rejects and removes an empty Slides deck", async () => {
    const fixture = await workspaceSource(
      "deck.pptx",
      Buffer.from("presentation"),
      false,
      true,
    );
    const native = {
      id: "blank-deck",
      name: "deck",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.presentation,
    };
    mockGoogleDriveArtifactUpload(native);
    mockGoogleWorkspaceReadback(native);
    const readback = mockGoogleSlidesReadback([{ pageElementCount: 0 }]);
    const response = await fixture.upload("google");
    expect(response.status).toBe(400);
    expectApiError(response.body);
    expect(response.body.error.message).toContain("empty deck");
    expect(readback.trashedFileIds).toStrictEqual(["blank-deck"]);
    await fixture.finish();
  }, 120_000);

  it("does not report a previously converted empty Slides deck as success or delete it on retry", async () => {
    const fixture = await workspaceSource(
      "deck.pptx",
      Buffer.from("presentation"),
      false,
      true,
    );
    const native = {
      id: "previous-deck",
      name: "deck",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.presentation,
    };
    const upload = mockGoogleDriveArtifactUpload(native);
    mockGoogleDriveFilesList(() => {
      return { status: 200, files: [native] };
    });
    mockGoogleWorkspaceReadback(native);
    const readback = mockGoogleSlidesReadback([{ pageElementCount: 0 }]);
    const response = await fixture.upload("google");
    expect(response.status).toBe(400);
    expectApiError(response.body);
    expect(response.body.error.message).toContain(
      "previously converted presentation is empty",
    );
    expect(upload.bodies).toHaveLength(0);
    expect(readback.trashedFileIds).toHaveLength(0);
    await fixture.finish();
  }, 120_000);

  it("workspace conversion does not create another file when checking previous results fails", async () => {
    const fixture = await workspaceSource("report.txt", Buffer.from("Hello"));
    const upload = mockGoogleDriveArtifactUpload({
      id: "unexpected",
      name: "report",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
    });
    mockGoogleDriveFilesList(() => {
      return { status: 500 };
    });
    const response = await fixture.upload("google");
    expect(response.status).toBe(400);
    expectApiError(response.body);
    expect(response.body.error.message).toContain(
      "could not check previous conversions",
    );
    expect(upload.bodies).toHaveLength(0);
    await fixture.finish();
  }, 120_000);

  it("workspace conversion reuses a completed editable copy when the caller retries", async () => {
    const fixture = await workspaceSource("report.txt", Buffer.from("Hello"));
    const native = {
      id: "native-file",
      name: "report",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
    };
    const upload = mockGoogleDriveArtifactUpload(native, {
      reuseUploadedFile: true,
    });
    mockGoogleWorkspaceReadback(native);
    expect((await fixture.upload("google")).status).toBe(200);
    expect((await fixture.upload("google")).body).toMatchObject({
      id: "native-file",
      mimeType: native.mimeType,
    });
    expect(upload.bodies).toHaveLength(1);
    await fixture.finish();
  }, 120_000);

  it.each([true, false])(
    "workspace conversion status keeps a native result alongside an original (native first: %s)",
    async (nativeFirst) => {
      const fixture = await workspaceSource("report.txt", Buffer.from("Hello"));
      const properties = {
        vm0Artifact: "true",
        vm0ThreadId: fixture.run.threadId,
        vm0RunId: fixture.run.runId,
        vm0FileId: fixture.deckId,
      };
      const native = {
        id: "native-file",
        name: "report",
        mimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
        appProperties: properties,
      };
      const original = {
        id: "original-file",
        name: "report.txt",
        mimeType: "text/plain",
        appProperties: properties,
      };
      mockGoogleDriveFilesList(() => {
        return {
          status: 200,
          files: nativeFirst ? [native, original] : [original, native],
        };
      });
      const artifacts = await chat.listThreadArtifacts(
        fixture.actor,
        fixture.run.threadId,
      );
      expect(artifacts.runs[0]?.files[0]?.googleDriveSync).toMatchObject({
        status: "synced",
        id: "native-file",
        originalUploaded: true,
        mimeType: native.mimeType,
        webViewLink: "https://docs.google.com/document/d/native-file/edit",
      });
      await fixture.finish();
    },
    120_000,
  );

  it("workspace conversion rejects and removes a provider result in the wrong format", async () => {
    const fixture = await workspaceSource("report.txt", Buffer.from("Hello"));
    const raw = { id: "raw-file", name: "report.txt", mimeType: "text/plain" };
    mockGoogleDriveArtifactUpload(raw);
    const readback = mockGoogleWorkspaceReadback(raw);
    const response = await fixture.upload("google");
    expect(response.status).toBe(400);
    expectApiError(response.body);
    expect(response.body.error.message).toContain(
      "unsuccessful copy was removed",
    );
    expect(readback.trashedFileIds).toStrictEqual(["raw-file"]);
    await fixture.finish();
  }, 120_000);

  it.each([
    {
      label: "converts a pptx artifact into a native slides deck",
      pageElementCounts: [3, 5],
      trashAccepted: true,
      expectedMessage: null,
    },
    {
      label: "discards a conversion that produced an empty deck",
      pageElementCounts: [0, 0],
      trashAccepted: true,
      expectedMessage:
        "Google Slides converted this presentation to an empty deck",
    },
    {
      label: "reports an empty deck drive refused to discard",
      pageElementCounts: [0, 0],
      trashAccepted: false,
      expectedMessage:
        "Google Slides converted this presentation to an empty deck that could not be removed from Drive",
    },
  ])(
    "$label",
    async ({ pageElementCounts, trashAccepted, expectedMessage }) => {
      const { actor, agentId, deckId, run, sandboxHeaders } =
        await setupSlidesConversionSync({
          agentLabel: "Artifacts slides conversion agent",
          conversionEnabled: true,
        });

      const uploadRecorder = mockGoogleDriveArtifactUpload({
        id: "drive-slides-deck",
        name: "deck.pptx",
        webViewLink:
          "https://docs.google.com/presentation/d/drive-slides-deck/edit",
      });
      const readback = mockGoogleSlidesReadback(
        pageElementCounts.map((pageElementCount) => {
          return { pageElementCount };
        }),
        { trashAccepted },
      );

      const synced = await chat.requestUploadArtifactToGoogleDrive(
        actor,
        await chat.resolveCatalogArtifactId(actor, run.threadId, deckId),
        { agentId },
        expectedMessage === null ? [200] : [400],
      );

      // The metadata asks Drive to convert while the part still declares the
      // uploaded bytes' own type.
      const multipart = uploadRecorder.metadata[0]!;
      expect(multipart).toContain(
        '"mimeType":"application/vnd.google-apps.presentation"',
      );
      expect(uploadRecorder.uploadContentTypeHeaders[0]).toBe(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
      expect(readback.presentationIds).toStrictEqual(["drive-slides-deck"]);

      if (expectedMessage === null) {
        expect(synced.body).toMatchObject({ id: "drive-slides-deck" });
        expect(readback.trashedFileIds).toStrictEqual([]);
      } else {
        expectApiError(synced.body);
        expect(synced.body.error.message).toBe(expectedMessage);
        // A blank deck must not be reported as a successful sync, and a deck
        // Drive would not discard must not be reported as discarded.
        expect(readback.trashedFileIds).toStrictEqual(["drive-slides-deck"]);
      }

      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(run.runId, sandboxHeaders);
    },
    120_000,
  );

  it("uploads a presentation unchanged while slides conversion is off", async () => {
    const { actor, agentId, deckId, run, sandboxHeaders } =
      await setupSlidesConversionSync({
        agentLabel: "Artifacts slides conversion disabled agent",
        conversionEnabled: false,
      });

    const uploadRecorder = mockGoogleDriveArtifactUpload({
      id: "drive-plain-deck",
      name: "deck.pptx",
      webViewLink: "https://drive.google.com/file/d/drive-plain-deck/view",
    });
    // No Slides handler is registered, so an unexpected read-back would fail
    // the request instead of passing silently.

    const synced = await chat.requestUploadArtifactToGoogleDrive(
      actor,
      await chat.resolveCatalogArtifactId(actor, run.threadId, deckId),
      { agentId },
      [200],
    );

    expect(synced.body).toMatchObject({ id: "drive-plain-deck" });
    const multipart = uploadRecorder.metadata[0]!;
    expect(multipart).toContain(
      '"mimeType":"application/vnd.openxmlformats-officedocument.presentationml.presentation"',
    );
    expect(multipart).not.toContain("application/vnd.google-apps.presentation");

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders);
  }, 120_000);

  it("reports a presentation google slides cannot read", async () => {
    const { actor, agentId, deckId, run, sandboxHeaders } =
      await setupSlidesConversionSync({
        agentLabel: "Artifacts slides unreadable agent",
        conversionEnabled: true,
      });

    mockGoogleDriveArtifactUploadRejection(
      "conversionUnsupportedConversionPath",
    );

    const rejected = await chat.requestUploadArtifactToGoogleDrive(
      actor,
      await chat.resolveCatalogArtifactId(actor, run.threadId, deckId),
      { agentId },
      [400],
    );

    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe(
      "Google Slides could not read this presentation",
    );

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
    const synced = await chat.requestUploadArtifactToGoogleDrive(
      actor,
      await chat.resolveCatalogArtifactId(actor, run.threadId, fileId),
      { agentId, connectionId: selectedAccount.id },
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

    const unavailable = await chat.requestUploadArtifactToGoogleDrive(
      actor,
      await chat.resolveCatalogArtifactId(actor, run.threadId, fileId),
      { agentId, connectionId: selectedAccount.id },
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

  it("dedupes artifact urls and lists hosted sites beside run files", async () => {
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

    // A hosted-site deployment is listed next to the run's other files rather
    // than replacing them, so run 2 keeps its copy of the shared URL and the
    // dedupe still resolves that URL to run 2.
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
    expect(hostedGroup?.files).toHaveLength(2);
    expect(hostedGroup?.files[0]?.id).toBe(sharedId);
    expect(hostedGroup?.files[1]).toMatchObject({
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
    ).toStrictEqual([ownId]);

    await createBillingMediaApi(context).updateFeatureSwitches(actor, {
      [FeatureSwitchKey.HostedSiteUrlEditing]: true,
    });
    const nextSlug = `${prepared.publicSlug}-renamed`;
    const renamed = await accept(
      setupApp({ context, routes: hostRoutes })(hostContract).updateSiteUrl({
        headers: authHeaders(actor),
        params: { siteId: prepared.siteId },
        body: {
          publicSlug: nextSlug,
          expectedPublicSlug: prepared.publicSlug,
        },
      }),
      [200],
    );
    const reread = await chat.listThreadArtifacts(actor, run1.threadId);
    const renamedFile = reread.runs
      .flatMap((run) => {
        return run.files;
      })
      .find((file) => {
        return file.url === prepared.artifactUrl;
      });
    expect(renamedFile).toMatchObject({
      url: prepared.artifactUrl,
      aliasUrl: renamed.body.url,
      artifactKind: "hosted-site",
    });

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

  it("keeps files generated beside a hosted site visible", async () => {
    const { actor, agentId, runnerGroup } =
      await entitledChatActor("Hosted media agent");
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const objectStore = chatCallbacks.acceptChatObjectStorage();

    // One run generates deliverables and then publishes a site alongside them.
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "generate media then publish a site",
    });
    await flushWaitUntilForTest();
    const claim = await claimChatRun(runnerGroup, run.runId);
    const bearer = `Bearer ${okouTokenFromClaim(claim.claim)}`;
    const videoId = randomUUID();
    const imageId = randomUUID();
    const deckId = randomUUID();
    for (const [id, name, size] of [
      [videoId, "kitten.mp4", 2048],
      [imageId, "kitten.jpg", 512],
      [deckId, "kitten.pdf", 128],
    ] as const) {
      objectStore.addObject({
        bucket: "test-user-artifacts",
        key: `artifacts/${actor.userId}/${id}/${name}`,
        size,
      });
    }
    // The video carries an explicit content type; the others resolve theirs
    // from the filename.
    await chat.completeUploadWithBearer(
      bearer,
      { id: videoId, contentType: "video/mp4" },
      [200],
    );
    await chat.completeUploadWithBearer(bearer, { id: imageId }, [200]);
    await chat.completeUploadWithBearer(bearer, { id: deckId }, [200]);

    const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
      site: `bdd-media-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>kitten</main>")],
    });
    await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);

    const artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    const group = artifacts.runs.find((item) => {
      return item.runId === run.runId;
    });
    // Publishing a site does not withdraw the deliverables generated with it,
    // so each stays addressable with its own metadata.
    expect(group?.files).toHaveLength(4);
    expect(
      group?.files.slice(0, 3).map((file) => {
        return file.id;
      }),
    ).toStrictEqual([videoId, imageId, deckId]);
    expect(group?.files[0]).toMatchObject({
      contentType: "video/mp4",
      filename: "kitten.mp4",
    });
    expect(group?.files[3]).toMatchObject({
      artifactKind: "hosted-site",
      url: prepared.artifactUrl,
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, claim.sandboxHeaders);
  }, 120_000);
});
