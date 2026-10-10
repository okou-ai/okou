import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { CANONICAL_WORKING_DIR } from "@okouai/api-contracts/contracts/runners";
import {
  chatEventsContract,
  chatThreadsContract,
  type ChatEvent,
  type ChatRunOptionsRequest,
  type ChatThreadEvent,
  type GenerationTemplateRequest,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { createPiSessionJsonl } from "@okouai/pi-agent-runtime/api";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";
import { z } from "zod";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { computeHmacSignature } from "../../../../lib/event-consumer/hmac";
import { server } from "../../../../mocks/server";
import { seededSystemSkillArchive } from "../../../../test-fixtures/seeded-system-skill-archive";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { chatEventsRoutes } from "../../chat-events";
import { chatThreadRoutes } from "../../chat-threads";
import { mailRoutes } from "../../mail";
import { webhooksWorkflowAutomationsRoutes } from "../../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../../workflow-automations";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./api-bdd";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./api-bdd-auth-device-support";
import { createChatCallbacksApi } from "./api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createConnectorBddApi } from "./api-bdd-connectors";
import { createMiscRoutesApi } from "./api-bdd-misc";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { chatEventDisplayText } from "./chat-event";
import { nowDate } from "../../../../lib/time";
import { createRouteMocks } from "./route-test";
const TEST_APP_ROUTES = Object.freeze([
  ...chatEventsRoutes,
  ...chatThreadRoutes,
  ...mailRoutes,
]);

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

export const CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET =
  "okou web upload-file -f <path>";

export const GPT_PI_BDD_MODELS = [
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
] as const;

export type PiGptBddModel = (typeof GPT_PI_BDD_MODELS)[number];

export const USER_OWNED_GPT_FAST_BDD_ROUTES = GPT_PI_BDD_MODELS.map(
  (selectedModel) => {
    return {
      name: `subscription ${selectedModel}`,
      selectedModel,
      type: "codex-oauth-token",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      runtimeModel: selectedModel,
      wireTier: "priority",
    } as const;
  },
);

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

export type PromptMessage = Extract<ChatEvent, { eventType: "input.prompt" }>;

type OutputMessage = Extract<ChatEvent, { eventType: "output.message" }>;

export type RunnerClaim = Awaited<
  ReturnType<ReturnType<typeof createRunsApi>["claimRunnerJob"]>
>;

export interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly customerId: string;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
}

export interface ChatRunSendBody {
  readonly agentId: string;
  readonly prompt: string;
  readonly userMessage?: UserMessageInputDocument;
  readonly threadId?: string;
  readonly clientThreadId?: string;
  readonly clientEventId?: string;
  /** Null selects Auto. */
  readonly model?: string | null;
  readonly runOptions?: ChatRunOptionsRequest;
  readonly template?: GenerationTemplateRequest;
  readonly computerUseHostId?: string | null;
  readonly revokesEventId?: string;
  readonly captureNetworkBodies?: boolean;
}

/**
 * Template markers render inline, so a client that wants the template on its
 * own line sends the blank line as an explicit text part.
 */
export function userMessageWithTemplate(
  prompt: string,
  template: GenerationTemplateRequest,
): UserMessageInputDocument {
  const titleSnapshot = `${template.type[0]?.toUpperCase()}${template.type.slice(1)} template`;
  return {
    version: 1,
    parts: [
      { type: "text", text: prompt },
      { type: "text", text: "\n\n" },
      { type: "template", titleSnapshot, template },
    ],
  };
}

export function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected entitled chat actor to have an org");
  }
  return actor.orgId;
}

export function claimEnvironment(claim: RunnerClaim): Record<string, string> {
  return {
    ...claim.environment,
    ...claim.platformEnvironment,
  };
}

/** Sandbox-scoped Okou token issued through the trusted claim environment. */
export function okouTokenFromClaim(claim: RunnerClaim): string {
  const token = claimEnvironment(claim).OKOU_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error(
      "Expected the claim platform environment to carry an OKOU_TOKEN",
    );
  }
  return token;
}

/**
 * Checkpoint + exitCode-0 complete (completing without a checkpoint fails the
 * run).
 */
export interface ChatRunCompletionOptions {
  readonly cliAgentSessionId?: string;
  readonly cliAgentType?: "claude-code" | "codex" | "pi";
  readonly lastEventSequence?: number;
  readonly sessionHistory?: string;
}

export function assistantMessages(
  messages: readonly ChatEvent[],
): AssistantMessage[] {
  return messages.filter((message): message is AssistantMessage => {
    return !isUserMessage(message);
  });
}

export function userMessages(messages: readonly ChatEvent[]): UserMessage[] {
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

export function eventBackedContents(
  messages: readonly ChatEvent[],
  runId: string,
): OutputMessage[] {
  return messages.filter((message): message is OutputMessage => {
    return message.eventType === "output.message" && message.runId === runId;
  });
}

export function assistantEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    eventType: "assistant",
    sequenceNumber,
    eventData: { message: { content: [{ type: "text", text }] } },
  };
}

export function modelProviderSecretPlaceholder(
  type: ModelProviderType,
  secretName: string,
): string {
  const placeholder =
    getModelProviderFirewall(type)?.placeholders?.[secretName];
  if (!placeholder) {
    throw new Error(`Missing model provider placeholder for ${secretName}`);
  }
  return placeholder;
}

export interface PiCheckpointS3Command {
  readonly constructor?: { readonly name?: string };
  readonly input?: {
    readonly Body?: unknown;
    readonly Bucket?: unknown;
    readonly Delete?: {
      readonly Objects?: readonly { readonly Key?: unknown }[];
    };
    readonly Key?: unknown;
  };
}

export function piS3ObjectKey(
  candidate: PiCheckpointS3Command,
): string | undefined {
  const bucket = candidate.input?.Bucket;
  const key = candidate.input?.Key;
  return typeof bucket === "string" && typeof key === "string"
    ? `${bucket}/${key}`
    : undefined;
}

function mockPiPutObject(
  objects: Map<string, Buffer>,
  candidate: PiCheckpointS3Command,
): Promise<unknown> | undefined {
  const objectKey = piS3ObjectKey(candidate);
  if (candidate.constructor?.name !== "PutObjectCommand" || !objectKey) {
    return undefined;
  }
  const body = candidate.input?.Body;
  if (typeof body === "string") {
    objects.set(objectKey, Buffer.from(body, "utf8"));
  } else if (body instanceof Uint8Array) {
    objects.set(objectKey, Buffer.from(body));
  } else {
    throw new Error("Expected Pi S3 writes to use string or byte bodies");
  }
  return Promise.resolve({});
}

function mockPiGetObject(
  objects: Map<string, Buffer>,
  candidate: PiCheckpointS3Command,
): Promise<unknown> | undefined {
  const objectKey = piS3ObjectKey(candidate);
  if (candidate.constructor?.name !== "GetObjectCommand" || !objectKey) {
    return undefined;
  }
  const bytes = objects.get(objectKey);
  return bytes
    ? Promise.resolve({
        ContentLength: bytes.length,
        Body: (async function* () {
          yield bytes;
        })(),
      })
    : undefined;
}

function mockPiDeleteObjects(
  objects: Map<string, Buffer>,
  candidate: PiCheckpointS3Command,
): Promise<unknown> | undefined {
  const bucket = candidate.input?.Bucket;
  if (
    candidate.constructor?.name !== "DeleteObjectsCommand" ||
    typeof bucket !== "string"
  ) {
    return undefined;
  }
  for (const object of candidate.input?.Delete?.Objects ?? []) {
    if (typeof object.Key === "string") {
      objects.delete(`${bucket}/${object.Key}`);
    }
  }
  return Promise.resolve({});
}

export const PI_RESOURCE_ARCHIVE_DOWNLOAD_URL =
  "https://r2.example.com/storage/archive.tar.gz";

export function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export async function readThreadMessagesAfterBackgroundWork(
  chat: ReturnType<typeof createChatFilesBddApi>,
  actor: ApiTestUser,
  threadId: string,
  predicate: (messages: readonly ChatEvent[]) => boolean,
) {
  await flushWaitUntilForTest();
  const page = await chat.listThreadEvents(actor, threadId);
  expect(predicate(page.events)).toBeTruthy();
  return page;
}

export function createChatEventsFixture(context: TestContext) {
  const bdd = createBddApi(context);

  const api = createRunsApi(context);

  const chat = createChatFilesBddApi(context);

  const webhooks = createWebhookCallbackApi(context);

  const chatCallbacks = createChatCallbacksApi(context);

  const connectors = createConnectorBddApi(context);

  const misc = createMiscRoutesApi(context);

  const authDevice = createAuthDeviceApiActions(context);

  const authDeviceSupport = createAuthDeviceSupportApi(context);

  const routeMocks = createRouteMocks(context);

  async function entitledChatActor(
    options: ApiTestUserOptions = {},
    tier: "pro" | "team" = "pro",
  ): Promise<EntitledChatActor> {
    const actor = bdd.user(options);
    chatCallbacks.acceptChatObjectStorage();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    chatCallbacks.disableVapid();
    const runnerGroup = api.configureRunnerGroup();
    const { customerId } = await api.grantProEntitlement(actor, {
      ...(options.orgId === STAFF_ORG_ID
        ? {
            customerId: "cus_bdd_chat_events_staff",
            subscriptionId: "sub_bdd_chat_events_staff",
          }
        : {}),
      tier,
    });
    const { providerId } = await api.ensurePersonalSubscriptionModel(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD chat messages agent",
      description: "Exercises the web chat send route.",
      visibility: "private",
    });
    return {
      actor,
      customerId,
      agentId: agent.agentId,
      runnerGroup,
      providerId,
    };
  }

  /**
   * An entitled actor with a personal Fable subscription route for sends
   * that must stay claimable by the native Runner.
   */
  async function entitledNativeChatActor(
    options: ApiTestUserOptions = {},
    tier: "pro" | "team" = "pro",
  ): Promise<EntitledChatActor> {
    const entitled = await entitledChatActor(options, tier);
    const { providerId } = await api.ensurePersonalSubscriptionModel(
      entitled.actor,
      {
        model: "claude-fable-5-1",
      },
    );
    return { ...entitled, providerId };
  }

  async function configureUserOwnedGptPiModel(
    actor: ApiTestUser,
    route: (typeof USER_OWNED_GPT_FAST_BDD_ROUTES)[number],
  ) {
    const accountId = "subscription-continuity-account";
    const { oauth } = await configureSubscriptionPiModel(
      actor,
      { accountId },
      route.selectedModel,
    );
    return {
      secret: z.string().parse(oauth.oauthTokenResponses[0]?.access_token),
      accountId,
    };
  }

  async function configureSubscriptionPiModel(
    actor: ApiTestUser,
    options: Parameters<typeof mockCodexDeviceAuthProvider>[0] = {},
    selectedModel: PiGptBddModel = "gpt-6-luna",
  ) {
    const oauth = mockCodexDeviceAuthProvider({
      ...options,
    });
    const started = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      {
        mode: "add",
      },
    );
    if (started.status !== 200) {
      throw new Error("Expected subscription auth to start");
    }
    const completed = await authDevice.requestCodexComplete(
      actor,
      started.body.sessionToken,
      [200],
    );
    if (!("status" in completed.body) || completed.body.status !== "complete") {
      throw new Error("Expected subscription auth to complete");
    }
    await api.updateUserModelPreference(actor, selectedModel);
    return { oauth, accountSourceId: completed.body.provider.id };
  }

  async function sendChatRun(
    actor: ApiTestUser,
    body: ChatRunSendBody,
    options?: { readonly awaitEnqueuedPick: boolean },
  ): Promise<{ readonly runId: string; readonly threadId: string }> {
    const { template, ...canonicalBody } = body;
    const requestBody = {
      ...canonicalBody,
      ...(template === undefined
        ? {}
        : { userMessage: userMessageWithTemplate(body.prompt, template) }),
      clientEventId: body.clientEventId ?? randomUUID(),
    };
    const sent = await chat.requestSendEvent(actor, requestBody, [201], {});
    if (sent.status !== 201) {
      throw new Error("Expected the entitled chat send to create a run");
    }
    let runId: string | null | undefined = sent.body.runId;
    if (runId === null) {
      // A successful-run fixture owns the enqueued pick before inspecting its
      // effects. Tests that intentionally hold publication can opt out and
      // observe their own explicit intermediate boundary.
      if (options?.awaitEnqueuedPick !== false) {
        await flushWaitUntilForTest();
      }
      const messages = await waitForThreadMessages(
        actor,
        sent.body.threadId,
        (items) => {
          return userMessages(items).some((message) => {
            return (
              message.revokesEventId === requestBody.clientEventId &&
              message.runId !== undefined
            );
          });
        },
      );
      runId = userMessages(messages.events).find((message) => {
        return message.revokesEventId === requestBody.clientEventId;
      })?.runId;
    }
    if (runId === undefined || runId === null) {
      throw new Error("Expected the entitled chat send to create a run");
    }
    return { runId, threadId: sent.body.threadId };
  }

  async function sendChatRunAfterPick(
    actor: ApiTestUser,
    body: ChatRunSendBody,
  ): Promise<{ readonly runId: string; readonly threadId: string }> {
    return await sendChatRun(actor, body, {
      awaitEnqueuedPick: true,
    });
  }

  /**
   * Send a chat prompt while the organization is at its run limit. The input
   * is accepted without a run; `launchedRun` waits until a later pick launches
   * it as the thread head and returns that run.
   */
  async function sendWaitingChatInput(
    actor: ApiTestUser,
    body: ChatRunSendBody,
  ): Promise<{
    readonly threadId: string;
    readonly launchedRun: () => Promise<{
      readonly runId: string;
      readonly threadId: string;
    }>;
  }> {
    const { template, ...canonicalBody } = body;
    const clientEventId = body.clientEventId ?? randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        ...canonicalBody,
        ...(template === undefined
          ? {}
          : { userMessage: userMessageWithTemplate(body.prompt, template) }),
        clientEventId,
      },
      [201],
      {},
    );
    if (sent.status !== 201) {
      throw new Error("Expected the at-capacity chat send to be accepted");
    }
    // At capacity the input waits in the thread without a run.
    expect(sent.body.runId).toBeNull();
    const threadId = sent.body.threadId;
    const waiting = await chat.listThreadEvents(actor, threadId);
    expect(
      userMessages(waiting.events).filter((message) => {
        return (
          message.revokesEventId === clientEventId &&
          message.runId !== undefined
        );
      }),
    ).toStrictEqual([]);
    const launchedRun = async (): Promise<{
      readonly runId: string;
      readonly threadId: string;
    }> => {
      const messages = await waitForThreadMessages(actor, threadId, (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === clientEventId &&
            message.runId !== undefined
          );
        });
      });
      const runId = userMessages(messages.events).find((message) => {
        return message.revokesEventId === clientEventId;
      })?.runId;
      if (runId === undefined) {
        throw new Error("Expected the picked thread head to launch a run");
      }
      return { runId, threadId };
    };
    return { threadId, launchedRun };
  }

  async function expectThreadCreatedModelEvent(
    actor: ApiTestUser,
    threadId: string,
    selectedModel: string | null,
  ): Promise<void> {
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: threadId,
        selectedModel,
      }),
    );
  }

  async function expectNoThreadModelUpdateEvent(
    actor: ApiTestUser,
    threadId: string,
    selectedModel: string,
  ): Promise<void> {
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).not.toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: threadId,
        selectedModel,
      }),
    );
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
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };
    return {
      claim,
      sandboxHeaders,
    };
  }

  const waitForThreadMessages = readThreadMessagesAfterBackgroundWork.bind(
    null,
    chat,
  );

  async function waitForRunUserMessage(
    actor: ApiTestUser,
    threadId: string,
    runId: string,
    content: string,
  ): Promise<void> {
    await waitForThreadMessages(actor, threadId, (items) => {
      return userMessages(items).some((message) => {
        return (
          message.runId === runId && chatEventDisplayText(message) === content
        );
      });
    });
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
      | "running"
      | "timeout",
  ): Promise<void> {
    await flushWaitUntilForTest();
    const run = await api.readRun(actor, runId);
    expect(run.status).toBe(status);
  }

  async function completeChatRunOk(
    runId: string,
    sandboxHeaders: { readonly authorization: string },
    options: ChatRunCompletionOptions = {},
  ): Promise<void> {
    const stagedOutputEvents = chatCallbacks.consumeMockChatOutputEvents();
    if (stagedOutputEvents.length > 0) {
      await webhooks.requestAgentEvents(
        { runId, events: stagedOutputEvents },
        sandboxHeaders,
        [200],
      );
    }
    const history =
      options.sessionHistory ?? `bdd chat session history ${runId}`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    if (options.sessionHistory !== undefined) {
      const historyBytes = Buffer.from(history, "utf8");
      context.sessionHistoryBlobs.set(historyHash, historyBytes);
      await webhooks.requestAgentSessionHistoryPrepare(
        {
          runId,
          hash: historyHash,
          rawSize: historyBytes.byteLength,
          encodedSize: historyBytes.byteLength,
          encoding: "identity",
        },
        sandboxHeaders,
        [200],
      );
    }
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        completion: {
          cliAgentType: options.cliAgentType ?? "claude-code",
          cliAgentSessionId: options.cliAgentSessionId ?? `bdd-cli-${runId}`,
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
      undefined,
    );
  }

  async function failChatRun(
    runId: string,
    sandboxHeaders: { readonly authorization: string },
    error: string,
  ): Promise<void> {
    await webhooks.requestAgentComplete(
      { runId, exitCode: 1, error },
      sandboxHeaders,
      [200],
    );
  }

  async function cancelChatRun(
    actor: ApiTestUser,
    runId: string,
    sandboxHeaders?: { readonly authorization: string },
  ): Promise<void> {
    await api.requestCancelRun(actor, runId, [200]);
    await waitForRunStatus(actor, runId, "cancelled");
    if (sandboxHeaders) {
      await failChatRun(runId, sandboxHeaders, "Run cancelled");
      await flushWaitUntilForTest();
    }
  }

  function chatEventsClient() {
    return setupApp({
      context,
      routes: chatEventsRoutes,
    })(chatEventsContract);
  }

  function chatThreadsClient() {
    return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
  }

  function sessionHeaders(actor: ApiTestUser): {
    readonly authorization: string;
  } {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  async function readThreadProjection(actor: ApiTestUser, threadId: string) {
    const snapshot = await chat.getThreadSnapshot(actor);
    const events: ChatThreadEvent[] = [];
    let cursor = snapshot.latestSeqId;

    for (let page = 0; page < 20; page++) {
      const response = await chat.requestThreadEvents(
        actor,
        cursor ? { sinceSeqId: cursor } : {},
        [200],
      );
      expect(response.status).toBe(200);
      if (response.status !== 200) {
        throw new Error("Expected chat thread events to load");
      }

      const sequencedEvents = response.body.events.map((event) => {
        if (event.seqId === undefined) {
          throw new Error("Expected chat thread event sequence ID");
        }
        return { ...event, seqId: event.seqId };
      });
      events.push(...sequencedEvents);
      if (!response.body.hasMore) {
        break;
      }

      const lastEvent = sequencedEvents.at(-1);
      if (!lastEvent) {
        throw new Error("Expected paginated chat thread events");
      }
      cursor = lastEvent.seqId;
    }

    const thread = replayChatThreadEvents(snapshot.chatThreads, events).find(
      (candidate) => {
        return candidate.id === threadId;
      },
    );
    if (!thread) {
      throw new Error("Expected chat thread event projection");
    }
    return thread;
  }

  /**
   * Raw chat send through the Hono app, for statuses the typed contract does
   * not model (precedent: requestListAutomationsRaw in api-bdd-runs).
   */
  async function requestSendEventRaw(
    actor: ApiTestUser,
    body: ChatRunSendBody & {
      readonly userMessage: UserMessageInputDocument;
      readonly hasTextContent: boolean;
    },
    signal: AbortSignal = context.signal,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const headers = sessionHeaders(actor);
    const app = createAppWithRoutes({
      signal,
      routes: TEST_APP_ROUTES,
    });
    const response = await app.request("/api/chat/events", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseBody: unknown = await response.json();
    return { status: response.status, body: responseBody };
  }

  /** Chat send authenticated by a run-scoped sandbox bearer token. */
  async function requestSendEventWithBearer(
    token: string,
    body: {
      readonly agentId: string;
      readonly clientEventId?: string;
      readonly prompt: string;
      readonly threadId?: string;
      readonly model?: string;
      readonly runOptions?: ChatRunOptionsRequest;
      readonly userMessage?: UserMessageInputDocument;
    },
    statuses: readonly (201 | 400 | 401 | 403 | 404 | 409)[],
  ) {
    return await accept(
      chatEventsClient().send({
        headers: { authorization: `Bearer ${token}` },
        body: {
          ...body,
          hasTextContent: true,
          userMessage:
            body.userMessage ??
            ({
              version: 1,
              parts: [{ type: "text", text: body.prompt }],
            } satisfies UserMessageInputDocument),
        },
      }),
      statuses,
    );
  }

  function threadPiAutomationsClient() {
    return setupApp({
      context,
      routes: workflowAutomationsRoutes,
    })(workflowAutomationsContract);
  }

  async function postThreadPiAutomationEvent(args: {
    readonly webhookUrl: string;
    readonly webhookSecret: string;
    readonly payload: string;
    readonly timestamp: number;
  }) {
    const rawBody = JSON.stringify({ event: args.payload });
    const timestamp = args.timestamp;
    const response = await createAppWithRoutes({
      signal: context.signal,
      routes: webhooksWorkflowAutomationsRoutes,
    }).request(new URL(args.webhookUrl).pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Okou-Timestamp": String(timestamp),
        "X-Okou-Signature": computeHmacSignature(
          rawBody,
          args.webhookSecret,
          timestamp,
        ),
      },
      body: rawBody,
    });
    expect(response.status).toBe(200);
    const body = z
      .object({ success: z.literal(true), duplicate: z.boolean() })
      .parse(await response.json());
    // The webhook enqueues and returns; the pick runs in the background.
    await flushWaitUntilForTest();
    return body;
  }

  async function lastThreadPiAutomationRun(
    actor: ApiTestUser,
    threadId: string,
  ) {
    // Automation triggers only enqueue; their picks run in the background.
    await flushWaitUntilForTest();
    const page = await chat.listThreadEvents(actor, threadId);
    const event = [...page.events].reverse().find((item) => {
      return (
        item.eventType === "input.prompt" &&
        item.userMessage.parts.some((part) => {
          return part.type === "automation";
        })
      );
    });
    if (event?.eventType !== "input.prompt" || !event.runId) {
      throw new Error("Expected an admitted Automation run");
    }
    return event.runId;
  }

  async function expectThreadPiTerminal(
    actor: ApiTestUser,
    threadId: string,
    runId: string,
  ) {
    await waitForRunStatus(actor, runId, "completed");
    await flushWaitUntilForTest();
    const page = await chat.listThreadEvents(actor, threadId);
    expect(
      page.events
        .filter((event) => {
          return (
            event.runId === runId && isChatRunTerminalEventType(event.eventType)
          );
        })
        .map((event) => {
          return event.eventType;
        }),
    ).toStrictEqual(["run.completed"]);
  }

  async function claimGptPiSandbox(
    actor: ApiTestUser,
    runId: string,
    tier: "fast" | undefined,
  ) {
    if (tier === "fast") {
      const oldClaim = await api.requestClaimRunnerJob(true, runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2] },
      });
      expectApiError(oldClaim.body);
      await expect(api.readRun(actor, runId)).resolves.toMatchObject({
        status: "pending",
      });
    }
    return await api.claimRunnerJob(runId, {
      capabilities: {
        piModelConfigGenerations: tier === "fast" ? [1, 2, 3] : [1, 2],
      },
    });
  }

  function mockPiCheckpointObjectStore(): Map<string, Buffer> {
    const objects = new Map<string, Buffer>();
    const fallback = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const candidate = command as PiCheckpointS3Command;
      return (
        mockPiPutObject(objects, candidate) ??
        mockPiGetObject(objects, candidate) ??
        mockPiDeleteObjects(objects, candidate) ??
        fallback?.(command) ??
        Promise.resolve({})
      );
    });
    return objects;
  }

  /**
   * Rebuild the session a claimed Pi Sandbox starts from, as the CLI does: the
   * claim's inline or blob-referenced resume history, else a fresh session.
   */
  function piSandboxBaseSession(
    claim: RunnerClaim,
    objects: ReadonlyMap<string, Buffer>,
  ): Buffer {
    const resume = claim.resumeSession;
    if (!resume) {
      if (!claim.piSessionId) {
        throw new Error("Expected a claimed Pi session id");
      }
      return Buffer.from(
        createPiSessionJsonl({
          cwd: CANONICAL_WORKING_DIR,
          sessionId: claim.piSessionId,
          timestamp: nowDate().toISOString(),
        }),
        "utf8",
      );
    }
    if (!("historyRef" in resume)) {
      return Buffer.from(resume.sessionHistory, "utf8");
    }
    const objectKey = new URL(resume.historyRef.url).searchParams.get("object");
    const encoded = objectKey ? objects.get(objectKey) : undefined;
    if (!encoded) {
      throw new Error("Expected the referenced Pi resume history bytes");
    }
    switch (resume.historyRef.encoding) {
      case "gzip": {
        return gunzipSync(encoded);
      }
      case "zstd": {
        return zstdDecompressSync(encoded);
      }
      case "identity": {
        return encoded;
      }
    }
  }

  function uploadedPiS3Object(objectKey: string): Buffer | undefined {
    for (const [command] of [...context.mocks.s3.send.mock.calls].reverse()) {
      const candidate = command as PiCheckpointS3Command;
      if (
        candidate.constructor?.name === "PutObjectCommand" &&
        piS3ObjectKey(candidate) === objectKey
      ) {
        if (typeof candidate.input?.Body === "string") {
          return Buffer.from(candidate.input.Body, "utf8");
        }
        if (!(candidate.input?.Body instanceof Uint8Array)) {
          throw new Error(
            `Expected uploaded Pi S3 object bytes for ${objectKey}`,
          );
        }
        return Buffer.from(candidate.input.Body);
      }
    }
    return undefined;
  }

  function piS3Object(objectKey: string): Buffer {
    const uploaded = uploadedPiS3Object(objectKey);
    if (uploaded) {
      return uploaded;
    }
    const bucketPrefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/`;
    const seeded = objectKey.startsWith(bucketPrefix)
      ? seededSystemSkillArchive(objectKey.slice(bucketPrefix.length))
      : undefined;
    if (seeded) {
      return seeded;
    }
    throw new Error(`Expected Pi S3 object ${objectKey}`);
  }

  function mockPiResourceArchiveDownloads(
    unavailable = false,
    onRead?: () => void,
  ): void {
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
        onRead?.();
        if (unavailable) {
          return HttpResponse.json(
            { error: "archive unavailable" },
            { status: 503 },
          );
        }
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected Pi resource archive object identity");
        }
        return new HttpResponse(piS3Object(objectKey), {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
  }

  async function completeSandboxFirstPiRun(args: {
    readonly actor: ApiTestUser;
    readonly answer: string;
    readonly outputTokens?: number;
    readonly responsesModel?: {
      readonly provider: "openai" | "openai-codex" | "deepseek" | "openrouter";
      readonly model: string;
    };
    readonly historyObjects: Map<string, Buffer>;
    readonly claim: Awaited<ReturnType<typeof claimChatRun>>;
    readonly prompt: string;
    readonly run: { readonly runId: string; readonly threadId: string };
  }): Promise<void> {
    const h0 = piSandboxBaseSession(args.claim.claim, args.historyObjects);
    const session = MemoryPiSession.fromJsonl(h0.toString("utf8"));
    session.appendMessage({
      role: "user",
      content: args.prompt,
      timestamp: 1,
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: args.answer }],
      api: "openai-responses",
      provider: args.responsesModel?.provider ?? "openai",
      model: args.responsesModel?.model ?? "gpt-6-luna",
      usage: {
        input: 0,
        output: args.outputTokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: args.outputTokens ?? 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const h2 = session.toJsonl();
    const h2Hash = createHash("sha256").update(h2).digest("hex");
    await webhooks.requestAgentSessionHistoryPrepare(
      {
        runId: args.run.runId,
        hash: h2Hash,
        rawSize: Buffer.byteLength(h2),
        encodedSize: Buffer.byteLength(h2),
        encoding: "identity",
      },
      args.claim.sandboxHeaders,
      [200],
    );
    args.historyObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
      Buffer.from(h2, "utf8"),
    );
    await webhooks.requestAgentEvents(
      {
        runId: args.run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: { content: [{ type: "text", text: args.answer }] },
          },
          { type: "result", sequenceNumber: 2, result: args.answer },
        ],
      },
      args.claim.sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: args.run.runId,
        exitCode: 0,
        lastEventSequence: 2,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: args.run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
        },
      },
      args.claim.sandboxHeaders,
      [200],
      undefined,
    );
    await waitForRunStatus(args.actor, args.run.runId, "completed");
    await flushWaitUntilForTest();
  }

  return {
    bdd: {
      acceptAgentStorageWrites: bdd.acceptAgentStorageWrites,
      completeOnboarding: bdd.completeOnboarding,
      createAgent: bdd.createAgent,
      readMe: bdd.readMe,
      readOnboardingStatus: bdd.readOnboardingStatus,
      updateAgentMetadata: bdd.updateAgentMetadata,
      user: bdd.user,
    },
    api: {
      acceptStorageDownloads: api.acceptStorageDownloads,
      acceptTelemetryIngest: api.acceptTelemetryIngest,
      claimRunnerJob: api.claimRunnerJob,
      configureRunnerGroup: api.configureRunnerGroup,
      createCliToken: api.createCliToken,
      createPersonalModelProvider: api.createPersonalModelProvider,
      createThreadRun: api.createThreadRun,
      declareSteeredInput: api.declareSteeredInput,
      enableAgentConnectors: api.enableAgentConnectors,
      ensurePersonalSubscriptionModel: api.ensurePersonalSubscriptionModel,
      grantProEntitlement: api.grantProEntitlement,
      heartbeatRunner: api.heartbeatRunner,
      nextSteerableInput: api.nextSteerableInput,
      readBillingStatus: api.readBillingStatus,
      readRun: api.readRun,
      readRunQueue: api.readRunQueue,
      requestCancelRun: api.requestCancelRun,
      requestClaimRunnerJob: api.requestClaimRunnerJob,
      requestClaimRunnerJobAs: api.requestClaimRunnerJobAs,
      requestDeclareSteeredInputAs: api.requestDeclareSteeredInputAs,
      requestNextSteerableInputAs: api.requestNextSteerableInputAs,
      updateUserModelPreference: api.updateUserModelPreference,
    },
    chat,
    webhooks: {
      configureClerkWebhookSecret: webhooks.configureClerkWebhookSecret,
      requestAgentComplete: webhooks.requestAgentComplete,
      requestAgentEvents: webhooks.requestAgentEvents,
      requestAgentRunOutputs: webhooks.requestAgentRunOutputs,
      requestAgentSessionHistoryPrepare:
        webhooks.requestAgentSessionHistoryPrepare,
      requestAgentStorageCommit: webhooks.requestAgentStorageCommit,
      requestAgentStoragePrepare: webhooks.requestAgentStoragePrepare,
      requestAgentUsageEvent: webhooks.requestAgentUsageEvent,
      requestClerkWebhook: webhooks.requestClerkWebhook,
      verifyNextClerkWebhook: webhooks.verifyNextClerkWebhook,
    },
    chatCallbacks,
    connectors,
    misc,
    authDevice,
    authDeviceSupport,
    routeMocks,
    entitledChatActor,
    entitledNativeChatActor,
    configureUserOwnedGptPiModel,
    configureSubscriptionPiModel,
    sendChatRun,
    sendChatRunAfterPick,
    sendWaitingChatInput,
    expectThreadCreatedModelEvent,
    expectNoThreadModelUpdateEvent,
    claimChatRun,
    waitForThreadMessages,
    waitForRunUserMessage,
    waitForRunStatus,
    completeChatRunOk,
    failChatRun,
    cancelChatRun,
    chatEventsClient,
    chatThreadsClient,
    sessionHeaders,
    readThreadProjection,
    requestSendEventRaw,
    requestSendEventWithBearer,
    threadPiAutomationsClient,
    postThreadPiAutomationEvent,
    lastThreadPiAutomationRun,
    expectThreadPiTerminal,
    claimGptPiSandbox,
    mockPiCheckpointObjectStore,
    piSandboxBaseSession,
    uploadedPiS3Object,
    piS3Object,
    mockPiResourceArchiveDownloads,
    completeSandboxFirstPiRun,
  };
}

export function configureNativeCliArtifact(): string {
  const commit = "a".repeat(40);
  const url = `https://static.okou.io/okou-cli/${commit}/package.tgz`;

  mockEnv("GIT_COMMIT_SHA", commit);
  mockEnv("CLI_PKG_URL", url);
  return url;
}
