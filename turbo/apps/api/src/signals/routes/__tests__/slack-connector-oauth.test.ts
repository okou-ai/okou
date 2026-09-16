import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { http, HttpResponse } from "msw";
import { aroundEach, beforeEach, expect, onTestFinished, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now, withNowScopeForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { integrationsSlackRoutes } from "../integrations-slack";
import { slackConnectRoutes } from "../slack-connect";
import { slackOauthRoutes } from "../slack-oauth";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRouteMocks } from "./helpers/route-test";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";
import {
  readGetStartedStatus,
  setGetStartedEnabled,
} from "./helpers/get-started";

const context = testContext();
const mocks = createRouteMocks(context);
const API_ORIGIN = "https://api.okou.ai";
const headers = { authorization: "Bearer clerk-session" } as const;
const target = { kind: "builtin", connectorSlug: "slack" } as const;
const routes = [
  ...slackOauthRoutes,
  ...slackConnectRoutes,
  ...integrationsSlackRoutes,
  ...connectorAccountRoutes,
  ...connectorsSlugCallbackRoutes,
] as const;

aroundEach(async (runTest) => {
  await withNowScopeForTest(runTest);
});

function clients(signal?: AbortSignal) {
  return setupApp({ context, routes, baseUrl: API_ORIGIN, signal });
}

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: "org:admin" | "org:member";
  readonly email: string;
  readonly workspaceId: string;
  readonly slackUserId: string;
}

function authenticate(actor: Actor): void {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  mockClerkMembership(context, actor, actor.orgRole);
}

async function accounts() {
  const result = await accept(
    clients()(connectorAccountsContract).connections({
      headers,
      query: target,
    }),
    [200],
  );
  return result.body.connections;
}

async function integrationStatus() {
  return (
    await accept(
      clients()(integrationsSlackContract).getStatus({ headers }),
      [200],
    )
  ).body;
}

function actor(overrides: Partial<Actor> = {}): Actor {
  const suffix = randomUUID();
  const result: Actor = {
    userId: `user_${suffix}`,
    orgId: `org_${suffix}`,
    orgRole: "org:admin",
    email: `${suffix}@example.com`,
    workspaceId: `T_${suffix}`,
    slackUserId: `U_${suffix}`,
    ...overrides,
  };
  authenticate(result);
  onTestFinished(async () => {
    authenticate(result);
    for (const account of await accounts()) {
      await accept(
        clients()(connectorAccountsContract).delete({
          headers,
          params: { connectionId: account.id },
          body: { target },
        }),
        [200],
      );
    }
    await accept(
      clients()(integrationsSlackContract).disconnect({
        headers,
        query: { action: "uninstall" },
      }),
      [200, 404],
    );
  });
  return result;
}

function location(response: { readonly headers: Headers }): URL {
  const value = response.headers.get("location");
  if (!value) {
    throw new Error("Expected a redirect location");
  }
  return new URL(value);
}

function parameter(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`Expected ${name} in the authorization URL`);
  }
  return value;
}

async function start(url: string): Promise<URL> {
  const entry = new URL(url);
  const query = Object.fromEntries(entry.searchParams);
  const result = entry.pathname.endsWith("/install")
    ? await clients()(slackOauthContract).install({ query })
    : await clients()(slackOauthContract).connect({ query });
  return location(await accept(Promise.resolve(result), [307]));
}

async function startInstall(): Promise<URL> {
  const status = await integrationStatus();
  if (!status.installUrl) {
    throw new Error("Expected an installation link");
  }
  return await start(status.installUrl);
}

async function startConnect(
  current: Actor,
  origin: { readonly channelId?: string; readonly threadTs?: string } = {},
): Promise<URL> {
  const pending = await accept(
    clients()(slackConnectContract).connect({
      headers,
      body: {
        workspaceId: current.workspaceId,
        slackUserId: current.slackUserId,
        requestUserScopes: true,
        ...origin,
      },
    }),
    [202],
  );
  return await start(pending.body.authorizationUrl);
}

async function complete(
  authorization: URL,
  current: Actor,
  options: {
    readonly workspaceId?: string;
    readonly slackUserId?: string;
    readonly missingUserToken?: boolean;
    readonly userScopes?: string;
    readonly botScopes?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<URL> {
  const slackUserId = options.slackUserId ?? current.slackUserId;
  const botScopes = authorization.searchParams.get("scope");
  context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
    ok: true,
    team: {
      id: options.workspaceId ?? current.workspaceId,
      name: "Connected workspace",
    },
    ...(botScopes
      ? {
          access_token: `xoxb-${current.workspaceId}`,
          bot_user_id: `B_${current.workspaceId}`,
          scope: options.botScopes ?? botScopes,
        }
      : {}),
    authed_user: {
      id: slackUserId,
      access_token: options.missingUserToken
        ? undefined
        : `xoxp-${slackUserId}`,
      scope: options.userScopes ?? parameter(authorization, "user_scope"),
    },
  });
  context.mocks.slack.users.info.mockResolvedValue({
    ok: true,
    user: {
      id: slackUserId,
      real_name: "Slack user",
      profile: { email: current.email },
    },
  });
  return location(
    await accept(
      clients(options.signal)(slackOauthContract).callback({
        query: { state: parameter(authorization, "state"), code: randomUUID() },
      }),
      [307],
    ),
  );
}

async function disconnectChat(): Promise<void> {
  await accept(
    clients()(integrationsSlackContract).disconnect({ headers }),
    [200],
  );
}

beforeEach(() => {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
  context.mocks.slack.chat.postMessage.mockResolvedValue({
    ok: true,
    channel: "D_CONNECTED",
    ts: "1.0",
  });
  context.mocks.slack.chat.postEphemeral.mockResolvedValue({ ok: true });
  context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
  server.use(
    http.post("https://slack.com/api/auth.revoke", () => {
      return HttpResponse.json({ ok: true });
    }),
  );
});

function clerkProfile(current: Actor, email: string) {
  return {
    id: current.userId,
    primaryEmailAddressId: "primary",
    emailAddresses: [
      { id: "secondary", emailAddress: "secondary@example.com" },
      { id: "primary", emailAddress: email },
    ],
  };
}

async function completeWithAppHome(
  authorization: URL,
  current: Actor,
  account: string,
): Promise<void> {
  const publications = context.mocks.slack.views.publish.mock.calls.length;
  expect(
    (await complete(authorization, current)).searchParams.get("status"),
  ).toBe("connected");
  await flushWaitUntilForTest();
  expect(context.mocks.slack.views.publish).toHaveBeenCalledTimes(
    publications + 1,
  );
  const published = context.mocks.slack.views.publish.mock.calls.at(-1);
  expect(published).toStrictEqual([
    expect.objectContaining({ user_id: current.slackUserId }),
  ]);
  expect(JSON.stringify(published)).toContain(`Account: ${account}`);
  expect(JSON.stringify(published)).not.toContain("secondary@example.com");
}

test("post-connect App Home reuses the primary email until its display TTL expires", async () => {
  const current = actor();
  const startedAt = now();
  mockNow(startedAt);
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      clerkProfile(
        { ...current, userId: `other_${randomUUID()}` },
        "other@example.com",
      ),
      clerkProfile(current, "primary@example.com"),
    ],
  });
  await completeWithAppHome(
    await startInstall(),
    current,
    "primary@example.com",
  );
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkProfile(current, "changed@example.com")],
  });
  mockNow(startedAt + 15 * 60 * 1000 - 1);
  await completeWithAppHome(
    await startConnect(current),
    current,
    "primary@example.com",
  );
  expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledExactlyOnceWith(
    {
      userId: [current.userId],
    },
  );

  mockNow(startedAt + 15 * 60 * 1000);
  await completeWithAppHome(
    await startConnect(current),
    current,
    "changed@example.com",
  );
  expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(2);
});

test.each(["missing user", "missing primary"])(
  "post-connect App Home caches a confirmed %s briefly without substituting another email",
  async (missing) => {
    const current = actor();
    const startedAt = now();
    mockNow(startedAt);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data:
        missing === "missing user"
          ? []
          : [
              {
                ...clerkProfile(current, "unselected@example.com"),
                primaryEmailAddressId: null,
              },
            ],
    });
    await completeWithAppHome(await startInstall(), current, current.userId);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkProfile(current, "restored@example.com")],
    });
    mockNow(startedAt + 60_000 - 1);
    await completeWithAppHome(
      await startConnect(current),
      current,
      current.userId,
    );
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledOnce();
    mockNow(startedAt + 60_000);
    await completeWithAppHome(
      await startConnect(current),
      current,
      "restored@example.com",
    );
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(2);
  },
);

test("post-connect App Home does not cache provider failure or publish an expired email", async () => {
  const current = actor();
  const startedAt = now();
  mockNow(startedAt);
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkProfile(current, "before@example.com")],
  });
  await completeWithAppHome(
    await startInstall(),
    current,
    "before@example.com",
  );
  mockNow(startedAt + 15 * 60 * 1000);
  context.mocks.clerk.users.getUserList.mockRejectedValueOnce(
    new ClerkTransportTestError(429),
  );
  expect(
    (await complete(await startConnect(current), current)).searchParams.get(
      "status",
    ),
  ).toBe("connected");
  await flushWaitUntilForTest();
  expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();
  expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(2);
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
  });

  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkProfile(current, "after@example.com")],
  });
  await completeWithAppHome(
    await startConnect(current),
    current,
    "after@example.com",
  );
  expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(3);
});

test("post-connect App Home keeps primary email results isolated by user", async () => {
  const first = actor();
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkProfile(first, "first@example.com")],
  });
  await completeWithAppHome(await startInstall(), first, "first@example.com");
  const second = actor();
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkProfile(second, "second@example.com")],
  });
  await completeWithAppHome(await startInstall(), second, "second@example.com");
  authenticate(first);
  await completeWithAppHome(
    await startConnect(first),
    first,
    "first@example.com",
  );
  expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(2);
});

test("post-connect App Home does not let an older profile response replace a newer email", async () => {
  const current = actor();
  mockNow(now());
  const entered = createDeferredPromise<void>(context.signal);
  const earlier = createDeferredPromise<{
    data: ReturnType<typeof clerkProfile>[];
  }>(context.signal);
  onTestFinished(async () => {
    earlier.resolve({ data: [clerkProfile(current, "older@example.com")] });
    await flushWaitUntilForTest();
  });
  const published = createDeferredPromise<unknown>(context.signal);
  context.mocks.clerk.users.getUserList
    .mockImplementationOnce(async () => {
      entered.resolve();
      return await earlier.promise;
    })
    .mockResolvedValue({ data: [clerkProfile(current, "newer@example.com")] });
  context.mocks.slack.views.publish.mockImplementationOnce((view) => {
    published.resolve(view);
    return Promise.resolve({ ok: true });
  });

  await complete(await startInstall(), current);
  await entered.promise;
  expect(
    (await complete(await startConnect(current), current)).searchParams.get(
      "status",
    ),
  ).toBe("connected");
  expect(JSON.stringify(await published.promise)).toContain(
    "Account: newer@example.com",
  );
  earlier.resolve({ data: [clerkProfile(current, "older@example.com")] });
  await flushWaitUntilForTest();
  expect(context.mocks.slack.views.publish).toHaveBeenCalledTimes(2);
  expect(
    JSON.stringify(context.mocks.slack.views.publish.mock.calls),
  ).not.toContain("older@example.com");
  await completeWithAppHome(
    await startConnect(current),
    current,
    "newer@example.com",
  );
  expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(2);
});

test("post-connect App Home does not retain a profile read cancelled by its owner", async () => {
  const current = actor();
  const controller = new AbortController();
  const entered = createDeferredPromise<void>(context.signal);
  const response = createDeferredPromise<{
    data: ReturnType<typeof clerkProfile>[];
  }>(context.signal);
  onTestFinished(async () => {
    controller.abort();
    response.resolve({
      data: [clerkProfile(current, "cancelled@example.com")],
    });
    await flushWaitUntilForTest();
  });
  context.mocks.clerk.users.getUserList
    .mockImplementationOnce(async () => {
      entered.resolve();
      return await response.promise;
    })
    .mockResolvedValue({
      data: [clerkProfile(current, "recovered@example.com")],
    });
  await complete(await startInstall(), current, {
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  response.resolve({
    data: [clerkProfile(current, "cancelled@example.com")],
  });
  await flushWaitUntilForTest();
  expect(context.mocks.slack.views.publish).not.toHaveBeenCalled();
  await completeWithAppHome(
    await startConnect(current),
    current,
    "recovered@example.com",
  );
  expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(2);
});

test("installation grants bot and user scopes and connects the OAuth account", async () => {
  const current = actor();
  await setGetStartedEnabled(context, current);
  const authorization = await startInstall();
  expect(authorization.origin).toBe("https://slack.com");
  expect(parameter(authorization, "scope").split(",")).toContain(
    "app_mentions:read",
  );
  expect(parameter(authorization, "user_scope").split(",")).toContain(
    "chat:write",
  );
  expect(parameter(authorization, "user_scope").split(",")).not.toContain(
    "identity.basic",
  );

  const result = await complete(authorization, current);
  expect(result.searchParams.get("status")).toBe("connected");
  await expect(integrationStatus()).resolves.toMatchObject({
    isInstalled: true,
    isConnected: true,
  });
  await expect(accounts()).resolves.toStrictEqual([
    expect.objectContaining({
      externalId: current.slackUserId,
      connectionStatus: "connected",
    }),
  ]);

  const replay = await accept(
    clients()(slackOauthContract).callback({
      query: { state: parameter(authorization, "state"), code: "replay" },
    }),
    [307],
  );
  expect(location(replay).searchParams.get("error")).toContain("already used");
  await expect(accounts()).resolves.toHaveLength(1);
  const rewards = await readGetStartedStatus(context, current);
  expect(rewards.quests).toContainEqual(
    expect.objectContaining({
      key: "slack",
      claimedCount: 1,
      earnedCredits: 2000,
      rewardTarget: "org",
    }),
  );
  expect(rewards.quests).toContainEqual(
    expect.objectContaining({
      key: "connector",
      claimedCount: 1,
      earnedCredits: 100,
      rewardTarget: "user",
    }),
  );
});

test("connect reuses the same OAuth account and both disconnect operations stay independent", async () => {
  const current = actor();
  await complete(await startInstall(), current);
  const [original] = await accounts();
  if (!original) {
    throw new Error("Expected the connected Slack account");
  }
  await disconnectChat();
  await expect(integrationStatus()).resolves.toMatchObject({
    isInstalled: true,
    isConnected: false,
  });
  await expect(accounts()).resolves.toStrictEqual([
    expect.objectContaining({ id: original.id, connectionStatus: "connected" }),
  ]);
  const status = await integrationStatus();
  if (!status.connectUrl) {
    throw new Error("Expected a Slack connect link");
  }
  const authorization = await start(status.connectUrl);
  expect(authorization.searchParams.has("scope")).toBeFalsy();
  expect(authorization.searchParams.get("team")).toBe(current.workspaceId);
  expect(
    (await complete(authorization, current)).searchParams.get("status"),
  ).toBe("connected");
  await expect(accounts()).resolves.toStrictEqual([
    expect.objectContaining({ id: original.id }),
  ]);

  await accept(
    clients()(connectorAccountsContract).delete({
      headers,
      params: { connectionId: original.id },
      body: { target },
    }),
    [200],
  );
  await expect(accounts()).resolves.toHaveLength(0);
  await expect(integrationStatus()).resolves.toMatchObject({
    isInstalled: true,
    isConnected: true,
  });
});

test("a Slack-origin connect requests OAuth before binding and rejects another Slack identity", async () => {
  const current = actor();
  await complete(await startInstall(), current);
  await disconnectChat();
  const pending = await accept(
    clients()(slackConnectContract).connect({
      headers,
      body: {
        workspaceId: current.workspaceId,
        slackUserId: current.slackUserId,
        requestUserScopes: true,
        channelId: "C_ORIGIN",
        threadTs: "42.0",
      },
    }),
    [202],
  );
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: false,
  });
  const authorization = await start(pending.body.authorizationUrl);
  const rejected = await complete(authorization, current, {
    slackUserId: "U_DIFFERENT",
  });
  expect(rejected.searchParams.get("error")).toContain("Slack account");
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: false,
  });
  await expect(accounts()).resolves.toStrictEqual([
    expect.objectContaining({ externalId: current.slackUserId }),
  ]);

  const retry = await accept(
    clients()(slackConnectContract).connect({
      headers,
      body: {
        workspaceId: current.workspaceId,
        slackUserId: current.slackUserId,
        requestUserScopes: true,
      },
    }),
    [202],
  );
  expect(
    (
      await complete(await start(retry.body.authorizationUrl), current)
    ).searchParams.get("status"),
  ).toBe("connected");
});

test("a different workspace cannot replace the installed workspace or add its user account", async () => {
  const current = actor();
  await complete(await startInstall(), current);
  await disconnectChat();
  const status = await integrationStatus();
  if (!status.connectUrl) {
    throw new Error("Expected a Slack connect link");
  }
  const rejected = await complete(await start(status.connectUrl), current, {
    workspaceId: "T_DIFFERENT",
    slackUserId: "U_DIFFERENT",
  });
  expect(rejected.searchParams.get("error")).toContain("Slack workspace");
  await expect(integrationStatus()).resolves.toMatchObject({
    isInstalled: true,
    isConnected: false,
  });
  await expect(accounts()).resolves.toStrictEqual([
    expect.objectContaining({ externalId: current.slackUserId }),
  ]);
});

test("a Slack identity already linked to another user cannot create a partial connector connection", async () => {
  const original = actor();
  await complete(await startInstall(), original);
  const second = actor({
    orgId: original.orgId,
    workspaceId: original.workspaceId,
    slackUserId: original.slackUserId,
  });
  const status = await integrationStatus();
  if (!status.connectUrl) {
    throw new Error("Expected a Slack connect link");
  }
  const rejected = await complete(await start(status.connectUrl), second);
  expect(rejected.searchParams.get("error")).toContain("another user");
  await expect(accounts()).resolves.toHaveLength(0);
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: false,
  });
  authenticate(original);
  await expect(accounts()).resolves.toHaveLength(1);
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
  });
});

test("reinstall refreshes the existing connector and preserves the upgrade redirect", async () => {
  const current = actor();
  await complete(await startInstall(), current, { botScopes: "chat:write" });
  const [original] = await accounts();
  const status = await integrationStatus();
  if (!status.reinstallUrl || !original) {
    throw new Error("Expected an upgrade link and connected OAuth account");
  }
  expect(status.scopeMismatch).toBeTruthy();
  const authorization = await start(status.reinstallUrl);
  expect(authorization.searchParams.get("team")).toBe(current.workspaceId);
  const result = await complete(authorization, current);
  expect(result.pathname).toBe("/");
  expect(result.searchParams.get("updated")).toBe("1");
  await expect(accounts()).resolves.toStrictEqual([
    expect.objectContaining({ id: original.id }),
  ]);
  await expect(integrationStatus()).resolves.toMatchObject({
    scopeMismatch: false,
  });
});

test.each([{ missingUserToken: true }, { userScopes: "users:read" }])(
  "incomplete user consent does not report a connected installation: %j",
  async (options) => {
    const current = actor();
    const result = await complete(await startInstall(), current, options);
    expect(result.searchParams.has("error")).toBeTruthy();
    await expect(accounts()).resolves.toHaveLength(0);
    await expect(integrationStatus()).resolves.toMatchObject({
      isInstalled: false,
      isConnected: false,
    });
  },
);

test("a combined grant cannot bypass identity checks through the standalone connector callback", async () => {
  const current = actor();
  const authorization = await startInstall();
  const wrongCallback = await accept(
    clients()(connectorsSlugCallbackContract).callback({
      params: { connectorSlug: "slack" },
      query: {
        state: parameter(authorization, "state"),
        code: "wrong-callback",
      },
    }),
    [307],
  );
  expect(location(wrongCallback).pathname).toBe("/connector/error");
  expect(location(wrongCallback).searchParams.get("message")).toContain(
    "Invalid state",
  );
  await expect(accounts()).resolves.toHaveLength(0);
  expect(
    (await complete(authorization, current)).searchParams.get("status"),
  ).toBe("connected");
});

test("unsigned install parameters cannot opt into a user's connector grant", async () => {
  const current = actor();
  const legacy = await accept(
    clients()(slackOauthContract).install({
      query: { orgId: current.orgId, userId: current.userId },
    }),
    [307],
  );
  expect(location(legacy).searchParams.has("user_scope")).toBeFalsy();
  const status = await integrationStatus();
  if (!status.installUrl) {
    throw new Error("Expected an installation link");
  }
  const corrupted = new URL(status.installUrl);
  corrupted.searchParams.set(
    "connectorState",
    `${parameter(corrupted, "connectorState")}corrupt`,
  );
  expect(
    (await start(corrupted.toString())).searchParams.has("error"),
  ).toBeTruthy();
  await expect(accounts()).resolves.toHaveLength(0);
});

test("a Slack-origin OAuth callback confirms connection in the originating thread", async () => {
  const current = actor();
  await complete(await startInstall(), current);
  await disconnectChat();
  await flushWaitUntilForTest();
  context.mocks.slack.chat.postEphemeral.mockClear();
  context.mocks.slack.chat.postMessage.mockClear();

  const authorization = await startConnect(current, {
    channelId: "C_ORIGIN",
    threadTs: "42.0",
  });
  expect(
    (await complete(authorization, current)).searchParams.get("status"),
  ).toBe("connected");
  await flushWaitUntilForTest();

  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
  });
  expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "C_ORIGIN",
      user: current.slackUserId,
      thread_ts: "42.0",
      text: "You're connected!",
    }),
  );
  expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
});

test("a Slack connect OAuth callback sends a DM welcome without channel context", async () => {
  const current = actor();
  await complete(await startInstall(), current);
  await disconnectChat();
  await flushWaitUntilForTest();
  context.mocks.slack.chat.postMessage.mockClear();

  await complete(await startConnect(current), current);
  await flushWaitUntilForTest();

  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
  });
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: current.slackUserId,
      text: "You're connected!",
    }),
  );
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: current.slackUserId,
      text: `Hi! I'm <@B_${current.workspaceId}>.`,
      thread_ts: "1.0",
    }),
  );
});

test("a Slack connect OAuth callback recovers a failed channel confirmation by DM", async () => {
  const current = actor();
  await complete(await startInstall(), current);
  await disconnectChat();
  await flushWaitUntilForTest();
  context.mocks.slack.chat.postMessage.mockClear();
  context.mocks.slack.chat.postEphemeral.mockRejectedValueOnce(
    Object.assign(new Error("not_in_channel"), {
      data: { ok: false, error: "not_in_channel" },
    }),
  );

  await complete(
    await startConnect(current, { channelId: "C_ORIGIN" }),
    current,
  );
  await flushWaitUntilForTest();

  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
  });
  expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ channel: current.slackUserId }),
  );
  expect(
    JSON.stringify(context.mocks.slack.chat.postMessage.mock.calls),
  ).toContain("connected to Okou");
});

test("an admin binds an anonymously installed workspace through user OAuth", async () => {
  const current = actor();
  await setGetStartedEnabled(context, current);
  const anonymous = await accept(
    clients()(slackOauthContract).install({ query: {} }),
    [307],
  );
  const authorization = location(anonymous);
  context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
    ok: true,
    access_token: `xoxb-${current.workspaceId}`,
    bot_user_id: `B_${current.workspaceId}`,
    team: { id: current.workspaceId, name: "Anonymous workspace" },
    authed_user: { id: current.slackUserId },
    scope: parameter(authorization, "scope"),
  });
  await accept(
    clients()(slackOauthContract).callback({
      query: { code: randomUUID(), state: parameter(authorization, "state") },
    }),
    [307],
  );
  await expect(integrationStatus()).resolves.toMatchObject({
    isInstalled: false,
  });
  expect(
    (await readGetStartedStatus(context, current)).recentGrants,
  ).toStrictEqual([]);

  const connected = await complete(await startConnect(current), current);

  expect(connected.searchParams.get("status")).toBe("connected");
  await expect(integrationStatus()).resolves.toMatchObject({
    isInstalled: true,
    isConnected: true,
    isAdmin: true,
  });
  await expect(accounts()).resolves.toHaveLength(1);
  expect((await readGetStartedStatus(context, current)).quests).toContainEqual(
    expect.objectContaining({
      key: "slack",
      rewardTarget: "org",
      claimedCount: 1,
      earnedCredits: 2000,
    }),
  );
});
