import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import {
  OFFICIAL_TELEGRAM_BOT_ID,
  integrationsTelegramContract,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import type {
  TestTelegramStateActionBody,
  TestTelegramStateActionResponse,
  TestTelegramStateResponse,
} from "@okouai/api-contracts/contracts/test-telegram-state";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  findPendingChatEventByPromptFixture,
  findTelegramChatEventByPromptFixture,
  clearTelegramPublicBrandFixture,
  readChatEventContextFixture,
  setTelegramThinkingMessageIdFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { testTelegramStateRoutes } from "../test-telegram-state";
import { integrationsTelegramRoutes } from "../integrations-telegram";

const TEST_APP_ROUTES = Object.freeze([...integrationsTelegramRoutes]);

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const chatApi = createChatFilesBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);

const TEST_BOT_TOKEN = "123456:test-bot-token";
const NEW_BOT_TOKEN = "123456:new-test-bot-token";
const OFFICIAL_BOT_TOKEN = "987654:official-bot-token";
const OFFICIAL_BOT_USERNAME = "official_okou_bot";
const OFFICIAL_WEBHOOK_SECRET = "official-webhook-secret";
const TELEGRAM_STATE_ACTION_ROUTE = "/api/test/telegram-state/action";
const TELEGRAM_STATE_ROUTE = "/api/test/telegram-state";

interface TelegramPostFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly versionId: string;
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

function telegramOauthHead(
  contentLength: string,
  observedOrigins: (string | null)[] = [],
) {
  return http.head("https://oauth.telegram.org/auth", ({ request }) => {
    const url = new URL(request.url);
    observedOrigins.push(url.searchParams.get("origin"));
    return new HttpResponse(null, {
      headers: { "content-length": contentLength },
    });
  });
}

function mockTelegramGetMe(args: {
  readonly botId: string;
  readonly username?: string;
  readonly privacyDisabled?: boolean;
}): void {
  context.mocks.telegram.getMe.mockResolvedValue({
    id: Number(args.botId),
    username: args.username ?? `bot_${args.botId}`,
    first_name: "Test Bot",
    can_read_all_group_messages: args.privacyDisabled ?? true,
  });
}

function configureOfficialBotEnv(): void {
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", OFFICIAL_BOT_USERNAME);
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", OFFICIAL_WEBHOOK_SECRET);
}

function telegramApiMocks(token = TEST_BOT_TOKEN): {
  readonly chatActions: unknown[];
  readonly sentMessages: TelegramSendMessageBody[];
  readonly deletedMessages: TelegramDeleteMessageBody[];
} {
  const chatActions: unknown[] = [];
  const sentMessages: TelegramSendMessageBody[] = [];
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

  return { chatActions, sentMessages, deletedMessages };
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

function expectExactSystemPromptFragment(
  appendSystemPrompt: string | null | undefined,
  expectedFragment: string,
): void {
  if (!appendSystemPrompt) {
    throw new Error("Expected Telegram append system prompt");
  }
  expect(appendSystemPrompt.split(expectedFragment)).toHaveLength(2);
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

async function readTelegramState(
  botId: string,
): Promise<TestTelegramStateResponse> {
  const response = await createApp({
    signal: context.signal,
    routes: testTelegramStateRoutes,
  }).request(`${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(botId)}`);
  await expectOk(response, "read telegram state");
  return await readJson<TestTelegramStateResponse>(response);
}

async function seedTelegramPostFixture(
  args: {
    readonly orgId?: string;
    readonly userId?: string;
    readonly telegramBotId?: string;
    readonly installBot?: boolean;
    readonly linkTelegramUser?: boolean;
    readonly seedOfficialLink?: boolean;
    readonly seedDefaultAgent?: boolean;
  } = {},
): Promise<TelegramPostFixture> {
  const response = await postTelegramStateAction({
    action: "seed-post-fixture",
    org_id: args.orgId,
    user_id: args.userId,
    telegram_bot_id: args.telegramBotId,
    install_bot: args.installBot,
    link_telegram_user: args.linkTelegramUser,
    seed_official_link: args.seedOfficialLink,
    seed_default_agent: args.seedDefaultAgent,
    bot_token: TEST_BOT_TOKEN,
  });
  const fixture =
    typeof response.fixture === "object" && response.fixture !== null
      ? (response.fixture as Record<string, unknown>)
      : null;
  if (!fixture) {
    throw new Error("seedTelegramPostFixture: response missing fixture");
  }
  return {
    orgId: String(fixture.org_id),
    userId: String(fixture.user_id),
    composeId: String(fixture.compose_id),
    versionId: String(fixture.version_id),
    telegramBotId: String(fixture.telegram_bot_id),
    webhookSecret: String(fixture.webhook_secret),
    telegramUserId:
      typeof fixture.telegram_user_id === "string"
        ? fixture.telegram_user_id
        : undefined,
  };
}

async function deleteTelegramPostFixture(
  fixture: TelegramPostFixture,
): Promise<void> {
  await postTelegramStateAction({
    action: "delete-post-fixture",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    compose_id: fixture.composeId,
    telegram_bot_id: fixture.telegramBotId,
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

beforeEach(() => {
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  server.use(telegramOauthHead("1001"));
});

afterEach(() => {
  clearMockedEnv();
});

function telegramClient() {
  return setupApp({ context, routes: integrationsTelegramRoutes })(
    integrationsTelegramContract,
  );
}

async function postRegisterRaw(
  body: unknown,
  apiOrigin?: string,
): Promise<Response> {
  return await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(
    apiOrigin
      ? `${apiOrigin.replace(/\/$/u, "")}/api/telegram/register`
      : "/api/telegram/register",
    {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
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
        cliAgentType: "claude-code",
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

async function completeWebContinuation(args: {
  readonly fixture: TelegramPostFixture;
  readonly runnerGroup: string;
  readonly chatThreadId: string;
  readonly applicationSessionId: string | null;
  readonly resumeCliAgentSessionId: string;
  readonly prompt: string;
}): Promise<string> {
  const web = await chatApi.requestSendEvent(
    actorForFixture(args.fixture),
    {
      agentId: args.fixture.composeId,
      threadId: args.chatThreadId,
      prompt: args.prompt,
    },
    [201],
  );
  expect(web.status).toBe(201);
  if (web.status !== 201 || web.body.runId === null) {
    throw new Error("Expected web continuation to create a run");
  }
  const webState = await telegramPostRunState(args.fixture, args.prompt);
  expect(webState.run?.sessionId).toBe(args.applicationSessionId);
  expect(webState.agentRun?.chatThreadId).toBe(args.chatThreadId);
  const webClaim = await claimTelegramRun(web.body.runId, args.runnerGroup);
  expect(webClaim.resumeSession?.sessionId).toBe(args.resumeCliAgentSessionId);
  return await completeCanonicalChatRun({
    runId: web.body.runId,
    sandboxToken: webClaim.sandboxToken,
  });
}

async function latestRunForFixture(
  fixture: TelegramPostFixture,
): Promise<TelegramRunSnapshot | null> {
  return (await telegramPostRunState(fixture)).run;
}

async function latestAgentRunForFixture(
  fixture: TelegramPostFixture,
): Promise<TelegramAgentRunSnapshot | null> {
  return (await telegramPostRunState(fixture)).agentRun;
}

function mentionEntity(username: string) {
  return { type: "mention", offset: 0, length: username.length + 1 };
}

async function linkedTelegramUserLinkId(
  fixture: TelegramPostFixture,
): Promise<string> {
  const response = await postTelegramStateAction({
    action: "get-telegram-link-id",
    installation_id: fixture.telegramBotId,
    user_id: fixture.userId,
  });
  if (typeof response.link_id !== "string") {
    throw new Error("Expected seeded Telegram user link");
  }
  return response.link_id;
}

async function findTelegramChatThreadRoute(args: {
  readonly userLinkId: string;
  readonly ownerKind: "custom" | "official";
  readonly chatId: string;
  readonly rootMessageId: string;
}): Promise<Record<string, unknown> | null> {
  const response = await postTelegramStateAction({
    action: "find-chat-thread-route",
    user_link_id: args.userLinkId,
    owner_kind: args.ownerKind,
    chat_id: args.chatId,
    root_message_id: args.rootMessageId,
  });
  return stateRecord(response.route);
}

async function seedRunningRun(fixture: TelegramPostFixture): Promise<void> {
  await postTelegramStateAction({
    action: "seed-running-run",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    version_id: fixture.versionId,
    compose_id: fixture.composeId,
  });
}

async function seedModelPolicies(args: {
  readonly fixture: TelegramPostFixture;
  readonly selectedModel?: string | null;
}): Promise<void> {
  await postTelegramStateAction({
    action: "seed-model-policies",
    org_id: args.fixture.orgId,
    user_id: args.fixture.userId,
    compose_id: args.fixture.composeId,
    selected_model: args.selectedModel,
  });
}

async function selectedModelFor(
  fixture: TelegramPostFixture,
): Promise<string | null> {
  const response = await postTelegramStateAction({
    action: "get-selected-model",
    org_id: fixture.orgId,
    user_id: fixture.userId,
  });
  return typeof response.selected_model === "string"
    ? response.selected_model
    : null;
}

async function seedPendingUserLink(
  fixture: TelegramPostFixture,
): Promise<void> {
  await postTelegramStateAction({
    action: "seed-pending-user-link",
    installation_id: fixture.telegramBotId,
    user_id: fixture.userId,
  });
}

describe("POST /api/telegram/setup-status", () => {
  it("requires an authenticated organization session", async () => {
    const response = await accept(
      telegramClient().setupStatus({
        headers: {},
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when botToken is missing", async () => {
    mocks.clerk.session("user_missing_token", "org_missing_token");

    const response = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request("/api/telegram/setup-status", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "botToken is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 400 when bot token is invalid", async () => {
    mocks.clerk.session("user_invalid_token", "org_invalid_token");
    context.mocks.telegram.getMe.mockRejectedValue(new Error("Unauthorized"));

    const response = await accept(
      telegramClient().setupStatus({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("Invalid bot token");
  });

  it("returns setup status for a valid bot token", async () => {
    const botId = newTelegramBotId();
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(userId, orgId);
    mockTelegramGetMe({
      botId,
      username: "setup_bot",
      privacyDisabled: true,
    });
    mockEnv("APP_URL", "https://app.okou.ai");
    const observedOrigins: (string | null)[] = [];
    server.use(telegramOauthHead("2048", observedOrigins));

    const response = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request("https://api.okou.ai/api/telegram/setup-status", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        botToken: TEST_BOT_TOKEN,
        origin: "https://app.okou.ai/settings/telegram",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      id: botId,
      username: "setup_bot",
      domainConfigured: true,
      privacyDisabled: true,
    });
    expect(observedOrigins).toStrictEqual(["https://app.okou.ai"]);
  });

  it("rejects an already installed bot", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: fixture.telegramBotId });

    const response = await accept(
      telegramClient().setupStatus({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [409],
    );

    expect(response.body.error.message).toContain("already installed");
  });
});

describe("POST /api/telegram/register", () => {
  it("requires an authenticated organization session", async () => {
    const response = await accept(
      telegramClient().register({
        headers: {},
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when botToken is missing", async () => {
    mocks.clerk.session("user_register_missing_token", "org_register_missing");

    const response = await postRegisterRaw({});

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "botToken is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 400 when bot token is invalid", async () => {
    mocks.clerk.session("user_register_invalid_token", "org_register_invalid");
    context.mocks.telegram.getMe.mockRejectedValue(new Error("Unauthorized"));

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("Invalid bot token");
  });

  it("registers a custom Telegram bot and configures its webhook", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ telegramBotId, installBot: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockEnv("OKOU_API_BACKEND_URL", "https://api.example.test");
    mockEnv("OKOU_WEB_URL", "https://www.example.test");
    mockEnv("APP_URL", "https://app.example.test");
    mockTelegramGetMe({ botId: telegramBotId, username: "registered_bot" });
    context.mocks.telegram.setWebhook.mockResolvedValue(undefined);
    context.mocks.telegram.setMyCommands.mockResolvedValue(undefined);
    const observedOrigins: (string | null)[] = [];
    server.use(telegramOauthHead("1001", observedOrigins));

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: fixture.composeId,
        },
      }),
      [201],
    );

    expect(response.body).toMatchObject({
      id: telegramBotId,
      username: "registered_bot",
      tokenStatus: "valid",
      domainConfigured: true,
      agent: { id: fixture.composeId },
      isOwner: true,
      isConnected: false,
    });
    expect(observedOrigins).toStrictEqual(["https://app.example.test"]);
    expect(context.mocks.telegram.setWebhook).toHaveBeenCalledWith(
      TEST_BOT_TOKEN,
      `https://www.example.test/api/telegram/webhook/${telegramBotId}`,
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
    expect(context.mocks.telegram.setMyCommands).toHaveBeenCalledWith(
      TEST_BOT_TOKEN,
      expect.arrayContaining([expect.objectContaining({ command: "connect" })]),
    );

    const state = await readTelegramState(telegramBotId);
    const installation = stateRecord(state.installation);
    expect(installation?.defaultAgentId).toBe(fixture.composeId);
    expect(installation?.botUsername).toBe("registered_bot");
  });

  it("uses configured origins for the custom bot webhook", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ telegramBotId, installBot: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockEnv("OKOU_WEB_URL", "https://api.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    mockTelegramGetMe({ botId: telegramBotId, username: "owner_named_bot" });
    context.mocks.telegram.setWebhook.mockResolvedValue(undefined);
    context.mocks.telegram.setMyCommands.mockResolvedValue(undefined);
    const observedOrigins: (string | null)[] = [];
    server.use(telegramOauthHead(telegramBotId, observedOrigins));

    const response = await postRegisterRaw(
      {
        botToken: TEST_BOT_TOKEN,
        defaultAgentId: fixture.composeId,
      },
      "https://api.okou.ai",
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: telegramBotId,
      username: "owner_named_bot",
      domainConfigured: true,
    });
    expect(observedOrigins).toStrictEqual(["https://app.okou.ai"]);
    expect(context.mocks.telegram.setWebhook).toHaveBeenCalledWith(
      TEST_BOT_TOKEN,
      `https://api.okou.ai/api/telegram/webhook/${telegramBotId}`,
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
    const installation = stateRecord(
      (await readTelegramState(telegramBotId)).installation,
    );
    expect(installation).toMatchObject({
      telegramBotId,
      botUsername: "owner_named_bot",
      publicBrand: "okou",
    });
  });

  it.each([
    {
      caseName: "the Okou canonical default",
      displayName: "Okou",
      seedDefaultAgent: true,
      expectedUpdateStatus: 200,
      expectedAgentName: "Okou",
    },
    {
      caseName: "an Okou canonical default rename attempt",
      displayName: "Finance Agent",
      seedDefaultAgent: true,
      expectedUpdateStatus: 400,
      expectedAgentName: "Okou",
    },
    {
      caseName: "a non-canonical Okou agent named Nova",
      displayName: "Nova",
      seedDefaultAgent: false,
      expectedUpdateStatus: 200,
      expectedAgentName: "Nova",
    },
  ] as const)(
    "brands Telegram command descriptions for $caseName",
    async ({
      displayName,
      seedDefaultAgent,
      expectedAgentName,
      expectedUpdateStatus,
    }) => {
      const telegramBotId = newTelegramBotId();
      const fixture = await trackFixture(
        seedTelegramPostFixture({
          telegramBotId,
          installBot: false,
          seedDefaultAgent,
        }),
      );
      const actor = actorForFixture(fixture);
      const updated = await authOrgApi.requestUpdateAgentMetadata(
        actor,
        fixture.composeId,
        { displayName },
        [expectedUpdateStatus],
      );
      if (updated.status === 400) {
        expect(updated.body).toMatchObject({
          error: { code: "DEFAULT_AGENT_NAME_LOCKED" },
        });
      }
      mockEnv("OKOU_WEB_URL", "https://api.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      mockTelegramGetMe({
        botId: telegramBotId,
        username: `command_bot_${telegramBotId}`,
      });
      context.mocks.telegram.setWebhook.mockResolvedValue(undefined);
      context.mocks.telegram.setMyCommands.mockResolvedValue(undefined);

      const response = await postRegisterRaw(
        {
          botToken: TEST_BOT_TOKEN,
          ...(seedDefaultAgent ? {} : { defaultAgentId: fixture.composeId }),
        },
        "https://api.okou.ai",
      );

      expect(response.status).toBe(201);
      expect(context.mocks.telegram.setMyCommands).toHaveBeenCalledWith(
        TEST_BOT_TOKEN,
        expect.arrayContaining([
          {
            command: "connect",
            description: `Connect to ${expectedAgentName}`,
          },
          {
            command: "disconnect",
            description: `Disconnect from ${expectedAgentName}`,
          },
        ]),
      );
    },
  );

  it("uses the active org default agent when defaultAgentId is omitted", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ telegramBotId, installBot: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({
      botId: telegramBotId,
      username: `default_bot_${telegramBotId}`,
    });
    context.mocks.telegram.setWebhook.mockResolvedValue(undefined);
    context.mocks.telegram.setMyCommands.mockResolvedValue(undefined);

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [201],
    );

    expect(response.body.id).toBe(telegramBotId);
    expect(response.body.agent).toStrictEqual({
      id: fixture.composeId,
      name: expect.any(String),
    });
  });

  it("rejects an empty defaultAgentId before verifying the token", async () => {
    mocks.clerk.session("user_register_empty_agent", "org_register_empty");

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN, defaultAgentId: "" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("defaultAgentId");
    expect(context.mocks.telegram.getMe).not.toHaveBeenCalled();
  });

  it("returns 409 when bot is already registered", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: fixture.telegramBotId });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: fixture.composeId,
        },
      }),
      [409],
    );

    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.message).toContain("/connect");
    expect(context.mocks.telegram.setWebhook).not.toHaveBeenCalled();
  });

  it("reinstalls an existing bot when reinstallBotId matches the token bot id", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({
      botId: fixture.telegramBotId,
      username: `reinstall_bot_${fixture.telegramBotId}`,
    });
    context.mocks.telegram.setWebhook.mockResolvedValue(undefined);
    context.mocks.telegram.setMyCommands.mockResolvedValue(undefined);

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: NEW_BOT_TOKEN,
          reinstallBotId: fixture.telegramBotId,
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: fixture.telegramBotId,
      tokenStatus: "valid",
      agent: { id: fixture.composeId },
    });
    expect(context.mocks.telegram.setWebhook).toHaveBeenCalledWith(
      NEW_BOT_TOKEN,
      expect.stringContaining(`/api/telegram/webhook/${fixture.telegramBotId}`),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
    expect(context.mocks.telegram.setMyCommands).toHaveBeenCalledWith(
      NEW_BOT_TOKEN,
      expect.arrayContaining([expect.objectContaining({ command: "connect" })]),
    );

    const state = await readTelegramState(fixture.telegramBotId);
    const installation = stateRecord(state.installation);
    expect(installation?.telegramBotId).toBe(fixture.telegramBotId);
    expect(installation?.botUsername).toBe(
      `reinstall_bot_${fixture.telegramBotId}`,
    );
  });

  it("rejects reinstall when the token belongs to a different bot", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: newTelegramBotId() });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: NEW_BOT_TOKEN,
          reinstallBotId: fixture.telegramBotId,
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("different Telegram bot");
    expect(context.mocks.telegram.setWebhook).not.toHaveBeenCalled();
  });

  it("returns 400 when no default agent is available", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      seedTelegramPostFixture({
        telegramBotId,
        installBot: false,
        seedDefaultAgent: false,
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: telegramBotId });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: { botToken: TEST_BOT_TOKEN },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("No default agent specified");
  });

  it("returns 404 when defaultAgentId references a nonexistent agent", async () => {
    mocks.clerk.session("user_register_missing_agent", "org_register_missing");
    mockTelegramGetMe({ botId: newTelegramBotId() });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: "00000000-0000-0000-0000-000000000000",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toContain("Agent not found");
  });

  it("returns 403 when defaultAgentId belongs to another org", async () => {
    const otherFixture = await trackFixture(
      seedTelegramPostFixture({
        orgId: `org_other_${randomUUID().slice(0, 8)}`,
        userId: `user_other_${randomUUID().slice(0, 8)}`,
        installBot: false,
      }),
    );
    mocks.clerk.session("user_register_cross_org", "org_register_cross");
    mockTelegramGetMe({ botId: newTelegramBotId() });

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: otherFixture.composeId,
        },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rolls back a new installation when webhook registration fails", async () => {
    const telegramBotId = newTelegramBotId();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ telegramBotId, installBot: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockTelegramGetMe({ botId: telegramBotId });
    context.mocks.telegram.setWebhook.mockRejectedValue(
      new Error("telegram unavailable"),
    );

    const response = await accept(
      telegramClient().register({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          botToken: TEST_BOT_TOKEN,
          defaultAgentId: fixture.composeId,
        },
      }),
      [502],
    );

    expect(response.body.error.code).toBe("BAD_GATEWAY");
    const state = await readTelegramState(telegramBotId);
    expect(state.installation).toBeNull();
  });
});

describe("POST /api/telegram/webhook/:telegramBotId", () => {
  it("validates bot ownership, webhook secret, and JSON payload", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));

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

  it("creates an agent run for a linked custom-bot private message", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const telegramMocks = telegramApiMocks();
    expect(
      stateRecord((await readTelegramState(fixture.telegramBotId)).installation)
        ?.publicBrand,
    ).toBe("okou");

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      apiOrigin: "https://api.okou.ai",
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
    await expect(response.text()).resolves.toBe("OK");
    await flushWaitUntilForTest();

    const run = await latestRunForFixture(fixture);
    expect(run).toMatchObject({ status: "pending", error: null });
    expect(run?.prompt).toBe("hello from telegram");
    expect(run?.appendSystemPrompt).toContain("Telegram username: @alice");
    expect(run?.appendSystemPrompt).toContain("Bot ID:");
    expectExactSystemPromptFragment(
      run?.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Telegram",
        `Bot ID: ${fixture.telegramBotId}`,
        `Bot username: @bot_${fixture.telegramBotId}`,
        "Chat ID: 77001",
        "Chat type: private",
        "Message ID: 42",
        "Root message ID: dm",
      ].join("\n"),
    );
    const admitted = await findTelegramChatEventByPromptFixture({
      userId: fixture.userId,
      prompt: "hello from telegram",
    });
    expect(admitted).toMatchObject({ eventId: expect.any(String) });
    if (!admitted) {
      throw new Error("Expected admitted Telegram input event");
    }
    await expect(
      readChatEventContextFixture(admitted.eventId),
    ).resolves.toMatchObject({
      contextType: "telegram",
      contextId: expect.any(String),
      telegramChatId: "77001",
      telegramMessageId: "42",
      telegramMessageThreadId: null,
      telegramMessageText: "hello from telegram",
      telegramThreadContext: "",
      telegramRootMessageId: "dm",
      telegramThinkingMessageId: null,
      telegramPublicBrand: "okou",
      telegramUserLinkId: expect.any(String),
      telegramUserLinkKind: "custom",
      telegramChatType: "private",
      telegramSenderUserId: fixture.telegramUserId,
      telegramSenderDisplayName: "Alice",
      telegramSenderUsername: "@alice",
      telegramSenderLanguage: "en",
    });
    expect(telegramMocks.chatActions).toHaveLength(1);
    expect(telegramMocks.sentMessages).toHaveLength(0);

    const runState = await telegramPostRunState(fixture);
    expect(runState.agentRun?.triggerSource).toBe("telegram");
    expect(runState.agentRun?.chatThreadId).toStrictEqual(expect.any(String));
    expect(
      stateRecords((await readTelegramState(fixture.telegramBotId)).routes),
    ).toContainEqual(
      expect.objectContaining({
        chatId: "77001",
        rootMessageId: "dm",
        chatThreadId: runState.agentRun?.chatThreadId,
      }),
    );
    expect(runState.callbacks[0]).toMatchObject({
      url: null,
      internalKind: "chat",
      payload: expect.objectContaining({ publicBrand: "okou" }),
    });
    expect(runState.jobExists).toBeTruthy();
  });

  it("snapshots thread reuse inputs before a CLI session exists", async () => {
    const runnerGroup = configureCanonicalTelegramRunner();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
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

    const state = await telegramPostRunState(fixture, prompt);
    const runId = state.run?.id;
    const threadId = state.agentRun?.chatThreadId;
    if (!runId || !threadId) {
      throw new Error("Expected a thread-bound Telegram run");
    }
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
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
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
    const queuedLaunchContext = await readChatEventContextFixture(
      queuedParams.eventId,
    );
    expect(queuedLaunchContext).toMatchObject({
      telegramMessageText: queuedPrompt,
      telegramThreadContext: expect.stringContaining(firstPrompt),
      telegramMessageId: "2202",
      telegramRootMessageId: "dm",
      telegramUserLinkKind: "custom",
    });
    // The current production API cannot create the old persisted shape after
    // this schema ships. Clear only the additive field to emulate queued work
    // admitted by an old API and prove it still launches during rollout.
    await clearTelegramPublicBrandFixture(queuedParams.eventId);
    await setTelegramThinkingMessageIdFixture(queuedParams.eventId, "701");
    await completeCanonicalChatRun({
      runId: firstRunId,
      sandboxToken: firstClaim.sandboxToken,
    });
    let queuedRunId: string | null = null;
    await expect
      .poll(async () => {
        queuedRunId =
          (await telegramPostRunState(fixture, queuedPrompt)).run?.id ?? null;
        return queuedRunId;
      })
      .toStrictEqual(expect.any(String));
    if (!queuedRunId) {
      throw new Error("Expected the queued Telegram run");
    }
    const queuedClaim = await claimTelegramRun(queuedRunId, runnerGroup);
    expect(queuedClaim.prompt).toBe(queuedPrompt);
    const queuedThreadContext = queuedLaunchContext?.telegramThreadContext;
    if (!queuedThreadContext) {
      throw new Error("Expected frozen queued Telegram thread context");
    }
    expectExactSystemPromptFragment(
      queuedClaim.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Telegram",
        `Bot ID: ${fixture.telegramBotId}`,
        `Bot username: @bot_${fixture.telegramBotId}`,
        `Chat ID: ${chatId}`,
        "Chat type: private",
        "Message ID: 2202",
        "Root message ID: dm",
        "",
        queuedThreadContext,
      ].join("\n"),
    );
    await completeCanonicalChatRun({
      runId: queuedRunId,
      sandboxToken: queuedClaim.sandboxToken,
    });
    expect(telegramMocks.deletedMessages).toContainEqual({
      chat_id: String(chatId),
      message_id: 701,
    });
  });

  it("shares one canonical DM session with web and keeps the legacy cursor monotonic", async () => {
    const runnerGroup = configureCanonicalTelegramRunner();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    await seedModelPolicies({
      fixture,
      selectedModel: "claude-sonnet-5",
    });
    const telegramMocks = telegramApiMocks();
    const chatId = 77_101;
    const firstPrompt = "canonical telegram dm first";
    const firstPayload = {
      update_id: 101,
      message: {
        message_id: 2102,
        chat: { id: chatId, type: "private" },
        from: {
          id: Number(fixture.telegramUserId),
          username: "alice",
          first_name: "Alice",
        },
        text: firstPrompt,
      },
    };

    expect(
      (
        await postWebhook({
          telegramBotId: fixture.telegramBotId,
          secret: fixture.webhookSecret,
          body: firstPayload,
        })
      ).status,
    ).toBe(200);
    await flushWaitUntilForTest();

    const firstState = await telegramPostRunState(fixture, firstPrompt);
    expect(firstState.run?.id).toStrictEqual(expect.any(String));
    expect(firstState.agentRun?.chatThreadId).toStrictEqual(expect.any(String));
    const firstClaim = await claimTelegramRun(firstState.run!.id, runnerGroup);
    const cliAgentSessionId = await completeCanonicalChatRun({
      runId: firstState.run!.id,
      sandboxToken: firstClaim.sandboxToken,
    });
    expect(telegramMocks.sentMessages).toHaveLength(1);
    expect(telegramMocks.sentMessages[0]).toMatchObject({
      chat_id: String(chatId),
    });
    expect(telegramMocks.sentMessages[0]).not.toHaveProperty(
      "reply_parameters",
    );
    const completedRun = await postTelegramStateAction({
      action: "get-run",
      run_id: firstState.run!.id,
    });
    expect(completedRun.run).toMatchObject({
      session_id: firstState.run?.sessionId,
      chat_thread_id: firstState.agentRun?.chatThreadId,
      chat_thread_agent_session_id: firstState.run?.sessionId,
      chat_thread_agent_session_run_id: firstState.run?.id,
    });

    const admittedEvents = await chatApi.listThreadEvents(
      actorForFixture(fixture),
      firstState.agentRun!.chatThreadId!,
    );
    expect(admittedEvents.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: firstPrompt },
            { type: "source", kind: "telegram" },
          ],
        },
      }),
    );

    const webCliAgentSessionId = await completeWebContinuation({
      fixture,
      runnerGroup,
      chatThreadId: firstState.agentRun!.chatThreadId!,
      applicationSessionId: firstState.run?.sessionId ?? null,
      resumeCliAgentSessionId: cliAgentSessionId,
      prompt: "canonical web continuation",
    });

    const secondPrompt = "canonical telegram dm second";
    const secondPayload = {
      update_id: 102,
      message: {
        message_id: 2101,
        chat: { id: chatId, type: "private" },
        from: {
          id: Number(fixture.telegramUserId),
          username: "alice",
          first_name: "Alice",
        },
        text: secondPrompt,
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (
          await postWebhook({
            telegramBotId: fixture.telegramBotId,
            secret: fixture.webhookSecret,
            body: secondPayload,
          })
        ).status,
      ).toBe(200);
      await flushWaitUntilForTest();
    }

    const secondState = await telegramPostRunState(fixture, secondPrompt);
    expect(secondState.agentRun?.chatThreadId).toBe(
      firstState.agentRun?.chatThreadId,
    );
    const secondClaim = await claimTelegramRun(
      secondState.run!.id,
      runnerGroup,
    );
    expect(secondState.run?.sessionId).toBe(firstState.run?.sessionId);
    expect(secondClaim.resumeSession?.sessionId).toBe(webCliAgentSessionId);
    await completeCanonicalChatRun({
      runId: secondState.run!.id,
      sandboxToken: secondClaim.sandboxToken,
    });
    const state = await readTelegramState(fixture.telegramBotId);
    expect(
      stateRecords(state.recent_runs).filter((run) => {
        return run.promptPreview === secondPrompt;
      }),
    ).toHaveLength(1);
    expect(stateRecords(state.routes)).toContainEqual(
      expect.objectContaining({
        chatId: String(chatId),
        rootMessageId: "dm",
        chatThreadId: firstState.agentRun?.chatThreadId,
      }),
    );
  });

  it("preserves group reply chains, forum delivery, fresh mentions, and callback idempotency", async () => {
    const runnerGroup = configureCanonicalTelegramRunner();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    await seedModelPolicies({
      fixture,
      selectedModel: "claude-sonnet-5",
    });
    const telegramMocks = telegramApiMocks();
    const botUsername = `bot_${fixture.telegramBotId}`;
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

    const firstState = await telegramPostRunState(fixture, firstPrompt);
    expect(firstState.agentRun?.chatThreadId).toStrictEqual(expect.any(String));
    const admittedForum = await findTelegramChatEventByPromptFixture({
      userId: fixture.userId,
      prompt: firstPrompt,
    });
    expect(admittedForum).toMatchObject({ eventId: expect.any(String) });
    if (!admittedForum) {
      throw new Error("Expected admitted Telegram forum input event");
    }
    const forumLaunchContext = await readChatEventContextFixture(
      admittedForum.eventId,
    );
    expect(forumLaunchContext).toMatchObject({
      contextType: "telegram",
      telegramChatId: String(chatId),
      telegramMessageId: "2201",
      telegramMessageThreadId: messageThreadId,
      telegramMessageText: firstPrompt,
      telegramThreadContext: "",
      telegramRootMessageId: null,
      telegramPublicBrand: "okou",
      telegramUserLinkKind: "custom",
      telegramChatType: "supergroup",
    });
    expectExactSystemPromptFragment(
      firstState.run?.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Telegram",
        `Bot ID: ${fixture.telegramBotId}`,
        `Bot username: @${botUsername}`,
        `Chat ID: ${chatId}`,
        "Chat type: supergroup",
        "Message ID: 2201",
        `Message thread ID: ${messageThreadId}`,
      ].join("\n"),
    );
    expect(
      stateRecords((await readTelegramState(fixture.telegramBotId)).routes),
    ).toHaveLength(0);
    const firstClaim = await claimTelegramRun(firstState.run!.id, runnerGroup);
    const cliAgentSessionId = await completeCanonicalChatRun({
      runId: firstState.run!.id,
      sandboxToken: firstClaim.sandboxToken,
    });

    const completedFirstState = await telegramPostRunState(
      fixture,
      firstPrompt,
    );
    expect(
      completedFirstState.callbacks.find((callback) => {
        return callback.internalKind === "telegram:chat";
      }),
    ).toMatchObject({
      payload: expect.objectContaining({ publicBrand: "okou" }),
    });

    expect(telegramMocks.sentMessages).toHaveLength(1);
    expect(telegramMocks.sentMessages[0]).toMatchObject({
      chat_id: String(chatId),
      message_thread_id: messageThreadId,
      reply_parameters: { message_id: 2201 },
    });
    const anchoredState = await readTelegramState(fixture.telegramBotId);
    expect(stateRecords(anchoredState.routes)).toContainEqual(
      expect.objectContaining({
        chatId: String(chatId),
        rootMessageId: "700",
        chatThreadId: firstState.agentRun?.chatThreadId,
      }),
    );
    await webhooksApi.requestAgentComplete(
      {
        runId: firstState.run!.id,
        exitCode: 1,
        error: "late duplicate completion",
      },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(1);

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
            id: Number(fixture.telegramBotId),
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
    const admittedFollowUp = await findTelegramChatEventByPromptFixture({
      userId: fixture.userId,
      prompt: followUpAgentPrompt,
    });
    expect(admittedFollowUp).toMatchObject({ eventId: expect.any(String) });
    if (!admittedFollowUp) {
      throw new Error("Expected admitted Telegram forum follow-up event");
    }
    const followUpLaunchContext = await readChatEventContextFixture(
      admittedFollowUp.eventId,
    );
    expect(followUpLaunchContext).toMatchObject({
      contextType: "telegram",
      telegramMessageThreadId: messageThreadId,
      telegramMessageText: followUpAgentPrompt,
      telegramThreadContext: expect.stringContaining(firstPrompt),
      telegramRootMessageId: "700",
      telegramUserLinkKind: "custom",
      telegramChatType: "supergroup",
    });

    const followUpState = await telegramPostRunState(fixture);
    expect(followUpState.run?.prompt).toBe(followUpAgentPrompt);
    const followUpThreadContext = followUpLaunchContext?.telegramThreadContext;
    if (!followUpThreadContext) {
      throw new Error("Expected frozen Telegram forum thread context");
    }
    expectExactSystemPromptFragment(
      followUpState.run?.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Telegram",
        `Bot ID: ${fixture.telegramBotId}`,
        `Bot username: @${botUsername}`,
        `Chat ID: ${chatId}`,
        "Chat type: supergroup",
        "Message ID: 2202",
        "Root message ID: 700",
        `Message thread ID: ${messageThreadId}`,
        "",
        followUpThreadContext,
      ].join("\n"),
    );
    expect(followUpState.agentRun?.chatThreadId).toBe(
      firstState.agentRun?.chatThreadId,
    );
    const followUpClaim = await claimTelegramRun(
      followUpState.run!.id,
      runnerGroup,
    );
    expect(followUpClaim.resumeSession?.sessionId).toBe(cliAgentSessionId);
    await completeCanonicalChatRun({
      runId: followUpState.run!.id,
      sandboxToken: followUpClaim.sandboxToken,
    });
    expect(telegramMocks.sentMessages).toHaveLength(2);

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
    expect(
      stateRecords((await readTelegramState(fixture.telegramBotId)).routes),
    ).toStrictEqual([
      expect.objectContaining({
        chatId: String(chatId),
        rootMessageId: "701",
        chatThreadId: firstState.agentRun?.chatThreadId,
      }),
    ]);

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

    const freshState = await telegramPostRunState(fixture, freshPrompt);
    expect(freshState.agentRun?.chatThreadId).toStrictEqual(expect.any(String));
    expect(freshState.agentRun?.chatThreadId).not.toBe(
      firstState.agentRun?.chatThreadId,
    );
    expect(
      stateRecords((await readTelegramState(fixture.telegramBotId)).routes),
    ).toHaveLength(1);
  });

  it("keeps Telegram callbacks typed when OKOU_API_BACKEND_URL is set", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://www.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    telegramApiMocks();

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

    const runState = await telegramPostRunState(fixture);
    expect(runState.run).toBeDefined();
    expect(runState.callbacks[0]).toMatchObject({
      url: null,
      internalKind: "chat",
    });
  });

  it("stores non-addressed group messages without creating a run", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 2,
        message: {
          message_id: 99,
          chat: { id: -10_099_001, type: "group" },
          from: { id: 44_001, username: "carol", first_name: "Carol" },
          text: "ambient group chatter",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    await expect(latestRunForFixture(fixture)).resolves.toBeNull();
    const messages = stateRecords(
      (await readTelegramState(fixture.telegramBotId)).messages,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("ambient group chatter");
  });

  it("stores custom-bot group replies to another bot without sending a prompt", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    const telegramMocks = telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 22,
        message: {
          message_id: 202,
          chat: { id: -10_099_022, type: "group" },
          from: { id: 44_022, username: "carol", first_name: "Carol" },
          text: "following up",
          reply_to_message: {
            message_id: 55,
            chat: { id: -10_099_022, type: "group" },
            from: { id: 123, is_bot: true, username: "other_bot" },
            text: "message from another bot",
          },
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(0);

    const messages = stateRecords(
      (await readTelegramState(fixture.telegramBotId)).messages,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("following up");
  });

  it("preserves a mention-only Telegram request with the preceding group task", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const botUsername = `bot_${fixture.telegramBotId}`;
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

    const run = await latestRunForFixture(fixture);
    expect(run?.prompt).toBe(`@${botUsername}`);
    expect(run?.appendSystemPrompt).toContain("Chat type: supergroup");
    expect(run?.appendSystemPrompt).toContain(
      "https://example.com/broken-article",
    );
    expectExactSystemPromptFragment(
      run?.appendSystemPrompt,
      [
        "# Current Integration",
        "You are currently running inside: Telegram",
        `Bot ID: ${fixture.telegramBotId}`,
        `Bot username: @${botUsername}`,
        "Chat ID: -10099002",
        "Chat type: supergroup",
        "Message ID: 101",
      ].join("\n"),
    );
    const admitted = await findTelegramChatEventByPromptFixture({
      userId: fixture.userId,
      prompt: `@${botUsername}`,
    });
    expect(admitted).toMatchObject({ eventId: expect.any(String) });
    if (!admitted) {
      throw new Error("Expected admitted Telegram supergroup input event");
    }
    await expect(
      readChatEventContextFixture(admitted.eventId),
    ).resolves.toMatchObject({
      contextType: "telegram",
      telegramChatId: "-10099002",
      telegramMessageId: "101",
      telegramMessageThreadId: null,
      telegramMessageText: `@${botUsername}`,
      telegramThreadContext: expect.stringContaining(
        "https://example.com/broken-article",
      ),
      telegramRootMessageId: null,
      telegramUserLinkKind: "custom",
      telegramChatType: "supergroup",
      telegramSenderUsername: "@alice",
    });
  });

  it("creates an agent run for a linked official-bot private message", async () => {
    configureOfficialBotEnv();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ installBot: false, seedOfficialLink: true }),
    );
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
            id: 99_002,
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

    const run = await latestRunForFixture(fixture);
    expect(run?.prompt).toBe("run through official bot");
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
        "Root message ID: dm",
      ].join("\n"),
    );
    const admitted = await findTelegramChatEventByPromptFixture({
      userId: fixture.userId,
      prompt: "run through official bot",
    });
    expect(admitted).toMatchObject({ eventId: expect.any(String) });
    if (!admitted) {
      throw new Error("Expected admitted official Telegram input event");
    }
    await expect(
      readChatEventContextFixture(admitted.eventId),
    ).resolves.toMatchObject({
      contextType: "telegram",
      telegramMessageText: "run through official bot",
      telegramRootMessageId: "dm",
      telegramPublicBrand: "okou",
      telegramUserLinkId: expect.any(String),
      telegramUserLinkKind: "official",
      telegramChatType: "private",
      telegramSenderUserId: "99002",
      telegramSenderDisplayName: "Bob",
      telegramSenderUsername: "@bob",
      telegramSenderLanguage: "en",
    });
    await expect(latestAgentRunForFixture(fixture)).resolves.toMatchObject({
      triggerSource: "telegram",
    });
    expect((await telegramPostRunState(fixture)).callbacks[0]).toMatchObject({
      internalKind: "chat",
      payload: expect.objectContaining({ publicBrand: "okou" }),
    });
  });

  it("creates an agent run for a linked official-bot group mention", async () => {
    configureOfficialBotEnv();
    const fixture = await trackFixture(
      seedTelegramPostFixture({ installBot: false, seedOfficialLink: true }),
    );
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
            id: 99_002,
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

    const run = await latestRunForFixture(fixture);
    expect(run?.prompt).toBe(`@${OFFICIAL_BOT_USERNAME} help from a group`);
    expect(run?.appendSystemPrompt).toContain(
      "Bot username: @official_okou_bot",
    );
  });

  it("routes custom-bot commands by username target", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    const botUsername = `bot_${fixture.telegramBotId}`;
    const telegramMocks = telegramApiMocks();

    const ignored = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 6,
        message: {
          message_id: 61,
          chat: { id: -10_099_004, type: "group" },
          from: { id: 44_002, username: "carol", first_name: "Carol" },
          text: "/help@other_bot",
        },
      },
    });

    expect(ignored.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(0);

    const routed = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 7,
        message: {
          message_id: 62,
          chat: { id: -10_099_004, type: "group" },
          from: { id: 44_002, username: "carol", first_name: "Carol" },
          text: `/connect@${botUsername}`,
        },
      },
    });

    expect(routed.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(1);
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "please connect your account first",
    );
    expect(
      telegramMocks.sentMessages[0]?.reply_markup?.inline_keyboard[0]?.[0]?.url,
    ).toBe(`https://t.me/${botUsername}?start=connect`);
  });

  it("handles custom-bot connect and help command copy", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const telegramMocks = telegramApiMocks();

    const connected = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 61,
        message: {
          message_id: 611,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/connect",
        },
      },
    });
    expect(connected.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[0]?.text).toContain("already connected");
    expect(telegramMocks.sentMessages[0]?.text).toContain("Telegram Agent");

    const unlinked = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 62,
        message: {
          message_id: 612,
          chat: { id: 91_612, type: "private" },
          from: { id: 91_612, username: "unlinked", first_name: "Unlinked" },
          text: "/connect",
        },
      },
    });
    expect(unlinked.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[1]?.text).toContain(
      "To use Telegram Agent in Telegram",
    );
    const buttonUrl =
      telegramMocks.sentMessages[1]?.reply_markup?.inline_keyboard[0]?.[0]
        ?.url ?? "";
    expect(buttonUrl).toContain("http://localhost:3002/telegram/connect?bot=");
    expect(buttonUrl).toContain("tgUser=91612");
    // The branded app Host carries presentation identity; keep the signed
    // query compatible with pre-brand Telegram connect consumers.
    expect(new URL(buttonUrl).searchParams.has("brand")).toBeFalsy();

    const help = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 63,
        message: {
          message_id: 613,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/help",
        },
      },
    });
    expect(help.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[2]?.text).toContain(
      `@bot_${fixture.telegramBotId} Telegram Bot Help`,
    );
    expect(telegramMocks.sentMessages[2]?.text).toContain("/new_session");
    expect(telegramMocks.sentMessages[2]?.text).not.toContain("admin");
  });

  it("handles custom-bot disconnect command", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const telegramMocks = telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 8,
        message: {
          message_id: 71,
          chat: { id: 77_003, type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/disconnect",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const links = stateRecords(
      (await readTelegramState(fixture.telegramBotId)).links,
    );
    expect(links).toHaveLength(0);
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "You have been disconnected",
    );
  });

  it("completes a pending custom-bot link on the first private message", async () => {
    const fixture = await trackFixture(seedTelegramPostFixture({}));
    await seedPendingUserLink(fixture);
    telegramApiMocks();

    const response = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 81,
        message: {
          message_id: 811,
          chat: { id: 78_901, type: "private" },
          from: { id: 78_901, username: "admin_user", first_name: "Admin" },
          text: "hello bot",
        },
      },
    });

    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const links = stateRecords(
      (await readTelegramState(fixture.telegramBotId)).links,
    );
    expect(links).toStrictEqual([
      expect.objectContaining({
        telegramUserId: "78901",
        telegramUsername: "admin_user",
      }),
    ]);
  });

  it("clears a custom-bot canonical private thread with /new_session and ignores the command in groups", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const userLinkId = await linkedTelegramUserLinkId(fixture);
    const telegramMocks = telegramApiMocks();
    const initialPrompt = "start canonical dm";
    const initial = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 90,
        message: {
          message_id: 910,
          chat: {
            id: Number(fixture.telegramUserId),
            type: "private",
          },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: initialPrompt,
        },
      },
    });
    expect(initial.status).toBe(200);
    await flushWaitUntilForTest();
    const initialState = await telegramPostRunState(fixture, initialPrompt);
    await expect(
      findTelegramChatThreadRoute({
        userLinkId,
        ownerKind: "custom",
        chatId: fixture.telegramUserId!,
        rootMessageId: "dm",
      }),
    ).resolves.toMatchObject({
      chatThreadId: initialState.agentRun?.chatThreadId,
    });

    const group = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 91,
        message: {
          message_id: 911,
          chat: { id: -10_099_091, type: "group" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/new_session",
        },
      },
    });
    expect(group.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages).toHaveLength(0);
    await expect(
      findTelegramChatThreadRoute({
        userLinkId,
        ownerKind: "custom",
        chatId: fixture.telegramUserId!,
        rootMessageId: "dm",
      }),
    ).resolves.toMatchObject({
      chatThreadId: initialState.agentRun?.chatThreadId,
    });

    const dm = await postWebhook({
      telegramBotId: fixture.telegramBotId,
      secret: fixture.webhookSecret,
      body: {
        update_id: 92,
        message: {
          message_id: 912,
          chat: { id: Number(fixture.telegramUserId), type: "private" },
          from: {
            id: Number(fixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "/new_session",
        },
      },
    });
    expect(dm.status).toBe(200);
    await flushWaitUntilForTest();
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "New session started",
    );
    await expect(
      findTelegramChatThreadRoute({
        userLinkId,
        ownerKind: "custom",
        chatId: fixture.telegramUserId!,
        rootMessageId: "dm",
      }),
    ).resolves.toBeNull();
  });

  it("lists, updates, and rejects model command arguments", async () => {
    const fixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    await seedModelPolicies({
      fixture,
      selectedModel: "deepseek-v4-flash",
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
    expect(telegramMocks.sentMessages[0]?.text).toContain("Available models");
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "/model claude-sonnet-5",
    );
    expect(telegramMocks.sentMessages[0]?.text).toContain(
      "/model deepseek-v4-flash",
    );
    expect(telegramMocks.sentMessages[0]?.text).not.toContain("/model default");

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
    await expect(selectedModelFor(fixture)).resolves.toBe("claude-sonnet-5");

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
      "Unknown model &quot;default&quot;.",
    );
    await expect(selectedModelFor(fixture)).resolves.toBe("claude-sonnet-5");
  });

  it("sends typing for accepted custom-bot runs and a queued message at the concurrency limit", async () => {
    const acceptedFixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    const acceptedTelegramMocks = telegramApiMocks();

    const accepted = await postWebhook({
      telegramBotId: acceptedFixture.telegramBotId,
      secret: acceptedFixture.webhookSecret,
      body: {
        update_id: 111,
        message: {
          message_id: 1111,
          chat: { id: Number(acceptedFixture.telegramUserId), type: "private" },
          from: {
            id: Number(acceptedFixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "accepted telegram run",
        },
      },
    });
    expect(accepted.status).toBe(200);
    await flushWaitUntilForTest();
    expect(acceptedTelegramMocks.chatActions).toHaveLength(1);
    expect(acceptedTelegramMocks.sentMessages).toHaveLength(0);

    const queuedFixture = await trackFixture(
      seedTelegramPostFixture({ linkTelegramUser: true }),
    );
    await seedRunningRun(queuedFixture);
    const queuedTelegramMocks = telegramApiMocks();

    const queued = await postWebhook({
      telegramBotId: queuedFixture.telegramBotId,
      secret: queuedFixture.webhookSecret,
      body: {
        update_id: 112,
        message: {
          message_id: 1112,
          chat: { id: Number(queuedFixture.telegramUserId), type: "private" },
          from: {
            id: Number(queuedFixture.telegramUserId),
            username: "alice",
            first_name: "Alice",
          },
          text: "queued telegram run",
        },
      },
    });
    expect(queued.status).toBe(200);
    await flushWaitUntilForTest();
    expect(queuedTelegramMocks.chatActions).toHaveLength(1);
    expect(queuedTelegramMocks.sentMessages[0]?.text).toContain("Run queued");
    expect(queuedTelegramMocks.sentMessages[0]?.text).toContain(
      "concurrency limit reached",
    );
  });

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
