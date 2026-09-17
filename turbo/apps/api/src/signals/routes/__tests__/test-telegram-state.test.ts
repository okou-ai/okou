import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import type {
  TestSlackStatePostResponse,
  TestSlackStateResponse,
} from "@okouai/api-contracts/contracts/test-slack-state";
import type {
  TestTelegramStateResponse,
  TestTelegramStateSeedResponse,
} from "@okouai/api-contracts/contracts/test-telegram-state";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-context";
import { withBuiltInModelRuntimeRouteUnavailableForTest } from "../../../test-fixtures/built-in-model-runtime-route";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testSlackStateRoutes } from "../test-slack-state";
import { testTelegramStateRoutes } from "../test-telegram-state";
import { integrationsTelegramRoutes } from "../integrations-telegram";
import { seedRun$ } from "./helpers/usage-state";
import { createFixtureTracker } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const store = createStore();
const TELEGRAM_STATE_ROUTE = "/api/test/telegram-state";
const SLACK_STATE_ROUTE = "/api/test/slack-state";
const TELEGRAM_TEST_BOT_TOKEN = "123456:e2e-test-bot-token";
const TELEGRAM_TEST_API_BASE_URL = "https://telegram.test/bot";

interface TelegramFixture {
  readonly botId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly telegramUserId: string;
  readonly defaultAgentId: string;
  readonly webhookSecret: string;
}

interface SlackFixture {
  readonly teamId: string;
  readonly slackUserId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly defaultAgentId: string;
}

interface RecentRun {
  readonly id: string;
  readonly triggerSource: string | null;
  readonly promptPreview: string | null;
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...testTelegramStateRoutes,
      ...integrationsTelegramRoutes,
      ...testSlackStateRoutes,
    ],
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function uniqueNumericId(): string {
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recentRuns(value: readonly unknown[]): RecentRun[] {
  return value.filter((run): run is RecentRun => {
    return (
      isRecord(run) &&
      typeof run.id === "string" &&
      (typeof run.triggerSource === "string" || run.triggerSource === null) &&
      (typeof run.promptPreview === "string" || run.promptPreview === null)
    );
  });
}

function mockClerkTestUser(args: {
  readonly userId: string;
  readonly orgId: string;
}): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: args.userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        createdAt: 2,
        organization: { id: uniqueId("org_ignored") },
      },
      {
        createdAt: 1,
        organization: { id: args.orgId },
      },
    ],
  });
}

function mockTelegramApi(): void {
  server.use(
    ...[
      `https://api.telegram.org/bot${TELEGRAM_TEST_BOT_TOKEN}/sendChatAction`,
      `${TELEGRAM_TEST_API_BASE_URL}${TELEGRAM_TEST_BOT_TOKEN}/sendChatAction`,
    ].map((url) => {
      return http.post(url, () => {
        return HttpResponse.json({ ok: true, result: true });
      });
    }),
    ...[
      `https://api.telegram.org/bot${TELEGRAM_TEST_BOT_TOKEN}/sendMessage`,
      `${TELEGRAM_TEST_API_BASE_URL}${TELEGRAM_TEST_BOT_TOKEN}/sendMessage`,
    ].map((url) => {
      return http.post(url, () => {
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: 700,
            chat: { id: 123, type: "private" },
            text: "queued",
          },
        });
      });
    }),
  );
}

function postTelegramState(body: Record<string, unknown>): Promise<Response> {
  return requestApp(TELEGRAM_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postSlackState(body: Record<string, unknown>): Promise<Response> {
  return requestApp(SLACK_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readTelegramState(
  botId: string,
): Promise<TestTelegramStateResponse> {
  const response = await requestApp(
    `${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(botId)}`,
  );
  expect(response.status).toBe(200);
  return await readJson<TestTelegramStateResponse>(response);
}

async function readSlackState(teamId: string): Promise<TestSlackStateResponse> {
  const response = await requestApp(
    `${SLACK_STATE_ROUTE}?team_id=${encodeURIComponent(teamId)}`,
  );
  expect(response.status).toBe(200);
  return await readJson<TestSlackStateResponse>(response);
}

async function deleteTelegramFixture(
  fixture: Pick<TelegramFixture, "botId">,
): Promise<void> {
  mockEnv("ENV", "development");
  await requestApp(
    `${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(fixture.botId)}`,
    { method: "DELETE" },
  );
}

async function deleteSlackFixture(fixture: SlackFixture): Promise<void> {
  mockEnv("ENV", "development");
  await requestApp(
    `${SLACK_STATE_ROUTE}?team_id=${encodeURIComponent(fixture.teamId)}`,
    { method: "DELETE" },
  );
}

const trackTelegramFixture = createFixtureTracker(deleteTelegramFixture);
const trackSlackFixture = createFixtureTracker(deleteSlackFixture);

async function seedTelegramFixture(
  args: {
    readonly userId?: string;
    readonly orgId?: string;
    readonly botId?: string;
    readonly telegramUserId?: string;
    readonly email?: string;
    readonly seedLink?: boolean;
  } = {},
): Promise<TelegramFixture> {
  const userId = args.userId ?? uniqueId("user");
  const orgId = args.orgId ?? uniqueId("org");
  const botId = args.botId ?? uniqueId("bot");
  const telegramUserId = args.telegramUserId ?? uniqueNumericId();
  const webhookSecret = "custom-webhook-secret";
  mockClerkTestUser({ userId, orgId });

  const response = await postTelegramState({
    bot_id: botId,
    telegram_user_id: telegramUserId,
    bot_username: "custom_test_bot",
    webhook_secret: webhookSecret,
    email: args.email ?? `${userId}@example.test`,
    seed_link: args.seedLink ?? true,
  });
  expect(response.status).toBe(200);
  const body = await readJson<TestTelegramStateSeedResponse>(response);
  const fixture = {
    botId: body.bot_id,
    userId: body.user_id,
    orgId: body.org_id,
    telegramUserId,
    defaultAgentId: body.default_agent_id,
    webhookSecret,
  };
  await trackTelegramFixture(Promise.resolve(fixture));
  return fixture;
}

async function seedSlackFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
}): Promise<SlackFixture> {
  const teamId = uniqueId("T");
  const slackUserId = uniqueId("U");
  mockClerkTestUser({ userId: args.userId, orgId: args.orgId });

  const response = await postSlackState({
    team_id: teamId,
    slack_user_id: slackUserId,
    email: args.email,
    seed_connection: true,
    seed_default_agent: true,
  });
  expect(response.status).toBe(200);
  const body = await readJson<TestSlackStatePostResponse>(response);
  if (!body.default_agent_id) {
    throw new Error("Expected Slack fixture to include a default agent");
  }
  const fixture = {
    teamId,
    slackUserId,
    userId: body.user_id,
    orgId: body.org_id,
    defaultAgentId: body.default_agent_id,
  };
  await trackSlackFixture(Promise.resolve(fixture));
  return fixture;
}

async function dispatchTelegramMessage(args: {
  readonly fixture: TelegramFixture;
  readonly chatId?: string;
  readonly text: string;
  readonly messageId?: number;
}): Promise<void> {
  const actor = createBddApi(context).user({
    userId: args.fixture.userId,
    orgId: args.fixture.orgId,
  });
  const runs = createRunsApi(context);
  // Own the provider and initialize storage downloads so dispatch does not
  // depend on another test's shared model keys or mock teardown.
  await runs.ensureOrgModelProvider(actor);
  runs.acceptStorageDownloads();
  context.mocks.s3.send.mockResolvedValue({});
  runs.configureRunnerGroup();
  mockEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  mockOptionalEnv("OKOU_WEB_URL", "http://localhost:3000");
  mockEnv("APP_URL", "http://localhost:3002");
  mockTelegramApi();
  const chatId = args.chatId ?? "900100200";
  const response = await requestApp(
    `/api/telegram/webhook/${encodeURIComponent(args.fixture.botId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": args.fixture.webhookSecret,
      },
      body: JSON.stringify({
        update_id: args.messageId ?? 501,
        message: {
          message_id: args.messageId ?? 501,
          chat: { id: Number(chatId), type: "private" },
          from: {
            id: Number(args.fixture.telegramUserId),
            first_name: "Telegram",
          },
          text: args.text,
        },
      }),
    },
  );
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("OK");
  await flushWaitUntilForTest();
}

async function dispatchSlackMessage(args: {
  readonly fixture: SlackFixture;
  readonly text: string;
}): Promise<void> {
  await store.set(
    seedRun$,
    {
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      composeId: args.fixture.defaultAgentId,
      triggerSource: "slack",
      prompt: args.text,
    },
    context.signal,
  );
}
describe("GET /api/test/telegram-state", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(`${TELEGRAM_STATE_ROUTE}?bot_id=bot-1`);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns 400 when bot_id is missing", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(TELEGRAM_STATE_ROUTE);

    expect(response.status).toBe(400);
    await expect(readJson<{ error: string }>(response)).resolves.toStrictEqual({
      error: "bot_id query param is required",
    });
  });

  it("returns empty diagnostic state for an unknown bot", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(
      `${TELEGRAM_STATE_ROUTE}?bot_id=${uniqueId("bot")}`,
    );

    expect(response.status).toBe(200);
    const body = await readJson<TestTelegramStateResponse>(response);
    expect(body.installation).toBeNull();
    expect(body.links).toStrictEqual([]);
    expect(body.message_count).toBe(0);
    expect(body.recent_runs).toStrictEqual([]);
    expect(body.org_metadata).toBeNull();
    expect(body.default_agent).toBeNull();
  });

  it("returns seeded Telegram diagnostic state without built-in model keys", async () => {
    mockEnv("ENV", "development");
    mockOptionalEnv("TELEGRAM_API_URL", TELEGRAM_TEST_API_BASE_URL);
    const fixture = await seedTelegramFixture();
    const chatId = uniqueNumericId();
    await withBuiltInModelRuntimeRouteUnavailableForTest(
      "claude-sonnet-5",
      async () => {
        await dispatchTelegramMessage({
          fixture,
          chatId,
          text: "telegram state diagnostic run",
        });
      },
    );

    const body = await readTelegramState(fixture.botId);

    expect(body.installation).toMatchObject({
      telegramBotId: fixture.botId,
      orgId: fixture.orgId,
      defaultAgentId: fixture.defaultAgentId,
    });
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({
      telegramUserId: fixture.telegramUserId,
      dmWelcomeSent: false,
    });
    expect(body.message_count).toBe(1);
    expect(recentRuns(body.recent_runs)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: null,
          triggerSource: "telegram",
          promptPreview: "telegram state diagnostic run",
        }),
      ]),
    );
    expect(body.org_metadata).toMatchObject({
      orgId: fixture.orgId,
      defaultAgentId: fixture.defaultAgentId,
      tier: "free",
    });
    expect(body.default_agent).toMatchObject({
      id: fixture.defaultAgentId,
      name: "e2e-slack-agent",
      orgId: fixture.orgId,
    });
  });
});

describe("POST /api/test/telegram-state", () => {
  beforeEach(() => {
    context.mocks.clerk.users.getUserList.mockReset();
    context.mocks.clerk.users.getOrganizationMembershipList.mockReset();
  });

  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await postTelegramState({
      bot_id: "bot-disabled",
      telegram_user_id: "telegram-user",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns 400 when required seed fields are missing", async () => {
    mockEnv("ENV", "development");

    const response = await postTelegramState({ bot_id: "bot-missing-user" });

    expect(response.status).toBe(400);
    await expect(readJson<{ error: string }>(response)).resolves.toStrictEqual({
      error: "bot_id and telegram_user_id are required",
    });
  });

  it("seeds a Telegram installation, user link, and shared default agent", async () => {
    mockEnv("ENV", "development");
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const botId = uniqueId("bot");
    const telegramUserId = uniqueId("telegram");
    const email = `${randomUUID()}@example.test`;
    mockClerkTestUser({ userId, orgId });

    const response = await postTelegramState({
      bot_id: botId,
      telegram_user_id: telegramUserId,
      bot_username: "custom_test_bot",
      webhook_secret: "custom-webhook-secret",
      email,
    });

    expect(response.status).toBe(200);
    const body = await readJson<TestTelegramStateSeedResponse>(response);
    await trackTelegramFixture(
      Promise.resolve({
        botId,
        userId,
        orgId,
        telegramUserId,
        defaultAgentId: body.default_agent_id,
      }),
    );
    expect(body).toMatchObject({
      ok: true,
      bot_id: botId,
      org_id: orgId,
      user_id: userId,
      default_agent_id: expect.any(String),
    });
    expect(body.user_link_id).toStrictEqual(expect.any(String));
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: [email],
    });

    const state = await readTelegramState(botId);
    expect(state.installation).toMatchObject({
      telegramBotId: botId,
      botUsername: "custom_test_bot",
      orgId,
      defaultAgentId: body.default_agent_id,
      ownerUserId: userId,
    });
    expect(state.links).toHaveLength(1);
    expect(state.links[0]).toMatchObject({
      id: body.user_link_id,
      telegramUserId,
      userId: userId,
    });
    expect(state.org_metadata).toMatchObject({
      orgId,
      defaultAgentId: body.default_agent_id,
      credits: 10_000,
      tier: "free",
    });
    expect(state.default_agent).toMatchObject({
      id: body.default_agent_id,
      name: "e2e-slack-agent",
      orgId,
    });
  });

  it("keeps POST idempotent and skips link creation when requested", async () => {
    mockEnv("ENV", "development");
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const botId = uniqueId("bot");
    const telegramUserId = uniqueId("telegram");
    const email = `${userId}@example.test`;
    mockClerkTestUser({ userId, orgId });

    const first = await postTelegramState({
      bot_id: botId,
      telegram_user_id: telegramUserId,
      email,
    });
    expect(first.status).toBe(200);
    const firstBody = await readJson<TestTelegramStateSeedResponse>(first);
    await trackTelegramFixture(
      Promise.resolve({
        botId,
        userId,
        orgId,
        telegramUserId,
        defaultAgentId: firstBody.default_agent_id,
      }),
    );

    const second = await postTelegramState({
      bot_id: botId,
      telegram_user_id: telegramUserId,
      email,
      seed_link: false,
    });
    expect(second.status).toBe(200);
    const secondBody = await readJson<TestTelegramStateSeedResponse>(second);
    expect(secondBody).toMatchObject({
      bot_id: botId,
      org_id: orgId,
      user_id: userId,
      user_link_id: null,
      default_agent_id: firstBody.default_agent_id,
    });

    const state = await readTelegramState(botId);
    expect(state.links).toHaveLength(1);
    expect(state.links[0]).toMatchObject({ id: firstBody.user_link_id });
  });

  it("reuses the shared default agent when Telegram preflights race", async () => {
    mockEnv("ENV", "development");
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const botId = uniqueId("bot");
    const email = `${randomUUID()}@example.test`;
    mockClerkTestUser({ userId, orgId });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => {
        return postTelegramState({
          bot_id: botId,
          telegram_user_id: "99001",
          email,
          seed_link: true,
        });
      }),
    );

    const bodies = await Promise.all(
      responses.map(async (response) => {
        if (response.status !== 200) {
          throw new Error(
            `Expected 200, got ${response.status}: ${await response.text()}`,
          );
        }
        return readJson<TestTelegramStateSeedResponse>(response);
      }),
    );
    const defaultAgentIds = bodies.map((body) => {
      return body.default_agent_id;
    });
    const defaultAgentId = defaultAgentIds[0];
    if (!defaultAgentId) {
      throw new Error("Expected seeded default agent id");
    }
    await trackTelegramFixture(
      Promise.resolve({
        botId,
        userId,
        orgId,
        telegramUserId: "99001",
        defaultAgentId,
      }),
    );

    expect(new Set(defaultAgentIds).size).toBe(1);
    const state = await readTelegramState(botId);
    expect(state.default_agent).toMatchObject({ id: defaultAgentId });
    expect(state.links).toHaveLength(1);
  });

  it("reuses the shared default agent when Slack and Telegram preflights race", async () => {
    mockEnv("ENV", "development");
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const teamId = uniqueId("T");
    const botId = uniqueId("bot");
    const email = `${randomUUID()}@example.test`;
    mockClerkTestUser({ userId, orgId });

    const responses = await Promise.all([
      postSlackState({
        team_id: teamId,
        slack_user_id: "U_TELEGRAM_RACE",
        email,
        seed_connection: true,
        seed_default_agent: true,
      }),
      postTelegramState({
        bot_id: botId,
        telegram_user_id: "99001",
        email,
        seed_link: true,
      }),
    ]);

    const bodies = await Promise.all(
      responses.map(async (response) => {
        if (response.status !== 200) {
          throw new Error(
            `Expected 200, got ${response.status}: ${await response.text()}`,
          );
        }
        return (await response.json()) as {
          readonly default_agent_id: string | null;
        };
      }),
    );
    const defaultAgentIds = bodies.map((body) => {
      return body.default_agent_id;
    });
    const defaultAgentId = defaultAgentIds[0];
    if (!defaultAgentId) {
      throw new Error("Expected seeded default agent id");
    }
    await trackSlackFixture(
      Promise.resolve({
        teamId,
        slackUserId: "U_TELEGRAM_RACE",
        userId,
        orgId,
        defaultAgentId,
      }),
    );
    await trackTelegramFixture(
      Promise.resolve({
        botId,
        userId,
        orgId,
        telegramUserId: "99001",
        defaultAgentId,
      }),
    );

    expect(new Set(defaultAgentIds).size).toBe(1);
    expect(defaultAgentIds).not.toContain(null);
  });
});

describe("DELETE /api/test/telegram-state", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(`${TELEGRAM_STATE_ROUTE}?bot_id=bot-1`, {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns 400 when bot_id is missing", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(TELEGRAM_STATE_ROUTE, {
      method: "DELETE",
    });

    expect(response.status).toBe(400);
    await expect(readJson<{ error: string }>(response)).resolves.toStrictEqual({
      error: "bot_id query param is required",
    });
  });

  it("returns ok for an unknown bot without deleting unrelated state", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedTelegramFixture();

    const response = await requestApp(
      `${TELEGRAM_STATE_ROUTE}?bot_id=${uniqueId("missing")}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    await expect(readJson<{ ok: true }>(response)).resolves.toStrictEqual({
      ok: true,
    });
    const state = await readTelegramState(fixture.botId);
    expect(state.installation).toMatchObject({ telegramBotId: fixture.botId });
    expect(state.links).toHaveLength(1);
  });

  it("deletes Telegram state and only Telegram-triggered runs for the bot org", async () => {
    mockEnv("ENV", "development");
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const email = `${userId}@example.test`;
    const telegram = await seedTelegramFixture({ userId, orgId, email });
    await dispatchTelegramMessage({
      fixture: telegram,
      text: "telegram diagnostic run",
    });
    const slack = await seedSlackFixture({ userId, orgId, email });
    await dispatchSlackMessage({
      fixture: slack,
      text: "slack diagnostic run",
    });

    const response = await requestApp(
      `${TELEGRAM_STATE_ROUTE}?bot_id=${telegram.botId}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    await expect(readJson<{ ok: true }>(response)).resolves.toStrictEqual({
      ok: true,
    });
    const deletedTelegram = await readTelegramState(telegram.botId);
    expect(deletedTelegram.installation).toBeNull();
    expect(deletedTelegram.links).toStrictEqual([]);
    expect(deletedTelegram.message_count).toBe(0);
    expect(deletedTelegram.recent_runs).toStrictEqual([]);

    const slackState = await readSlackState(slack.teamId);
    expect(recentRuns(slackState.recent_runs)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerSource: "slack",
          promptPreview: "slack diagnostic run",
        }),
      ]),
    );
  });
});
