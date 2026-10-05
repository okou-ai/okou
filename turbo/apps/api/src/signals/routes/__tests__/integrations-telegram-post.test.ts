import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { Buffer } from "node:buffer";
import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";

import {
  OFFICIAL_TELEGRAM_BOT_ID,
  integrationsTelegramContract,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import type {
  TestTelegramStateActionBody,
  TestTelegramStateActionResponse,
} from "@okouai/api-contracts/contracts/test-telegram-state";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  findPendingChatEventByPromptFixture,
  setTelegramThinkingMessageIdFixture,
} from "../../../test-fixtures/chat-events";
import { installTelegramContextFailureFixture } from "../../../test-fixtures/telegram-context-failure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { createFixtureTracker } from "./helpers/route-test";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  captureIntegrationInputUploads,
  expectIntegrationInputPreview,
  listIntegrationInputFileParts,
} from "./helpers/integration-input-assets";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { seedBuiltInDefaultModelKey } from "./helpers/runtime-state";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { testTelegramStateRoutes } from "../test-telegram-state";
import { integrationsTelegramRoutes } from "../integrations-telegram";

const TEST_APP_ROUTES = Object.freeze([...integrationsTelegramRoutes]);

const context = testContext();
const authOrgApi = createAuthOrgAgentsBddApi(context);
const chatApi = createChatFilesBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const runReadsApi = createRunReadsApi(context);

const OFFICIAL_BOT_TOKEN = "987654:official-bot-token";
const OFFICIAL_BOT_USERNAME = "official_okou_bot";
const OFFICIAL_WEBHOOK_SECRET = "official-webhook-secret";
// Telegram user id seeded by `seed-post-fixture` with `seed_official_link`.
const OFFICIAL_LINKED_TELEGRAM_USER_ID = "99002";
const TELEGRAM_STATE_ACTION_ROUTE = "/api/test/telegram-state/action";

interface TelegramPostFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly telegramBotId: string;
  readonly webhookSecret: string;
  readonly telegramUserId?: string;
}

interface TelegramSendMessageBody {
  readonly chat_id: string | number;
  readonly text: string;
  readonly parse_mode?: string;
  readonly message_thread_id?: number;
  readonly reply_parameters?: { readonly message_id: number };
  readonly reply_markup?: {
    readonly inline_keyboard: readonly (readonly {
      readonly text: string;
      readonly url: string;
    }[])[];
  };
}

interface TelegramDeleteMessageBody {
  readonly chat_id: string | number;
  readonly message_id: number;
}

function newTelegramBotId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
}

function configureOfficialBotEnv(): void {
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", OFFICIAL_BOT_USERNAME);
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", OFFICIAL_WEBHOOK_SECRET);
}

function telegramApiMocks(token = OFFICIAL_BOT_TOKEN): {
  readonly chatActions: unknown[];
  readonly sentMessages: TelegramSendMessageBody[];
  readonly sentMessageIds: number[];
  readonly deletedMessages: TelegramDeleteMessageBody[];
} {
  const chatActions: unknown[] = [];
  const sentMessages: TelegramSendMessageBody[] = [];
  const sentMessageIds: number[] = [];
  const deletedMessages: TelegramDeleteMessageBody[] = [];
  let nextMessageId = 700;

  server.use(
    http.post(
      `https://api.telegram.org/bot${token}/sendChatAction`,
      async ({ request }) => {
        chatActions.push(await request.json());
        return HttpResponse.json({ ok: true, result: true });
      },
    ),
    http.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      async ({ request }) => {
        const body = (await request.json()) as TelegramSendMessageBody;
        sentMessages.push(body);
        sentMessageIds.push(nextMessageId);
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: nextMessageId++,
            chat: { id: Number(body.chat_id) || 123 },
            text: body.text,
          },
        });
      },
    ),
    http.post(
      `https://api.telegram.org/bot${token}/deleteMessage`,
      async ({ request }) => {
        deletedMessages.push(
          (await request.json()) as TelegramDeleteMessageBody,
        );
        return HttpResponse.json({ ok: true, result: true });
      },
    ),
  );

  return { chatActions, sentMessages, sentMessageIds, deletedMessages };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

// The surface delivery rules render between the integration block and the
// thread context. `privateArtifacts` is off for this fixture, so the note is
// its single base line.
const TELEGRAM_INTEGRATION_NOTE = [
  "# Integration Note",
  "",
  "- Telegram messaging and files: use `okou telegram --help`. Only your final reply is delivered to the originating chat, and nothing you produce while the run is in progress reaches Telegram on its own, so Telegram commands are for different chats, topics, reply targets, or explicit extra messages. Use `okou telegram message send -h` for extra messages, `okou telegram download-file -h` for `[Telegram file]` blocks, and `okou telegram upload-file -h` when file delivery is needed. All Telegram commands use the official Okou bot.",
].join("\n");

function expectExactSystemPromptFragment(
  appendSystemPrompt: string | null | undefined,
  expectedFragment: string,
  expectedThreadContext?: string,
): void {
  if (!appendSystemPrompt) {
    throw new Error("Expected Telegram append system prompt");
  }
  const fragment =
    expectedThreadContext === undefined
      ? expectedFragment
      : [
          expectedFragment,
          TELEGRAM_INTEGRATION_NOTE,
          expectedThreadContext,
        ].join("\n\n");
  expect(appendSystemPrompt.split(fragment)).toHaveLength(2);
}

/**
 * The launch's thread context renders once, immediately after the exact
 * integration block and delivery note. Returns that rendered tail.
 */
function renderedThreadContextAfter(
  appendSystemPrompt: string | null | undefined,
  expectedFragment: string,
): string {
  if (!appendSystemPrompt) {
    throw new Error("Expected Telegram append system prompt");
  }
  const parts = appendSystemPrompt.split(
    [expectedFragment, TELEGRAM_INTEGRATION_NOTE, ""].join("\n\n"),
  );
  expect(parts).toHaveLength(2);
  return parts[1] ?? "";
}

async function postTelegramStateAction(
  body: TestTelegramStateActionBody,
): Promise<TestTelegramStateActionResponse> {
  const response = await createApp({
    signal: context.signal,
    routes: testTelegramStateRoutes,
  }).request(TELEGRAM_STATE_ACTION_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await expectOk(response, `telegram state action ${body.action}`);
  return await readJson<TestTelegramStateActionResponse>(response);
}

async function seedTelegramPostFixture(
  args: {
    readonly orgId?: string;
    readonly userId?: string;
    readonly seedOfficialLink?: boolean;
    readonly seedDefaultAgent?: boolean;
  } = {},
): Promise<TelegramPostFixture> {
  configureOfficialBotEnv();
  const response = await postTelegramStateAction({
    action: "seed-post-fixture",
    org_id: args.orgId,
    user_id: args.userId,
    seed_official_link: args.seedOfficialLink,
    seed_default_agent: args.seedDefaultAgent,
  });
  const fixture =
    typeof response.fixture === "object" && response.fixture !== null
      ? (response.fixture as Record<string, unknown>)
      : null;
  if (!fixture) {
    throw new Error("seedTelegramPostFixture: response missing fixture");
  }
  const seeded = {
    orgId: String(fixture.org_id),
    userId: String(fixture.user_id),
    composeId: String(fixture.compose_id),
    telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
    webhookSecret: OFFICIAL_WEBHOOK_SECRET,
    telegramUserId: args.seedOfficialLink
      ? OFFICIAL_LINKED_TELEGRAM_USER_ID
      : undefined,
  };
  await authOrgApi.completeOnboarding(actorForFixture(seeded));

  return seeded;
}

async function deleteTelegramPostFixture(
  fixture: TelegramPostFixture,
): Promise<void> {
  await postTelegramStateAction({
    action: "delete-post-fixture",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    compose_id: fixture.composeId,
  });
}

const trackFixture = createFixtureTracker<TelegramPostFixture>(
  deleteTelegramPostFixture,
);

function actorForFixture(fixture: TelegramPostFixture): ApiTestUser {
  return {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: `${fixture.userId}@example.test`,
  };
}

/** Links a unique Telegram user to the actor through the signed link API. */
async function linkOfficialTelegramUser(actor: ApiTestUser): Promise<string> {
  const telegramAuth = {
    id: Number(newTelegramBotId()),
    auth_date: Math.floor(nowDate().getTime() / 1000),
    first_name: "Alice",
  };
  const authData = Object.entries(telegramAuth)
    .sort(([left], [right]) => {
      return left.localeCompare(right);
    })
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");
  const secretKey = createHash("sha256").update(OFFICIAL_BOT_TOKEN).digest();
  await accept(
    telegramClient().link({
      headers: authOrgApi.authenticate(actor),
      body: {
        telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
        telegramAuth: {
          ...telegramAuth,
          hash: createHmac("sha256", secretKey).update(authData).digest("hex"),
        },
      },
    }),
    [200],
  );
  return String(telegramAuth.id);
}

/**
 * Builds a Telegram poster through production APIs: onboarding creates the
 * org, member and default agent; an optional signed official-bot link binds a
 * unique Telegram user to that member.
 */
async function createTelegramPostFixture(
  options: { readonly linkOfficial?: boolean } = {},
): Promise<TelegramPostFixture> {
  configureOfficialBotEnv();
  const actor = authOrgApi.user();
  if (!actor.orgId) {
    throw new Error("Expected an organization for the Telegram poster");
  }
  await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Telegram post agent",
  });
  const { defaultAgentId } = await authOrgApi.readOnboardingStatus(actor);
  if (!defaultAgentId) {
    throw new Error("Expected onboarding to create a default agent");
  }
  return {
    orgId: actor.orgId,
    userId: actor.userId,
    composeId: defaultAgentId,
    telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
    webhookSecret: OFFICIAL_WEBHOOK_SECRET,
    ...(options.linkOfficial === true
      ? { telegramUserId: await linkOfficialTelegramUser(actor) }
      : {}),
  };
}

/** Native Telegram callback coverage uses the poster's personal Claude subscription. */
async function useNativeFableSubscription(
  fixture: TelegramPostFixture,
): Promise<void> {
  const actor = actorForFixture(fixture);
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
}

/** The poster's newest run whose launch prompt contains `text`. */
async function runForPrompt(fixture: TelegramPostFixture, text: string) {
  return (
    await runsApi.listAgentRuns(actorForFixture(fixture), { limit: 20 })
  ).runs.find((run) => {
    return run.prompt?.includes(text) === true;
  });
}

/** The number of runs the poster can list. */
async function runCountFor(fixture: TelegramPostFixture): Promise<number> {
  return (await runsApi.listAgentRuns(actorForFixture(fixture), { limit: 100 }))
    .runs.length;
}

/** The poster's single chat thread whose public events satisfy `matches`. */
async function threadIdWhere(
  fixture: TelegramPostFixture,
  matches: (event: ChatEvent) => boolean,
): Promise<string> {
  const actor = actorForFixture(fixture);
  const lifecycle = await chatApi.requestThreadEvents(actor, {}, [200]);
  if (lifecycle.status !== 200) {
    throw new Error("Expected Telegram thread lifecycle events");
  }
  const matched: string[] = [];
  for (const event of lifecycle.body.events) {
    if (event.kind !== "created") {
      continue;
    }
    const { events } = await chatApi.listThreadEvents(
      actor,
      event.chatThreadId,
    );
    if (events.some(matches)) {
      matched.push(event.chatThreadId);
    }
  }
  expect(matched).toHaveLength(1);
  const [threadId] = matched;
  if (!threadId) {
    throw new Error("Expected exactly one matching Telegram chat thread");
  }
  return threadId;
}

/**
 * Posts a group reply to a bot message and returns the chat thread that
 * admitted it, as the public thread events show.
 */
async function replyToBotMessageThread(
  fixture: TelegramPostFixture,
  args: {
    readonly chatId: number;
    readonly messageThreadId: number;
    readonly messageId: number;
    readonly botMessageId: number;
    readonly text: string;
  },
): Promise<string> {
  expect(
    (
      await postWebhook({
        telegramBotId: fixture.telegramBotId,
        secret: fixture.webhookSecret,
        body: {
          update_id: args.messageId,
          message: {
            message_id: args.messageId,
            message_thread_id: args.messageThreadId,
            chat: { id: args.chatId, type: "supergroup" },
            from: {
              id: Number(fixture.telegramUserId),
              username: "alice",
              first_name: "Alice",
            },
            text: args.text,
            reply_to_message: {
              message_id: args.botMessageId,
              chat: { id: args.chatId, type: "supergroup" },
              from: {
                id: 987_654,
                is_bot: true,
                username: "provider_renamed_bot",
              },
              text: "Task completed successfully.",
            },
          },
        },
      })
    ).status,
  ).toBe(200);
  await flushWaitUntilForTest();
  return await threadIdWhere(fixture, (event) => {
    return (
      event.eventType === "input.prompt" &&
      event.userMessage.parts.some((part) => {
        return part.type === "text" && part.text.includes(args.text);
      })
    );
  });
}

/** The poster's chat thread that holds the input which launched the run. */
async function threadIdForRun(
  fixture: TelegramPostFixture,
  runId: string,
): Promise<string> {
  return await threadIdWhere(fixture, (event) => {
    return event.eventType === "input.prompt" && event.runId === runId;
  });
}

beforeEach(() => {
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
});

afterEach(() => {
  clearMockedEnv();
});

function telegramClient() {
  return setupApp({ context, routes: integrationsTelegramRoutes })(
    integrationsTelegramContract,
  );
}

async function postWebhook(args: {
  readonly telegramBotId: string;
  readonly secret: string;
  readonly body: unknown;
  readonly apiOrigin?: string;
}): Promise<Response> {
  return await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(
    `${args.apiOrigin?.replace(/\/$/u, "") ?? ""}/api/telegram/webhook/${args.telegramBotId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": args.secret,
      },
      body:
        typeof args.body === "string" ? args.body : JSON.stringify(args.body),
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredStringField(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string`);
  }
  return value;
}

function nullableStringField(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function stateRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stateRecords(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

interface TelegramRunSnapshot {
  readonly id: string;
  readonly status: string | null;
  readonly error: string | null;
  readonly prompt: string | null;
  readonly appendSystemPrompt: string | null;
  readonly continuedFromSessionId: string | null;
  readonly sessionId: string | null;
}

interface TelegramAgentRunSnapshot {
  readonly id: string;
  readonly triggerSource: string | null;
  readonly chatThreadId: string | null;
  readonly modelProvider: string | null;
  readonly selectedModel: string | null;
}

interface TelegramCallbackSnapshot {
  readonly id: string;
  readonly url: string | null;
  readonly internalKind: string | null;
  readonly payload: unknown;
  readonly status: string | null;
}

interface TelegramPostRunState {
  readonly run: TelegramRunSnapshot | null;
  readonly agentRun: TelegramAgentRunSnapshot | null;
  readonly callbacks: readonly TelegramCallbackSnapshot[];
  readonly jobExists: boolean;
}

function runSnapshot(value: unknown): TelegramRunSnapshot | null {
  const record = stateRecord(value);
  if (!record) {
    return null;
  }
  return {
    id: requiredStringField(record, "id"),
    status: nullableStringField(record, "status"),
    error: nullableStringField(record, "error"),
    prompt: nullableStringField(record, "prompt"),
    appendSystemPrompt: nullableStringField(record, "appendSystemPrompt"),
    continuedFromSessionId: nullableStringField(
      record,
      "continuedFromSessionId",
    ),
    sessionId: nullableStringField(record, "sessionId"),
  };
}

function agentRunSnapshot(value: unknown): TelegramAgentRunSnapshot | null {
  const record = stateRecord(value);
  if (!record) {
    return null;
  }
  return {
    id: requiredStringField(record, "id"),
    triggerSource: nullableStringField(record, "triggerSource"),
    chatThreadId: nullableStringField(record, "chatThreadId"),
    modelProvider: nullableStringField(record, "modelProvider"),
    selectedModel: nullableStringField(record, "selectedModel"),
  };
}

function callbackSnapshot(value: unknown): TelegramCallbackSnapshot {
  const record = stateRecord(value);
  if (!record) {
    throw new Error("Expected callback state to be an object");
  }
  return {
    id: requiredStringField(record, "id"),
    url: nullableStringField(record, "url"),
    internalKind: nullableStringField(record, "internalKind"),
    payload: record.payload,
    status: nullableStringField(record, "status"),
  };
}

async function telegramPostRunState(
  fixture: TelegramPostFixture,
  prompt?: string,
): Promise<TelegramPostRunState> {
  const response = await postTelegramStateAction({
    action: "get-post-run-state",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    prompt,
  });

  return {
    run: runSnapshot(response.run),
    agentRun: agentRunSnapshot(response.agent_run),
    callbacks: stateRecords(response.callbacks).map(callbackSnapshot),
    jobExists: response.job_exists === true,
  };
}

function configureCanonicalTelegramRunner(): string {
  const runnerGroup = runsApi.configureRunnerGroup();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  authOrgApi.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  return runnerGroup;
}

async function claimTelegramRun(runId: string, runnerGroup: string) {
  await runsApi.heartbeatRunner(runnerGroup);
  return await runsApi.claimRunnerJob(runId);
}

async function completeCanonicalChatRun(args: {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly cliAgentType?: "claude-code" | "codex";
}): Promise<string> {
  const cliAgentSessionId = `bdd-telegram-cli-${args.runId}`;
  const cliAgentSessionHistory = `bdd telegram history ${args.runId}`;
  const cliAgentSessionHistoryHash = createHash("sha256")
    .update(cliAgentSessionHistory)
    .digest("hex");
  const cliAgentSessionHistorySize = Buffer.byteLength(
    cliAgentSessionHistory,
    "utf8",
  );
  const headers = { authorization: `Bearer ${args.sandboxToken}` };
  await webhooksApi.requestAgentCheckpointPrepareHistory(
    {
      runId: args.runId,
      hash: cliAgentSessionHistoryHash,
      rawSize: cliAgentSessionHistorySize,
      encodedSize: cliAgentSessionHistorySize,
      encoding: "identity",
    },
    headers,
    [200],
  );
  await webhooksApi.requestAgentComplete(
    {
      runId: args.runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: args.cliAgentType ?? "claude-code",
        cliAgentSessionId,
        cliAgentSessionHistoryHash,
      },
    },
    headers,
    [200],
  );
  await flushWaitUntilForTest();
  return cliAgentSessionId;
}

async function readTelegramSourcePart(
  fixture: TelegramPostFixture,
  prompt: string,
) {
  const actor = actorForFixture(fixture);
  const lifecycle = await chatApi.requestThreadEvents(actor, {}, [200]);
  if (lifecycle.status !== 200) {
    throw new Error("Expected Telegram thread lifecycle events");
  }
  const thread = lifecycle.body.events.find((event) => {
    return event.kind === "created" && event.agentId === fixture.composeId;
  });
  if (!thread) {
    throw new Error("Expected a Telegram chat thread");
  }
  const { events } = await chatApi.listThreadEvents(actor, thread.chatThreadId);
  const input = events.find((event) => {
    return (
      event.eventType === "input.prompt" &&
      event.userMessage.parts.some((part) => {
        return part.type === "text" && part.text === prompt;
      })
    );
  });
  return input?.eventType === "input.prompt"
    ? input.userMessage.parts.find((part) => {
        return part.type === "source";
      })
    : undefined;
}

function mentionEntity(username: string) {
  return { type: "mention", offset: 0, length: username.length + 1 };
}

async function connectNativeFableSubscription(
  fixture: TelegramPostFixture,
): Promise<void> {
  await useNativeFableSubscription(fixture);
}

function userModelPreferenceClient() {
  return setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
}

/** The member's default model from the public preference endpoint. */
async function memberDefaultModelOf(
  actor: ApiTestUser,
): Promise<string | null> {
  const response = await accept(
    userModelPreferenceClient().get({
      headers: authOrgApi.authenticate(actor),
    }),
    [200],
  );
  return response.body.selectedModel;
}

async function memberDefaultModel(
  fixture: TelegramPostFixture,
): Promise<string | null> {
  return await memberDefaultModelOf(actorForFixture(fixture));
}

describe("POST /api/telegram/webhook/:telegramBotId", () => {
  it("validates bot ownership, webhook secret, and JSON payload", async () => {
    const fixture = await createTelegramPostFixture();

    const missing = await postWebhook({
      telegramBotId: newTelegramBotId(),
      secret: fixture.webhookSecret,
      body: {},
    });
    expect(missing.status).toBe(404);
    await expect(missing.text()).resolves.toBe("Not Found");

    const unauthorized = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: "wrong-secret",
      body: {},
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.text()).resolves.toBe("Unauthorized");

    const badJson = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: "{not-json",
    });
    expect(badJson.status).toBe(400);
    await expect(badJson.text()).resolves.toBe("Bad Request");
  });

  it("snapshots thread reuse inputs before a CLI session exists", async () => {
    const runnerGroup = configureCanonicalTelegramRunner();
    const fixture = await createTelegramPostFixture({ linkOfficial: true });
    await useNativeFableSubscription(fixture);
    telegramApiMocks();
    const prompt = "reuse this Telegram thread";
    expect(
      (
        await postWebhook({
          telegramBotId: fixture.telegramBotId,
          secret: fixture.webhookSecret,
          body: {
            update_id: 211,
            message: {
              message_id: 2211,
              chat: { id: 77_011, type: "private" },
              from: {
                id: Number(fixture.telegramUserId),
                username: "alice",
                first_name: "Alice",
              },
              text: prompt,
            },
          },
        })
      ).status,
    ).toBe(200);
    await flushWaitUntilForTest();

    const runId = (await runForPrompt(fixture, prompt))?.id;
    if (!runId) {
      throw new Error("Expected a thread-bound Telegram run");
    }
    const threadId = await threadIdForRun(fixture, runId);
    const reuseKey = `thread:${threadId}`;
    const runnerId = randomUUID();
    await runsApi.requestHeartbeatRunner(true, [200], {
      runnerId,
      group: runnerGroup,
      admittableProfiles: [],
      heldSandboxStates: [
        {
          reuseKey,
          lastCompletedAt: nowDate().toISOString(),
          reusableSandbox: { profile: "vm0/default" },
        },
      ],
    });

    const poll = await runsApi.requestPollRunner(
      true,
      {
        runnerId,
        group: runnerGroup,
        supportedProfiles: ["vm0/default"],
      },
      [200],
    );
    if (poll.status !== 200) {
      throw new Error("Expected the same-thread reuse poll to succeed");
    }
    expect(poll.body.job).toMatchObject({
      runId,
      cliAgentSessionId: null,
      reuseKey,
      runnerPreference: {
        kind: "preference",
        runnerIdentity: {
          runnerId,
          heartbeatGeneration: 1,
        },
        tier: "reusableSandbox",
        expiresAt: expect.any(String),
      },
    });

    const claim = await runsApi.claimRunnerJob(runId);
    expect(claim.reuseKey).toBe(reuseKey);
    await runsApi.requestCancelRun(actorForFixture(fixture), runId, [200]);
  });

  it("rebuilds queued Telegram launch material from context", async () => {
    const runnerGroup = configureCanonicalTelegramRunner();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ seedOfficialLink: true }),
    );

    await connectNativeFableSubscription(fixture);
    const telegramMocks = telegramApiMocks();
    const chatId = 77_002;
    const firstPrompt = "hold the Telegram queue";
    expect(
      (
        await postWebhook({
          telegramBotId: fixture.telegramBotId,
          secret: fixture.webhookSecret,
          body: {
            update_id: 201,
            message: {
              message_id: 2201,
              chat: { id: chatId, type: "private" },
              from: {
                id: Number(fixture.telegramUserId),
                username: "alice",
                first_name: "Alice",
              },
              text: firstPrompt,
            },
          },
        })
      ).status,
    ).toBe(200);
    await flushWaitUntilForTest();
    const firstState = await telegramPostRunState(fixture, firstPrompt);
    const firstRunId = firstState.run?.id;
    if (!firstRunId) {
      throw new Error("Expected the first Telegram run");
    }
    const firstClaim = await claimTelegramRun(firstRunId, runnerGroup);

    const queuedPrompt = "claim Telegram queue transport params";
    expect(
      (
        await postWebhook({
          telegramBotId: fixture.telegramBotId,
          secret: fixture.webhookSecret,
          body: {
            update_id: 202,
            message: {
              message_id: 2202,
              chat: { id: chatId, type: "private" },
              from: {
                id: Number(fixture.telegramUserId),
                username: "alice",
                first_name: "Alice",
              },
              text: queuedPrompt,
            },
          },
        })
      ).status,
    ).toBe(200);
    await flushWaitUntilForTest();
    const queuedParams = await findPendingChatEventByPromptFixture({
      userId: fixture.userId,
      prompt: queuedPrompt,
    });
    expect(queuedParams).toMatchObject({
      eventId: expect.any(String),
    });
    if (!queuedParams) {
      throw new Error("Expected queued Telegram event");
    }
    await setTelegramThinkingMessageIdFixture(queuedParams.eventId, "701");
    await completeCanonicalChatRun({
      runId: firstRunId,
      sandboxToken: firstClaim.sandboxToken,
    });
    let queuedRunId: string | null = null;
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        queuedRunId =
          (await telegramPostRunState(fixture, queuedPrompt)).run?.id ?? null;
        return queuedRunId;
      })(),
    ).resolves.toStrictEqual(expect.any(String));
    if (!queuedRunId) {
      throw new Error("Expected the queued Telegram run");
    }
    const queuedClaim = await claimTelegramRun(queuedRunId, runnerGroup);
    expect(queuedClaim.prompt).toBe(queuedPrompt);
    // The queued launch keeps the conversation it was admitted with.
    expect(
      renderedThreadContextAfter(
        queuedClaim.appendSystemPrompt,
        [
          "# Current Integration",
          "You are currently running inside: Telegram",
          "Bot ID: 987654",
          `Bot username: @${OFFICIAL_BOT_USERNAME}`,
          `Chat ID: ${chatId}`,
          "Chat type: private",
          "Message ID: 2202",
          "Root message ID: direct-message:main",
        ].join("\n"),
      ),
    ).toContain(firstPrompt);
    await completeCanonicalChatRun({
      runId: queuedRunId,
      sandboxToken: queuedClaim.sandboxToken,
    });
    expect(telegramMocks.deletedMessages).toContainEqual({
      chat_id: String(chatId),
      message_id: 701,
    });
  });

  async function prepareTelegramDm() {
    const runnerGroup = configureCanonicalTelegramRunner();
    configureOfficialBotEnv();
    const actor = authOrgApi.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization for Telegram onboarding");
    }
    await runsApi.grantProEntitlement(actor);
    await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Telegram DM agent",
    });
    await createBddIntegrationApi(context).configureNativeSubscriptionModels(
      actor,
    );
    const telegram = telegramApiMocks(OFFICIAL_BOT_TOKEN);
    const botId = "official";
    const secret = OFFICIAL_WEBHOOK_SECRET;
    const headers = authOrgApi.authenticate(actor);
    const fromId = Number(newTelegramBotId());
    const telegramAuth = {
      id: fromId,
      auth_date: Math.floor(nowDate().getTime() / 1000),
      first_name: "Alice",
    };
    const authData = Object.entries(telegramAuth)
      .sort(([left], [right]) => {
        return left.localeCompare(right);
      })
      .map(([key, value]) => {
        return `${key}=${value}`;
      })
      .join("\n");
    const secretKey = createHash("sha256").update(OFFICIAL_BOT_TOKEN).digest();
    await accept(
      telegramClient().link({
        headers,
        body: {
          telegramBotId: botId,
          telegramAuth: {
            ...telegramAuth,
            hash: createHmac("sha256", secretKey)
              .update(authData)
              .digest("hex"),
          },
        },
      }),
      [200],
    );
    const chatId = 78_501;

    async function sendDm(text: string, messageId: number, replyTo?: number) {
      const response = await postWebhook({
        telegramBotId: botId,
        secret,
        body: {
          update_id: messageId,
          message: {
            message_id: messageId,
            chat: { id: chatId, type: "private" },
            from: { id: fromId, first_name: "Alice" },
            text,
            ...(replyTo === undefined
              ? {}
              : {
                  reply_to_message: {
                    message_id: replyTo,
                    text: "Earlier DM message",
                  },
                }),
          },
        },
      });
      expect(response.status).toBe(200);
      await flushWaitUntilForTest();
    }

    async function completeDm(
      text: string,
      messageId: number,
      replyTo?: number,
      assistantText?: string,
    ) {
      await sendDm(text, messageId, replyTo);
      const response = await runReadsApi.requestListLogs(
        actor,
        { limit: 20 },
        [200],
      );
      expect(response.body.pagination).toMatchObject({ hasMore: false });
      const run = response.body.data
        .filter((item) => {
          return item.status === "pending" || item.status === "running";
        })
        .find((item) => {
          return item.prompt?.includes(text);
        });
      if (!run) {
        throw new Error("Expected a Telegram DM run");
      }
      const claim = await claimTelegramRun(run.id, runnerGroup);
      if (
        claim.cliAgentType !== "claude-code" &&
        claim.cliAgentType !== "codex"
      ) {
        throw new Error(
          `Expected a native Telegram DM claim, got ${claim.cliAgentType}`,
        );
      }
      const replyCount = telegram.sentMessageIds.length;
      if (assistantText !== undefined) {
        await webhooksApi.requestAgentEvents(
          {
            runId: run.id,
            events: [
              {
                type: "assistant",
                sequenceNumber: 0,
                message: {
                  id: `msg_telegram_dm_${run.id}`,
                  content: [{ type: "text", text: assistantText }],
                },
              },
            ],
          },
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
      }
      const sessionId = await completeCanonicalChatRun({
        runId: run.id,
        sandboxToken: claim.sandboxToken,
        cliAgentType: claim.cliAgentType,
      });
      expect(telegram.sentMessages.at(-1)?.reply_parameters).toStrictEqual({
        message_id: messageId,
      });
      const botReplyId = telegram.sentMessageIds.at(-1);
      if (botReplyId === undefined) {
        throw new Error("Expected a Telegram DM reply");
      }
      const lifecycle = await chatApi.requestThreadEvents(actor, {}, [200]);
      if (lifecycle.status !== 200) {
        throw new Error("Expected the Telegram thread event stream");
      }
      const threads = replayChatThreadEvents([], lifecycle.body.events);
      let chatThread: (typeof threads)[number] | undefined;
      for (const thread of threads) {
        const { events } = await chatApi.listThreadEvents(actor, thread.id);
        if (
          events.some((event) => {
            return event.eventType === "input.prompt" && event.runId === run.id;
          })
        ) {
          chatThread = thread;
          break;
        }
      }
      if (!chatThread) {
        throw new Error("Expected the Telegram input in its canonical thread");
      }
      return {
        claim,
        sessionId,
        botReplyId,
        chatThread,
        replyCount: telegram.sentMessageIds.length - replyCount,
      };
    }
    const main = await completeDm("start the main DM", 3501);
    return { actor, sendDm, completeDm, main };
  }

  describe.each([
    { ownerKind: "official", scenario: "models" },
    { ownerKind: "official", scenario: "reply-anchors" },
    { ownerKind: "official", scenario: "pinned-replies" },
  ] as const)("$ownerKind Telegram DM $scenario", ({ ownerKind, scenario }) => {
    let dm: Awaited<ReturnType<typeof prepareTelegramDm>>;
    let replyChain:
      | {
          branch: Awaited<ReturnType<typeof dm.completeDm>>;
          followUp: Awaited<ReturnType<typeof dm.completeDm>>;
        }
      | undefined;

    async function prepareReplyChain() {
      replyChain = undefined;
      if (scenario !== "models") {
        const branch = await dm.completeDm(
          "start a reply chain",
          3503,
          3501,
          "Long DM answer. ".repeat(350),
        );
        expect(branch.claim.resumeSession).toBeNull();
        expect(branch.replyCount).toBeGreaterThan(1);
        const branchFollowUp = await dm.completeDm(
          "continue the reply chain",
          3504,
          branch.botReplyId,
        );
        expect(branchFollowUp.claim.resumeSession?.sessionId).toBe(
          branch.sessionId,
        );
        replyChain = { branch, followUp: branchFollowUp };
      }
    }

    beforeEach(async () => {
      dm = await prepareTelegramDm();
      await prepareReplyChain();
    });

    it(`routes ${ownerKind} Telegram DM ${scenario}`, async () => {
      const { sendDm, completeDm, main } = dm;
      expect(main.claim.resumeSession).toBeNull();
      if (scenario !== "models") {
        if (!replyChain) {
          throw new Error("Expected a completed Telegram reply chain");
        }
        const { branch, followUp: branchFollowUp } = replyChain;
        if (scenario === "reply-anchors") {
          const earlierReply = await completeDm(
            "reply to the earlier user message",
            3505,
            3503,
          );
          expect(earlierReply.claim.resumeSession?.sessionId).toBe(
            branchFollowUp.sessionId,
          );
          return;
        }
        await sendDm("/model gpt-6-astra", 3506);
        const pinnedReply = await completeDm(
          "keep the reply chain model",
          3508,
          branch.botReplyId,
        );
        // `/model` in the main DM switches only the main DM thread.
        expect(pinnedReply.claim.modelUsageProvider).toBe("claude-fable-5-1");
        expect(pinnedReply.chatThread.id).toBe(branch.chatThread.id);
        expect(pinnedReply.chatThread.selectedModel).toBe("claude-fable-5-1");
        expect(pinnedReply.claim.resumeSession?.sessionId).toBe(
          branchFollowUp.sessionId,
        );
        return;
      }

      const followUp = await completeDm("continue the main DM", 3502);
      expect(followUp.claim.resumeSession?.sessionId).toBe(main.sessionId);
      expect(followUp.chatThread.id).toBe(main.chatThread.id);
      expect(followUp.chatThread.selectedModel).toBe("claude-fable-5-1");

      await sendDm("/model gpt-6-astra", 3506);
      // `/model` leaves the member preference the fixture configured.
      await expect(memberDefaultModelOf(dm.actor)).resolves.toBe(
        "claude-fable-5-1",
      );
      const alternate = await completeDm("switch the main DM model", 3507);
      expect(alternate.claim.cliAgentType).toBe("codex");
      expect(alternate.chatThread.id).toBe(main.chatThread.id);
      expect(alternate.chatThread.selectedModel).toBe("gpt-6-astra");
      await sendDm("/model claude-fable-5-1", 3509);
      const returned = await completeDm("return to the main model", 3510);
      expect(returned.claim.modelUsageProvider).toBe("claude-fable-5-1");
      expect(returned.chatThread.id).toBe(main.chatThread.id);
      expect(returned.chatThread.selectedModel).toBe("claude-fable-5-1");
    });
  });

  it("forwards unrecognized Telegram DM slash inputs to the agent", async () => {
    const dm = await prepareTelegramDm();
    const forwarded = await dm.completeDm("/unrecognized_command", 3511);
    expect(forwarded.chatThread.id).toBe(dm.main.chatThread.id);
  });

  async function runCanonicalTelegramForumScenario(
    phase: "callback" | "reply-chain" | "fresh-chain",
  ) {
    const runnerGroup = configureCanonicalTelegramRunner();
    const fixture = await createTelegramPostFixture({ linkOfficial: true });
    await useNativeFableSubscription(fixture);
    const telegramMocks = telegramApiMocks();
    const botUsername = OFFICIAL_BOT_USERNAME;
    const chatId = -77_201;
    const messageThreadId = 9201;
    const firstPrompt = `@${botUsername} start canonical chain`;

    expect(
      (
        await postWebhook({
          telegramBotId: fixture.telegramBotId,
          secret: fixture.webhookSecret,
          apiOrigin: "https://api.okou.ai",
          body: {
            update_id: 201,
            message: {
              message_id: 2201,
              message_thread_id: messageThreadId,
              chat: { id: chatId, type: "supergroup" },
              from: {
                id: Number(fixture.telegramUserId),
                username: "alice",
                first_name: "Alice",
              },
              text: firstPrompt,
              entities: [mentionEntity(botUsername)],
            },
          },
        })
      ).status,
    ).toBe(200);
    await flushWaitUntilForTest();

    const firstRun = await runForPrompt(fixture, firstPrompt);
    if (!firstRun) {
      throw new Error("Expected the first Telegram forum run");
    }
    const firstThreadId = await threadIdForRun(fixture, firstRun.id);
    expect(firstRun.prompt).toBe(firstPrompt);
    expectExactSystemPromptFragment(
      firstRun.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Telegram",
        "Bot ID: 987654",
        `Bot username: @${botUsername}`,
        `Chat ID: ${chatId}`,
        "Chat type: supergroup",
        "Message ID: 2201",
        `Message thread ID: ${messageThreadId}`,
      ].join("\n"),
    );
    const firstClaim = await claimTelegramRun(firstRun.id, runnerGroup);
    const cliAgentSessionId = await completeCanonicalChatRun({
      runId: firstRun.id,
      sandboxToken: firstClaim.sandboxToken,
    });

    expect(telegramMocks.sentMessages).toHaveLength(1);
    expect(telegramMocks.sentMessages[0]).toMatchObject({
      chat_id: String(chatId),
      message_thread_id: messageThreadId,
      reply_parameters: { message_id: 2201 },
    });
    await webhooksApi.requestAgentComplete(
      {
        runId: firstRun.id,
        exitCode: 1,
        error: "late duplicate completion",
      },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(1);
    if (phase === "callback") {
      return;
    }

    const followUpPrompt = "continue canonical chain";
    const followUpPayload = {
      update_id: 202,
      message: {
        message_id: 2202,
        message_thread_id: messageThreadId,
        chat: { id: chatId, type: "supergroup" },
        from: {
          id: Number(fixture.telegramUserId),
          username: "alice",
          first_name: "Alice",
        },
        text: followUpPrompt,
        reply_to_message: {
          message_id: 700,
          chat: { id: chatId, type: "supergroup" },
          from: {
            id: 987_654,
            is_bot: true,
            username: "provider_renamed_bot",
          },
          text: "Task completed successfully.",
        },
      },
    };
    expect(
      (
        await postWebhook({
          telegramBotId: fixture.telegramBotId,
          secret: fixture.webhookSecret,
          body: followUpPayload,
        })
      ).status,
    ).toBe(200);
    await flushWaitUntilForTest();

    const followUpAgentPrompt = [
      "[Replying to @provider_renamed_bot]",
      "> Task completed successfully.",
      "",
      followUpPrompt,
    ].join("\n");

    const followUpRun = await runForPrompt(fixture, followUpAgentPrompt);
    if (!followUpRun) {
      throw new Error("Expected the Telegram forum follow-up run");
    }
    expect(followUpRun.prompt).toBe(followUpAgentPrompt);
    const followUpThreadContext = renderedThreadContextAfter(
      followUpRun.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Telegram",
        "Bot ID: 987654",
        `Bot username: @${botUsername}`,
        `Chat ID: ${chatId}`,
        "Chat type: supergroup",
        "Message ID: 2202",
        "Root message ID: 700",
        `Message thread ID: ${messageThreadId}`,
      ].join("\n"),
    );
    // The follow-up launches with the chain it continues.
    expect(followUpThreadContext).toContain(firstPrompt);
    // The reply to the bot's answer (root 700) continues the first thread.
    await expect(threadIdForRun(fixture, followUpRun.id)).resolves.toBe(
      firstThreadId,
    );
    const followUpClaim = await claimTelegramRun(followUpRun.id, runnerGroup);
    expect(followUpClaim.resumeSession?.sessionId).toBe(cliAgentSessionId);
    await completeCanonicalChatRun({
      runId: followUpRun.id,
      sandboxToken: followUpClaim.sandboxToken,
    });
    expect(telegramMocks.sentMessages).toHaveLength(2);
    const runsBeforeDuplicate = await runCountFor(fixture);

    expect(
      (
        await postWebhook({
          telegramBotId: fixture.telegramBotId,
          secret: fixture.webhookSecret,
          body: followUpPayload,
        })
      ).status,
    ).toBe(200);
    await flushWaitUntilForTest();
    // The duplicate update launches nothing new and sends no extra reply.
    await expect(runCountFor(fixture)).resolves.toBe(runsBeforeDuplicate);
    expect(telegramMocks.sentMessages).toHaveLength(2);
    if (phase === "reply-chain") {
      // The chain moved to the bot's latest answer (701): replying to it
      // continues the first thread, while the retired root 700 no longer
      // routes there and starts a separate thread.
      await expect(
        replyToBotMessageThread(fixture, {
          chatId,
          messageThreadId,
          messageId: 2204,
          botMessageId: 701,
          text: "reply to the latest canonical answer",
        }),
      ).resolves.toBe(firstThreadId);
      await expect(
        replyToBotMessageThread(fixture, {
          chatId,
          messageThreadId,
          messageId: 2205,
          botMessageId: 700,
          text: "reply to the retired canonical answer",
        }),
      ).resolves.not.toBe(firstThreadId);
      return;
    }

    const freshPrompt = `@${botUsername} start another chain`;
    expect(
      (
        await postWebhook({
          telegramBotId: fixture.telegramBotId,
          secret: fixture.webhookSecret,
          body: {
            update_id: 203,
            message: {
              message_id: 2203,
              message_thread_id: messageThreadId,
              chat: { id: chatId, type: "supergroup" },
              from: {
                id: Number(fixture.telegramUserId),
                username: "alice",
                first_name: "Alice",
              },
              text: freshPrompt,
              entities: [mentionEntity(botUsername)],
            },
          },
        })
      ).status,
    ).toBe(200);
    await flushWaitUntilForTest();

    const freshRun = await runForPrompt(fixture, freshPrompt);
    if (!freshRun) {
      throw new Error("Expected the fresh Telegram chain run");
    }
    await expect(threadIdForRun(fixture, freshRun.id)).resolves.not.toBe(
      firstThreadId,
    );
    // The fresh chain does not take over the first chain's latest root.
    await expect(
      replyToBotMessageThread(fixture, {
        chatId,
        messageThreadId,
        messageId: 2204,
        botMessageId: 701,
        text: "reply to the first chain after a fresh chain",
      }),
    ).resolves.toBe(firstThreadId);
  }

  it("preserves Telegram forum delivery and ignores duplicate completion callbacks", async () => {
    expect.hasAssertions();
    await runCanonicalTelegramForumScenario("callback");
  });

  it("preserves Telegram group reply chains and duplicate updates", async () => {
    expect.hasAssertions();
    await runCanonicalTelegramForumScenario("reply-chain");
  });

  it("starts a fresh Telegram group chain after a completed reply", async () => {
    expect.hasAssertions();
    await runCanonicalTelegramForumScenario("fresh-chain");
  });

  it(
    "rejects a split Telegram topic input whose context cannot be stored and accepts a duplicate delivery",
    { timeout: 120_000 },
    async () => {
      const runnerGroup = configureCanonicalTelegramRunner();
      const fixture = await createTelegramPostFixture({ linkOfficial: true });
      await useNativeFableSubscription(fixture);
      const actor = actorForFixture(fixture);
      const telegramMocks = telegramApiMocks();
      const uploads = captureIntegrationInputUploads(context);
      const bytes = Buffer.from("original Telegram topic attachment");
      const chatId = -randomInt(100_000_000, 999_999_999);
      const messageThreadId = randomInt(10_000, 99_999);
      const botUsername = OFFICIAL_BOT_USERNAME;
      const firstPrompt = `@${botUsername} inspect the original topic attachment`;
      context.mocks.telegram.getFile.mockResolvedValue({
        file_id: "split-telegram-file",
        file_path: "incoming/split-file",
        file_size: bytes.length,
      });
      server.use(
        http.get(
          `https://api.telegram.org/file/bot${OFFICIAL_BOT_TOKEN}/incoming/split-file`,
          () => {
            return new HttpResponse(bytes, {
              headers: { "content-type": "text/plain" },
            });
          },
        ),
      );
      const update = {
        update_id: 901,
        message: {
          message_id: 9001,
          message_thread_id: messageThreadId,
          chat: { id: chatId, type: "supergroup" },
          from: {
            id: Number(fixture.telegramUserId),
            first_name: "Alice",
          },
          caption: firstPrompt,
          caption_entities: [mentionEntity(botUsername)],
          document: {
            file_id: "split-telegram-file",
            file_unique_id: "split-telegram-unique-file",
            file_name: "topic-note.txt",
            mime_type: "text/plain",
          },
        },
      };
      const removeFault = await installTelegramContextFailureFixture(chatId);
      const rejected = await settleIncludingAbort(
        (async () => {
          expect(
            (
              await postWebhook({
                telegramBotId: fixture.telegramBotId,
                secret: fixture.webhookSecret,
                body: update,
              })
            ).status,
          ).toBe(200);
          await flushWaitUntilForTest();
        })(),
      );
      const removed = await settleIncludingAbort(removeFault());
      if (!rejected.ok) {
        throw rejected.error;
      }
      if (!removed.ok) {
        throw removed.error;
      }
      expect(
        (await runsApi.listAgentRuns(actor, { limit: 20 })).runs,
      ).toStrictEqual([]);
      expect(telegramMocks.sentMessages).toHaveLength(0);

      expect(
        (
          await postWebhook({
            telegramBotId: fixture.telegramBotId,
            secret: fixture.webhookSecret,
            body: update,
          })
        ).status,
      ).toBe(200);
      await flushWaitUntilForTest();
      const acceptedRun = await runForPrompt(fixture, firstPrompt);
      if (!acceptedRun) {
        throw new Error("Expected the redelivered Telegram topic run");
      }
      const claim = await claimTelegramRun(acceptedRun.id, runnerGroup);
      expect(claim.prompt).toContain(firstPrompt);
      expect(claim.prompt).toContain("topic-note.txt");
      const fileId = claim.prompt.match(/ {3}\[ID\] ([^\n]+)/u)?.[1];
      if (!fileId) {
        throw new Error("Expected the original canonical Telegram topic file");
      }
      await expectIntegrationInputPreview(context, {
        actor,
        fileId,
        bytes,
        contentType: "text/plain",
        uploads,
        okouToken: claim.platformEnvironment.OKOU_TOKEN,
      });
      expectExactSystemPromptFragment(
        acceptedRun.appendSystemPrompt,
        [
          `Chat ID: ${chatId}`,
          "Chat type: supergroup",
          "Message ID: 9001",
          `Message thread ID: ${messageThreadId}`,
        ].join("\n"),
      );
      await completeCanonicalChatRun({
        runId: acceptedRun.id,
        sandboxToken: claim.sandboxToken,
      });
      expect(telegramMocks.sentMessages).toHaveLength(1);
      expect(telegramMocks.sentMessages[0]).toMatchObject({
        chat_id: String(chatId),
        message_thread_id: messageThreadId,
        reply_parameters: { message_id: 9001 },
      });
    },
  );

  it("keeps Telegram callbacks typed when OKOU_API_BACKEND_URL is set", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://www.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    const runnerGroup = configureCanonicalTelegramRunner();
    const fixture = await createTelegramPostFixture({ linkOfficial: true });
    await useNativeFableSubscription(fixture);
    const telegramMocks = telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 1,
        message: {
          message_id: 42,
          chat: { id: 77_001, type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
            language_code: "en",
          },
          text: "hello from telegram",
        },
      },
    });
    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    // The completion is delivered by the typed Telegram chat callback, not
    // through an HTTP callback to the configured backend URL.
    const run = await runForPrompt(fixture, "hello from telegram");
    if (!run) {
      throw new Error("Expected the Telegram run");
    }
    const claim = await claimTelegramRun(run.id, runnerGroup);
    await completeCanonicalChatRun({
      runId: run.id,
      sandboxToken: claim.sandboxToken,
    });
    expect(telegramMocks.sentMessages).toHaveLength(1);
    expect(telegramMocks.sentMessages[0]).toMatchObject({
      chat_id: "77001",
    });
  });

  it("preserves a mention-only Telegram request with the preceding group task", async () => {
    const fixture = await createTelegramPostFixture({ linkOfficial: true });
    await useNativeFableSubscription(fixture);
    const botUsername = OFFICIAL_BOT_USERNAME;
    telegramApiMocks();

    await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 2,
        message: {
          message_id: 100,
          chat: { id: -10_099_002, type: "supergroup" },
          from: { id: Number(fixture.telegramUserId), first_name: "Alice" },
          text: "Check https://example.com/broken-article",
        },
      },
    });
    await flushWaitUntilForTest();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 3,
        message: {
          message_id: 101,
          chat: { id: -10_099_002, type: "supergroup" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: `@${botUsername}`,
          entities: [mentionEntity(botUsername)],
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const run = await runForPrompt(fixture, `@${botUsername}`);
    expect(run?.prompt).toBe(`@${botUsername}`);
    await expect(
      readTelegramSourcePart(fixture, `@${botUsername}`),
    ).resolves.toStrictEqual({
      type: "source",
      kind: "telegram",
      href: "https://t.me/c/99002/101",
    });
    expect(run?.appendSystemPrompt).toContain("Chat type: supergroup");
    expect(run?.appendSystemPrompt).toContain(
      "https://example.com/broken-article",
    );
    expectExactSystemPromptFragment(
      run?.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Telegram",
        "Bot ID: 987654",
        `Bot username: @${botUsername}`,
        "Chat ID: -10099002",
        "Chat type: supergroup",
        "Message ID: 101",
      ].join("\n"),
    );
    // A top-level group message has no reply chain or forum topic.
    expect(run?.appendSystemPrompt).not.toContain("Root message ID:");
    expect(run?.appendSystemPrompt).not.toContain("Message thread ID:");
    expect(run?.appendSystemPrompt).toContain("Telegram username: @alice");
  });

  it("creates an agent run for a linked official-bot private message", async () => {
    // The log detail resolves the run framework from the Axiom run-context
    // dataset; mock that external query like the Runner-backed cases do.
    runsApi.acceptTelemetryIngest();
    const fixture = await createTelegramPostFixture({ linkOfficial: true });
    await useNativeFableSubscription(fixture);
    telegramApiMocks(OFFICIAL_BOT_TOKEN);

    const response = await postWebhook({
      telegramBotId: "official",
      secret: OFFICIAL_WEBHOOK_SECRET,
      apiOrigin: "https://api.okou.ai",
      body: {
        update_id: 4,
        message: {
          message_id: 51,
          chat: { id: 88_002, type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "bob",
            first_name: "Bob",
            language_code: "en",
          },
          text: "run through official bot",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const run = await runForPrompt(fixture, "run through official bot");
    expect(run?.prompt).toBe("run through official bot");
    await expect(
      readTelegramSourcePart(fixture, "run through official bot"),
    ).resolves.toStrictEqual({
      type: "source",
      kind: "telegram",
      href: `https://t.me/${OFFICIAL_BOT_USERNAME}`,
    });
    expect(run?.appendSystemPrompt).toContain(
      "Bot username: @official_okou_bot",
    );
    expectExactSystemPromptFragment(
      run?.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Telegram",
        "Bot ID: 987654",
        `Bot username: @${OFFICIAL_BOT_USERNAME}`,
        "Chat ID: 88002",
        "Chat type: private",
        "Message ID: 51",
        "Root message ID: direct-message:main",
      ].join("\n"),
    );
    // The admitted sender identity reaches the agent's user info.
    expect(run?.appendSystemPrompt).toContain("Telegram display name: Bob");
    expect(run?.appendSystemPrompt).toContain("Telegram username: @bob");
    expect(run?.appendSystemPrompt).toContain(
      `Telegram user ID: ${fixture.telegramUserId}`,
    );
    expect(run?.appendSystemPrompt).toContain("Telegram language: en");
    if (!run) {
      throw new Error("Expected the official-bot Telegram run");
    }
    const log = await runReadsApi.requestReadLogById(
      actorForFixture(fixture),
      run.id,
      [200],
    );
    expect(log.body.triggerSource).toBe("telegram");
  });

  it("keeps an official-bot group mention routable after an overlapping model-key fixture releases", async () => {
    const overlappingModelKey = await seedBuiltInDefaultModelKey(context);
    const fixture = await createTelegramPostFixture({ linkOfficial: true });
    // The poster's own operator key for the default model outlives the
    // overlapping key fixture.
    await seedBuiltInDefaultModelKey(context);
    await overlappingModelKey.release();
    telegramApiMocks(OFFICIAL_BOT_TOKEN);

    const response = await postWebhook({
      telegramBotId: "official",
      secret: OFFICIAL_WEBHOOK_SECRET,
      body: {
        update_id: 5,
        message: {
          message_id: 52,
          chat: { id: -10_099_003, type: "group" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "bob",
            first_name: "Bob",
          },
          text: `@${OFFICIAL_BOT_USERNAME} help from a group`,
          entities: [mentionEntity(OFFICIAL_BOT_USERNAME)],
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const run = await runForPrompt(
      fixture,
      `@${OFFICIAL_BOT_USERNAME} help from a group`,
    );
    expect(run?.prompt).toBe(`@${OFFICIAL_BOT_USERNAME} help from a group`);
    expect(run?.appendSystemPrompt).toContain(
      "Bot username: @official_okou_bot",
    );
  });

  it("does not change the member default before a Telegram conversation exists", async () => {
    const fixture = await createTelegramPostFixture({ linkOfficial: true });
    const actor = actorForFixture(fixture);
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensurePersonalSubscriptionModel(actor, {
      model: "claude-sonnet-5",
    });
    const telegramMocks = telegramApiMocks();

    const list = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 101,
        message: {
          message_id: 1011,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/model",
        },
      },
    });
    expect(list.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "existing Okou conversation",
    );

    const switchModel = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 102,
        message: {
          message_id: 1012,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/model Claude Sonnet 5",
        },
      },
    });
    expect(switchModel.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[1]?.text).toContain(
      "existing Okou conversation",
    );
    await expect(memberDefaultModel(fixture)).resolves.toBe("claude-sonnet-5");

    const defaultModel = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 103,
        message: {
          message_id: 1013,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/model default",
        },
      },
    });
    expect(defaultModel.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[2]?.text).toContain(
      "existing Okou conversation",
    );
    await expect(memberDefaultModel(fixture)).resolves.toBe("claude-sonnet-5");
  });

  it.each(["photo", "document"] as const)(
    "imports Telegram %s into canonical storage before dispatch",
    async (type) => {
      const fixture = await createTelegramPostFixture({ linkOfficial: true });
      const actor = actorForFixture(fixture);
      await useNativeFableSubscription(fixture);
      const runnerGroup = configureCanonicalTelegramRunner();
      telegramApiMocks();
      const uploads = captureIntegrationInputUploads(context);
      const bytes = Buffer.from(`telegram ${type} bytes`);
      const contentType = type === "photo" ? "image/jpeg" : "application/pdf";
      context.mocks.telegram.getFile.mockResolvedValue({
        file_id: "telegram-file",
        file_path: "incoming/file",
        file_size: bytes.length,
      });
      server.use(
        http.get(
          `https://api.telegram.org/file/bot${OFFICIAL_BOT_TOKEN}/incoming/file`,
          () => {
            return new HttpResponse(bytes, {
              headers: { "content-type": contentType },
            });
          },
        ),
      );
      const body = {
        update_id: 551,
        message: {
          message_id: 5511,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: { id: Number(fixture.telegramUserId), first_name: "Alice" },
          caption: "inspect imported telegram file",
          ...(type === "photo"
            ? {
                photo: [
                  {
                    file_id: "telegram-file",
                    file_unique_id: "unique-file",
                    width: 800,
                    height: 600,
                  },
                ],
              }
            : {
                document: {
                  file_id: "telegram-file",
                  file_unique_id: "unique-file",
                  file_name: "report.pdf",
                  mime_type: contentType,
                },
              }),
        },
      };
      const response = await postWebhook({
        telegramBotId: fixture.telegramBotId,
        secret: fixture.webhookSecret,
        body,
      });
      expect(response.status).toBe(200);
      await flushWaitUntilForTest();
      const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
      const run = listed.runs.find((candidate) => {
        return candidate.prompt.includes("[Web file]");
      });
      if (!run) {
        throw new Error("Expected imported Telegram run");
      }
      const claim = await claimTelegramRun(run.id, runnerGroup);
      expect(claim.prompt).toContain("inspect imported telegram file");
      const fileId = claim.prompt.match(/ {3}\[ID\] ([^\n]+)/u)?.[1];
      if (!fileId) {
        throw new Error("Expected canonical Telegram file id");
      }
      await expectIntegrationInputPreview(context, {
        actor,
        fileId,
        bytes,
        contentType,
        uploads,
        okouToken: claim.platformEnvironment.OKOU_TOKEN,
      });
      await postWebhook({
        telegramBotId: fixture.telegramBotId,
        secret: fixture.webhookSecret,
        body,
      });
      await flushWaitUntilForTest();
      expect(uploads).toHaveLength(1);
      const nextBody = {
        ...body,
        update_id: 552,
        message: {
          ...body.message,
          message_id: 5512,
          caption: "inspect the follow-up file",
          ...("photo" in body.message
            ? {
                photo: body.message.photo.map((photo) => {
                  return { ...photo, file_id: "rotated-telegram-file" };
                }),
              }
            : {
                document: {
                  ...body.message.document,
                  file_id: "rotated-telegram-file",
                },
              }),
        },
      };
      await postWebhook({
        telegramBotId: fixture.telegramBotId,
        secret: fixture.webhookSecret,
        body: nextBody,
      });
      await flushWaitUntilForTest();
      const { input: delivery } = await runsApi.nextSteerableInput(
        claim.sandboxToken,
        run.id,
      );
      if (!delivery) {
        throw new Error("Expected imported active input");
      }
      expect(delivery.prompt).toContain("inspect the follow-up file");
      expect(delivery.prompt).toContain("[Web file]");
      const followUpId = delivery.prompt.match(/ {3}\[ID\] ([^\n]+)/u)?.[1];
      if (!followUpId) {
        throw new Error("Expected imported active file id");
      }
      expect(followUpId).toBe(fileId);
      expect(uploads).toHaveLength(1);
      expect(context.mocks.telegram.getFile).toHaveBeenCalledTimes(1);
      await expectIntegrationInputPreview(context, {
        actor,
        fileId: followUpId,
        bytes,
        contentType,
        uploads,
        okouToken: claim.platformEnvironment.OKOU_TOKEN,
      });
    },
  );

  it.each([403, 429])(
    "applies Slack retry policy to Telegram file metadata error %s",
    async (status) => {
      const telegramClient = await vi.importActual<
        typeof import("../../external/telegram-client")
      >("../../external/telegram-client");
      context.mocks.telegram.getFile.mockImplementation(
        (token, fileId, signal) => {
          if (
            typeof token !== "string" ||
            typeof fileId !== "string" ||
            (signal !== undefined && !(signal instanceof AbortSignal))
          ) {
            throw new Error("Expected Telegram file download arguments");
          }
          return telegramClient.getFile(token, fileId, signal);
        },
      );
      const fixture = await createTelegramPostFixture({ linkOfficial: true });
      const actor = actorForFixture(fixture);
      await useNativeFableSubscription(fixture);
      const runnerGroup = configureCanonicalTelegramRunner();
      telegramApiMocks();
      const uploads = captureIntegrationInputUploads(context);
      const bytes = Buffer.from("recovered Telegram attachment");
      let metadataCalls = 0;
      server.use(
        http.get(
          `https://api.telegram.org/bot${OFFICIAL_BOT_TOKEN}/getFile`,
          () => {
            metadataCalls += 1;
            return metadataCalls === 1
              ? HttpResponse.json({
                  ok: false,
                  error_code: status,
                  description: "File unavailable",
                })
              : HttpResponse.json({
                  ok: true,
                  result: {
                    file_id: "retry-file",
                    file_path: "incoming/retry-file",
                  },
                });
          },
        ),
        http.get(
          `https://api.telegram.org/file/bot${OFFICIAL_BOT_TOKEN}/incoming/retry-file`,
          () => {
            return new HttpResponse(bytes, {
              headers: { "content-type": "application/pdf" },
            });
          },
        ),
      );
      const postFile = async (messageId: number) => {
        const response = await postWebhook({
          telegramBotId: fixture.telegramBotId,
          secret: fixture.webhookSecret,
          body: {
            update_id: messageId,
            message: {
              message_id: messageId,
              chat: { id: Number(fixture.telegramUserId), type: "private" },
              from: { id: Number(fixture.telegramUserId), first_name: "Alice" },
              caption: "retry telegram attachment",
              document: {
                file_id: "retry-file",
                file_unique_id: "retry-unique-file",
                file_name: "retry.pdf",
                mime_type: "application/pdf",
              },
            },
          },
        });
        expect(response.status).toBe(200);
        await flushWaitUntilForTest();
      };
      await postFile(5801);
      const firstParts = await listIntegrationInputFileParts(context, actor);
      expect(firstParts).toHaveLength(1);
      const fileId = firstParts[0]?.fileId;
      if (!fileId) {
        throw new Error("Expected a failed Telegram file item");
      }
      const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
      const run = listed.runs[0];
      if (!run) {
        throw new Error("Expected Telegram retry run");
      }
      const claim = await claimTelegramRun(run.id, runnerGroup);
      expect(claim.prompt).not.toContain("[Web file]");
      await postFile(5802);
      await expect(
        listIntegrationInputFileParts(context, actor),
      ).resolves.toStrictEqual([
        expect.objectContaining({ fileId }),
        expect.objectContaining({ fileId }),
      ]);
      const { input: delivery } = await runsApi.nextSteerableInput(
        claim.sandboxToken,
        run.id,
      );
      if (!delivery) {
        throw new Error("Expected the next Telegram file message");
      }
      expect(metadataCalls).toBe(status === 429 ? 2 : 1);
      expect(uploads).toHaveLength(status === 429 ? 1 : 0);
      if (status === 429) {
        expect(delivery.prompt).toContain(`[ID] ${fileId}`);
        await expectIntegrationInputPreview(context, {
          actor,
          fileId,
          bytes,
          contentType: "application/pdf",
          uploads,
          okouToken: claim.platformEnvironment.OKOU_TOKEN,
        });
      } else {
        expect(delivery.prompt).not.toContain("[Web file]");
      }
    },
  );

  it.each(["declared size", "streamed size", "upstream error"] as const)(
    "retains Telegram file references after an import fails on %s",
    async (failure) => {
      const fixture = await createTelegramPostFixture({ linkOfficial: true });
      const actor = actorForFixture(fixture);
      await useNativeFableSubscription(fixture);
      const runnerGroup = configureCanonicalTelegramRunner();
      telegramApiMocks();
      const uploads = captureIntegrationInputUploads(context);
      context.mocks.telegram.getFile.mockResolvedValue({
        file_id: "oversized-file",
        file_path: "incoming/large-file",
      });
      server.use(
        http.get(
          `https://api.telegram.org/file/bot${OFFICIAL_BOT_TOKEN}/incoming/large-file`,
          () => {
            return failure === "upstream error"
              ? new HttpResponse(null, { status: 403 })
              : new HttpResponse(Buffer.alloc(20 * 1024 * 1024 + 1), {
                  headers: { "content-type": "application/pdf" },
                });
          },
        ),
      );
      const response = await postWebhook({
        telegramBotId: fixture.telegramBotId,
        secret: fixture.webhookSecret,
        body: {
          update_id: 561,
          message: {
            message_id: 5611,
            chat: { id: Number(fixture.telegramUserId), type: "private" },
            from: { id: Number(fixture.telegramUserId), first_name: "Alice" },
            caption: "inspect this large report",
            document: {
              file_id: "oversized-file",
              file_unique_id: "unique-file",
              file_name: "large.pdf",
              mime_type: "application/pdf",
              ...(failure === "declared size"
                ? { file_size: 20 * 1024 * 1024 + 1 }
                : {}),
            },
          },
        },
      });
      expect(response.status).toBe(200);
      await flushWaitUntilForTest();
      const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
      const run = listed.runs.find((candidate) => {
        return candidate.prompt.includes("inspect this large report");
      });
      if (!run) {
        throw new Error("Expected Telegram fallback run");
      }
      const claim = await claimTelegramRun(run.id, runnerGroup);
      expect(claim.prompt).toContain("[Telegram file]");
      expect(claim.prompt).toContain("[FILE_ID] oversized-file");
      expect(claim.prompt).not.toContain("[Web file]");
      expect(uploads).toHaveLength(0);
      await expect(
        listIntegrationInputFileParts(context, actor),
      ).resolves.toStrictEqual([
        expect.objectContaining({
          fileId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          filenameSnapshot: "large.pdf",
        }),
      ]);
      if (failure === "declared size") {
        expect(context.mocks.telegram.getFile).not.toHaveBeenCalled();
      }
    },
  );

  it("does not prompt unlinked official group replies to another bot but prompts replies to the official bot", async () => {
    configureOfficialBotEnv();
    const telegramMocks = telegramApiMocks(OFFICIAL_BOT_TOKEN);

    const otherBotReply = await postWebhook({
      telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
      secret: OFFICIAL_WEBHOOK_SECRET,
      body: {
        update_id: 121,
        message: {
          message_id: 1211,
          chat: { id: -10_099_121, type: "group" },
          from: { id: 93_121, username: "unlinked", first_name: "Unlinked" },
          text: "following up",
          reply_to_message: {
            message_id: 44,
            chat: { id: -10_099_121, type: "group" },
            from: { id: 123, is_bot: true, username: "other_bot" },
            text: "message from another bot",
          },
        },
      },
    });
    expect(otherBotReply.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(0);

    mockEnv("APP_URL", "https://app.okou.ai");
    const officialReply = await postWebhook({
      telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
      secret: OFFICIAL_WEBHOOK_SECRET,
      apiOrigin: "https://api.okou.ai",
      body: {
        update_id: 122,
        message: {
          message_id: 1212,
          chat: { id: -10_099_121, type: "group" },
          from: { id: 93_121, username: "unlinked", first_name: "Unlinked" },
          text: "following up",
          reply_to_message: {
            message_id: 45,
            chat: { id: -10_099_121, type: "group" },
            from: {
              id: 987_654,
              is_bot: true,
              username: "provider_renamed_bot",
            },
            text: "message from zero",
          },
        },
      },
    });
    expect(officialReply.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(1);
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "connect your account",
    );
    expect(telegramMocks.sentMessages[0]?.text).toContain("Okou");
    expect(telegramMocks.sentMessages[0]?.reply_parameters).toStrictEqual({
      message_id: 1212,
    });
    const connectUrl = new URL(
      telegramMocks.sentMessages[0]?.reply_markup?.inline_keyboard[0]?.[0]
        ?.url ?? "",
    );
    expect(connectUrl.origin).toBe("https://t.me");
    expect(connectUrl.pathname).toBe(`/${OFFICIAL_BOT_USERNAME}`);
    expect(connectUrl.searchParams.get("start")).toBe("connect");
  });
});
