import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import type {
  TestSlackStateDeleteResponse,
  TestSlackStatePostResponse,
  TestSlackStateResponse,
} from "@okouai/api-contracts/contracts/test-slack-state";
import type {
  TestTelegramStateResponse,
  TestTelegramStateSeedResponse,
} from "@okouai/api-contracts/contracts/test-telegram-state";
import { describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testSlackStateRoutes } from "../slack-state-preview";
import { testTelegramStateRoutes } from "../test-telegram-state";
import { seedRun$ } from "./helpers/usage-state";
import { createFixtureTracker } from "./helpers/route-test";

const context = testContext();
const store = createStore();

const SLACK_STATE_ROUTE = "/api/test/slack-state";
const TELEGRAM_STATE_ROUTE = "/api/test/telegram-state";

interface SlackFixture {
  readonly teamId: string;
  readonly slackUserId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string | null;
  readonly defaultAgentId: string | null;
}

interface TelegramFixture {
  readonly botId: string;
  readonly telegramUserId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly defaultAgentId: string;
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function uniqueId(prefix: string): string {
  return `${prefix}_${suffix()}`;
}

function uniqueNumericId(): string {
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [...testSlackStateRoutes, ...testTelegramStateRoutes],
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function postSlackState(body: unknown): Promise<Response> {
  return requestApp(SLACK_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postTelegramState(body: unknown): Promise<Response> {
  return requestApp(TELEGRAM_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readSlackState(teamId: string): Promise<TestSlackStateResponse> {
  const response = await requestApp(
    `${SLACK_STATE_ROUTE}?team_id=${encodeURIComponent(teamId)}`,
  );
  expect(response.status).toBe(200);
  return await readJson<TestSlackStateResponse>(response);
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

function mockTestUserMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      { createdAt: 20, organization: { id: uniqueId("org_later") } },
      { createdAt: 10, organization: { id: orgId } },
    ],
  });
}

async function deleteSlackFixture(fixture: SlackFixture): Promise<void> {
  mockEnv("ENV", "development");
  await requestApp(
    `${SLACK_STATE_ROUTE}?team_id=${encodeURIComponent(fixture.teamId)}`,
    { method: "DELETE" },
  );
}

async function deleteTelegramFixture(fixture: TelegramFixture): Promise<void> {
  mockEnv("ENV", "development");
  await requestApp(
    `${TELEGRAM_STATE_ROUTE}?bot_id=${encodeURIComponent(fixture.botId)}`,
    { method: "DELETE" },
  );
}

const trackSlackFixture = createFixtureTracker(deleteSlackFixture);
const trackTelegramFixture = createFixtureTracker(deleteTelegramFixture);

async function seedSlackFixture(
  options: {
    readonly seedConnection?: boolean;
    readonly seedDefaultAgent?: boolean;
    readonly workspaceName?: string;
    readonly botUserId?: string;
    readonly teamId?: string;
    readonly slackUserId?: string;
    readonly userId?: string;
    readonly orgId?: string;
    readonly email?: string;
  } = {},
): Promise<SlackFixture> {
  const userId = options.userId ?? uniqueId("user");
  const orgId = options.orgId ?? uniqueId("org");
  const teamId = options.teamId ?? uniqueId("T");
  const slackUserId = options.slackUserId ?? uniqueId("U");
  const email = options.email ?? `${userId}@example.test`;
  mockTestUserMembership(userId, orgId);

  const response = await postSlackState({
    team_id: teamId,
    slack_user_id: slackUserId,
    workspace_name: options.workspaceName,
    bot_user_id: options.botUserId,
    email,
    seed_connection: options.seedConnection,
    seed_default_agent: options.seedDefaultAgent,
  });
  const body = await readJson<TestSlackStatePostResponse>(response);
  if (response.status !== 200) {
    throw new Error(
      `Expected Slack state seed to succeed, received ${
        response.status
      }: ${JSON.stringify(body)}`,
    );
  }

  const fixture = {
    teamId: body.team_id,
    slackUserId,
    orgId: body.org_id,
    userId: body.user_id,
    connectionId: body.connection_id,
    defaultAgentId: body.default_agent_id,
  };
  await trackSlackFixture(Promise.resolve(fixture));
  return fixture;
}

async function seedTelegramFixture(options: {
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
}): Promise<TelegramFixture> {
  const botId = uniqueId("bot");
  const telegramUserId = uniqueNumericId();
  mockTestUserMembership(options.userId, options.orgId);

  const response = await postTelegramState({
    bot_id: botId,
    telegram_user_id: telegramUserId,
    email: options.email,
    seed_link: true,
  });
  const body = await readJson<TestTelegramStateSeedResponse>(response);
  if (response.status !== 200) {
    throw new Error(
      `Expected Telegram state seed to succeed, received ${
        response.status
      }: ${JSON.stringify(body)}`,
    );
  }

  const fixture = {
    botId: body.bot_id,
    telegramUserId,
    orgId: body.org_id,
    userId: body.user_id,
    defaultAgentId: body.default_agent_id,
  };
  await trackTelegramFixture(Promise.resolve(fixture));
  return fixture;
}

async function dispatchSlackMessage(args: {
  readonly fixture: SlackFixture;
  readonly text: string;
}): Promise<void> {
  if (!args.fixture.defaultAgentId) {
    throw new Error("Expected Slack fixture to include a default agent");
  }
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

async function dispatchTelegramMessage(args: {
  readonly fixture: TelegramFixture;
  readonly text: string;
}): Promise<void> {
  await store.set(
    seedRun$,
    {
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      composeId: args.fixture.defaultAgentId,
      triggerSource: "telegram",
      prompt: args.text,
    },
    context.signal,
  );
}

describe("GET /api/test/slack-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_DENIED`);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires the preview bypass secret in preview", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const denied = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_PREVIEW`, {
      headers: { "x-vercel-protection-bypass": "wrong" },
    });
    const allowed = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_PREVIEW`, {
      headers: { "x-vercel-protection-bypass": "preview-secret" },
    });

    expect(denied.status).toBe(404);
    await expect(denied.text()).resolves.toBe("Not found");
    expect(allowed.status).toBe(200);
  });

  it("requires team_id", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(SLACK_STATE_ROUTE);

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "team_id or org_id query param is required",
    });
  });

  it("returns empty workspace diagnostics for an unknown team", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_UNKNOWN`);
    const body = await readJson<TestSlackStateResponse>(response);

    expect(response.status).toBe(200);
    expect(body.installation).toBeNull();
    expect(body.connections).toStrictEqual([]);
    expect(body.pending_chat_events).toStrictEqual([]);
    expect(body.recent_runs).toStrictEqual([]);
    expect(body.org_metadata).toBeNull();
    expect(body.default_agent).toBeNull();
  });

  it("returns Slack installation diagnostics, recent runs, and default agent metadata", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({
      seedConnection: true,
      seedDefaultAgent: true,
      workspaceName: "E2E Slack Workspace",
      botUserId: "U_BOT",
    });
    await dispatchSlackMessage({
      fixture,
      text: "hello from slack diagnostics",
    });
    const body = await readSlackState(fixture.teamId);

    expect(body.installation).toMatchObject({
      slackWorkspaceId: fixture.teamId,
      slackWorkspaceName: "E2E Slack Workspace",
      orgId: fixture.orgId,
      botUserId: "U_BOT",
      installedByUserId: fixture.userId,
    });
    expect(typeof body.installation?.createdAt).toBe("string");
    expect(body.connections).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.connectionId,
          slackUserId: fixture.slackUserId,
          userId: fixture.userId,
          dmWelcomeSent: false,
        }),
      ]),
    );
    expect(body.recent_runs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          triggerSource: "slack",
          userId: fixture.userId,
          error: null,
          promptPreview: "hello from slack diagnostics",
        }),
      ]),
    );
    expect(body.org_metadata).toMatchObject({
      orgId: fixture.orgId,
      defaultAgentId: fixture.defaultAgentId,
      credits: 10_000,
      tier: "free",
    });
    expect(body.default_agent).toStrictEqual({
      id: fixture.defaultAgentId,
      name: "e2e-slack-agent",
      orgId: fixture.orgId,
    });
  });
});

describe("POST /api/test/slack-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await postSlackState({
      team_id: "T_DENIED",
      slack_user_id: "U_DENIED",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires team_id and slack_user_id", async () => {
    mockEnv("ENV", "development");

    const response = await postSlackState({
      team_id: "T_MISSING_USER",
      seed_connection: true,
    });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "team_id and slack_user_id are required to seed a connection",
    });
  });

  it("seeds a Slack installation without optional state", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({
      workspaceName: "Seeded Workspace",
      botUserId: "U_CUSTOM_BOT",
    });

    expect(fixture.connectionId).toBeNull();
    expect(fixture.defaultAgentId).toBeNull();
    const state = await readSlackState(fixture.teamId);
    expect(state.installation).toMatchObject({
      slackWorkspaceId: fixture.teamId,
      slackWorkspaceName: "Seeded Workspace",
      orgId: fixture.orgId,
      botUserId: "U_CUSTOM_BOT",
      installedByUserId: fixture.userId,
    });
    expect(state.connections).toStrictEqual([]);
    expect(state.org_metadata).toBeNull();
    expect(state.default_agent).toBeNull();
  });

  it("optionally seeds a Slack connection", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({ seedConnection: true });

    expect(typeof fixture.connectionId).toBe("string");
    expect(fixture.defaultAgentId).toBeNull();
    const state = await readSlackState(fixture.teamId);
    expect(state.connections).toStrictEqual([
      expect.objectContaining({
        id: fixture.connectionId,
        slackUserId: fixture.slackUserId,
        userId: fixture.userId,
        dmWelcomeSent: false,
      }),
    ]);
  });

  it("optionally seeds the default Slack agent", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({ seedDefaultAgent: true });

    expect(typeof fixture.defaultAgentId).toBe("string");
    expect(fixture.connectionId).toBeNull();
    const state = await readSlackState(fixture.teamId);
    expect(state.default_agent).toStrictEqual({
      id: fixture.defaultAgentId,
      orgId: fixture.orgId,
      name: "e2e-slack-agent",
    });
    expect(state.org_metadata).toMatchObject({
      orgId: fixture.orgId,
      defaultAgentId: fixture.defaultAgentId,
      credits: 10_000,
      tier: "free",
    });
  });

  it("is idempotent for existing installations, connections, and default agents", async () => {
    mockEnv("ENV", "development");
    const id = suffix();
    const teamId = `T_IDEMPOTENT_${id}`;
    const slackUserId = `U_IDEMPOTENT_${id}`;
    const orgId = `org_idempotent_${id}`;
    const userId = `user_idempotent_${id}`;
    const email = `${userId}@example.test`;
    mockTestUserMembership(userId, orgId);

    const firstResponse = await postSlackState({
      team_id: teamId,
      slack_user_id: slackUserId,
      email,
      seed_connection: true,
      seed_default_agent: true,
    });
    const first = await readJson<TestSlackStatePostResponse>(firstResponse);
    const fixture = await trackSlackFixture(
      Promise.resolve({
        teamId,
        slackUserId,
        orgId,
        userId,
        connectionId: first.connection_id,
        defaultAgentId: first.default_agent_id,
      }),
    );
    context.mocks.clerk.users.getUserList.mockRejectedValue(
      new Error("Clerk rate limited"),
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockRejectedValue(
      new Error("Clerk rate limited"),
    );
    const secondResponse = await postSlackState({
      team_id: teamId,
      slack_user_id: slackUserId,
      email,
      seed_connection: true,
      seed_default_agent: true,
    });
    const second = await readJson<TestSlackStatePostResponse>(secondResponse);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(typeof first.connection_id).toBe("string");
    expect(typeof first.default_agent_id).toBe("string");
    expect(second.connection_id).toBeNull();
    expect(second.default_agent_id).toBe(first.default_agent_id);

    const state = await readSlackState(fixture.teamId);
    expect(state.installation).toMatchObject({
      slackWorkspaceId: teamId,
      orgId,
      installedByUserId: userId,
    });
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({ id: first.connection_id });
    expect(state.default_agent).toMatchObject({ id: first.default_agent_id });
    expect(state.org_metadata).toMatchObject({
      orgId,
      defaultAgentId: first.default_agent_id,
      credits: 10_000,
    });
  });
});

describe("DELETE /api/test/slack-state", () => {
  it("returns 404 outside allowed test environments", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(`${SLACK_STATE_ROUTE}?team_id=T_DENIED`, {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("requires team_id", async () => {
    mockEnv("ENV", "development");

    const response = await requestApp(SLACK_STATE_ROUTE, { method: "DELETE" });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toStrictEqual({
      error: "team_id or org_id query param is required",
    });
  });

  it("clears workspace Slack state without deleting non-Slack runs", async () => {
    mockEnv("ENV", "development");
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const email = `${userId}@example.test`;
    const slack = await seedSlackFixture({
      userId,
      orgId,
      email,
      seedConnection: true,
      seedDefaultAgent: true,
    });
    await dispatchSlackMessage({
      fixture: slack,
      text: "slack diagnostic run",
    });
    const telegram = await seedTelegramFixture({ userId, orgId, email });
    await dispatchTelegramMessage({
      fixture: telegram,
      text: "telegram diagnostic run",
    });

    const response = await requestApp(
      `${SLACK_STATE_ROUTE}?team_id=${slack.teamId}`,
      { method: "DELETE" },
    );
    const body = await readJson<TestSlackStateDeleteResponse>(response);

    expect(response.status).toBe(200);
    expect(body).toStrictEqual({ ok: true });

    const deletedSlack = await readSlackState(slack.teamId);
    expect(deletedSlack.installation).toBeNull();
    expect(deletedSlack.connections).toStrictEqual([]);
    expect(deletedSlack.recent_runs).toStrictEqual([]);

    const telegramState = await readTelegramState(telegram.botId);
    expect(telegramState.recent_runs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerSource: "telegram",
          promptPreview: "telegram diagnostic run",
        }),
      ]),
    );
    expect(telegramState.recent_runs).not.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerSource: "slack",
          promptPreview: "slack diagnostic run",
        }),
      ]),
    );
  });

  it("clears API-visible default Slack agent state after delete", async () => {
    mockEnv("ENV", "development");
    const fixture = await seedSlackFixture({ seedDefaultAgent: true });
    const seededState = await readSlackState(fixture.teamId);

    expect(seededState.default_agent).toMatchObject({
      id: fixture.defaultAgentId,
    });

    const deleteResponse = await requestApp(
      `${SLACK_STATE_ROUTE}?team_id=${fixture.teamId}`,
      { method: "DELETE" },
    );

    expect(deleteResponse.status).toBe(200);
    await expect(readJson(deleteResponse)).resolves.toStrictEqual({
      ok: true,
    });
    const deletedState = await readSlackState(fixture.teamId);
    expect(deletedState.installation).toBeNull();
    expect(deletedState.default_agent).toBeNull();
  });
});
