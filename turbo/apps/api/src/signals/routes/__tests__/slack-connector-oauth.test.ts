import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  integrationsSlackMessageContract,
  integrationsSlackDownloadFileContract,
  integrationsSlackUploadInitContract,
  integrationsSlackUploadCompleteContract,
} from "@okouai/api-contracts/contracts/integrations";
import { integrationsSlackReadContract } from "@okouai/api-contracts/contracts/integrations-slack-read";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, onTestFinished, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { integrationsSlackRoutes } from "../integrations-slack";
import { slackConnectRoutes } from "../slack-connect";
import { slackOauthRoutes } from "../slack-oauth";
import { featureSwitchesRoutes } from "../feature-switches";
import { integrationsSlackMessageRoutes } from "../integrations-slack-message";
import { integrationsSlackReadRoutes } from "../integrations-slack-read";
import { integrationsSlackUploadInitRoutes } from "../integrations-slack-upload-init";
import { integrationsSlackUploadCompleteRoutes } from "../integrations-slack-upload-complete";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { ClerkUserNotFoundTestError } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";
import { readGetStartedStatus } from "./helpers/get-started";
import { mockSharedSlackConversations } from "./helpers/slack-conversation-access";

const context = testContext();
const mocks = createRouteMocks(context);
const API_ORIGIN = "https://api.okou.ai";
const headers = { authorization: "Bearer clerk-session" } as const;
const target = { kind: "builtin", connectorSlug: "slack" } as const;
const routes = [
  ...featureSwitchesRoutes,
  ...integrationsSlackMessageRoutes,
  ...integrationsSlackReadRoutes,
  ...integrationsSlackUploadInitRoutes,
  ...integrationsSlackUploadCompleteRoutes,
  ...slackOauthRoutes,
  ...slackConnectRoutes,
  ...integrationsSlackRoutes,
  ...connectorAccountRoutes,
  ...builtinConnectorsSlugCallbackRoutes,
] as const;

function clients() {
  return setupApp({ context, routes, baseUrl: API_ORIGIN });
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
    if (result.orgRole === "org:admin") {
      await accept(
        clients()(integrationsSlackContract).disconnect({
          headers,
          query: { action: "uninstall" },
        }),
        [200, 404],
      );
    }
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
  origin: {
    readonly channelId?: string;
    readonly threadTs?: string;
    readonly intent?: "connect" | "switch";
  } = {},
): Promise<URL> {
  const client = clients()(slackConnectContract);
  const requestUserScopes = true;
  const body = {
    workspaceId: current.workspaceId,
    slackUserId: current.slackUserId,
    requestUserScopes,
    ...(origin.channelId ? { channelId: origin.channelId } : {}),
    ...(origin.threadTs ? { threadTs: origin.threadTs } : {}),
  } satisfies Parameters<typeof client.connect>[0]["body"];
  const pending = await accept(
    origin.intent === "switch"
      ? client.switchAccount({ headers, body })
      : client.connect({ headers, body }),
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
      team_id: options.workspaceId ?? current.workspaceId,
      real_name: "Slack user",
      profile: { email: current.email },
    },
  });
  return location(
    await accept(
      clients()(slackOauthContract).callback({
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

async function enableWorkspaceIdentity(current: Actor): Promise<void> {
  authenticate(current);
  await accept(
    clients()(featureSwitchesContract).update({
      headers,
      body: { switches: { slackWorkspaceIdentity: true } },
    }),
    [200],
  );
}

test("connects a workspace identity before bot installation without granting another workspace's bot", async () => {
  const current = actor({ orgRole: "org:member" });
  await enableWorkspaceIdentity(current);
  const authorization = await startConnect(current);
  const result = await complete(authorization, current);
  expect(result.searchParams.get("status")).toBe("connected");
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
    isInstalled: false,
  });
  await accept(
    clients()(integrationsSlackMessageContract).sendMessage({
      headers,
      body: { channel: "C_OTHER_WORKSPACE", text: "do not borrow a bot" },
    }),
    [404],
  );
  await accept(
    clients()(integrationsSlackReadContract).listChannels({
      headers,
      query: {},
    }),
    [404],
  );
  await disconnectChat();
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: false,
    isInstalled: false,
  });
});

test("switches a legacy workspace connection to a new home identity without retaining the old bot capability", async () => {
  const current = actor();
  await complete(await startInstall(), current);
  await flushWaitUntilForTest();
  await enableWorkspaceIdentity(current);
  context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
    ok: true,
    file_id: "F_BEFORE_SWITCH",
    upload_url: "https://files.slack.com/upload/v1/before-switch",
  });
  await accept(
    clients()(integrationsSlackUploadInitContract).init({
      headers,
      body: { filename: "report.txt", length: 42 },
    }),
    [200],
  );
  const next = {
    ...current,
    workspaceId: `T_NEXT_${randomUUID()}`,
    slackUserId: `U_NEXT_${randomUUID()}`,
  };
  const rejected = await complete(await startConnect(next), next);
  expect(rejected.searchParams.get("error")).toContain("Switch");
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
    isInstalled: true,
  });
  const switched = await complete(
    await startConnect(next, { intent: "switch" }),
    next,
  );
  expect(switched.searchParams.get("status")).toBe("connected");
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
    isInstalled: false,
  });
  await accept(
    clients()(integrationsSlackMessageContract).sendMessage({
      headers,
      body: { channel: "C_OLD_BOT", text: "do not retain the previous bot" },
    }),
    [404],
  );
  context.mocks.slack.files.completeUploadExternal.mockClear();
  await accept(
    clients()(integrationsSlackUploadCompleteContract).complete({
      headers,
      body: { fileId: "F_BEFORE_SWITCH", channel: "C_OLD_BOT" },
    }),
    [404],
  );
  expect(
    context.mocks.slack.files.completeUploadExternal,
  ).not.toHaveBeenCalled();
  await disconnectChat();
});

test.each([
  "own file",
  "shared channel",
  "bot-only channel",
  "missing visibility",
])(
  "checks connected user access before downloading a file from a %s",
  async (visibility) => {
    const current = actor();
    await complete(await startInstall(), current);
    await flushWaitUntilForTest();
    await enableWorkspaceIdentity(current);
    const allowed = visibility === "shared channel";
    server.use(
      http.get("https://slack.com/api/files.info", () => {
        return HttpResponse.json({
          ok: true,
          file: {
            id: "F_ACCESS_CHECK",
            name: "test.txt",
            mimetype: "text/plain",
            size: 4,
            url_private_download:
              "https://files.slack.com/files-pri/F_ACCESS_CHECK/test.txt",
            ...(visibility === "missing visibility"
              ? {}
              : {
                  user:
                    visibility === "own file"
                      ? current.slackUserId
                      : "U_OTHER_MEMBER",
                  channels: [
                    visibility === "shared channel"
                      ? "C_USER_SHARED"
                      : "C_BOT_ONLY",
                  ],
                }),
          },
        });
      }),
      http.get("https://slack.com/api/users.conversations", () => {
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C_USER_SHARED" }],
        });
      }),
    );
    context.mocks.slack.fetchFile.mockResolvedValue(
      new Response("file", {
        headers: { "content-type": "text/plain" },
      }),
    );
    await accept(
      clients()(integrationsSlackDownloadFileContract).download({
        headers,
        query: { file_id: "F_ACCESS_CHECK" },
      }),
      [allowed ? 200 : 404],
    );
    expect(context.mocks.slack.fetchFile).toHaveBeenCalledTimes(
      allowed ? 1 : 0,
    );
  },
);

test("connects through an external bot and authorizes only the sender's installed workspace", async () => {
  const entry = actor();
  await complete(await startInstall(), entry);
  await flushWaitUntilForTest();
  const current = actor();
  await enableWorkspaceIdentity(current);
  context.mocks.slack.users.info.mockResolvedValue({
    ok: true,
    user: {
      id: current.slackUserId,
      team_id: current.workspaceId,
      deleted: false,
    },
  });
  const authorization = await startConnect(
    { ...current, workspaceId: entry.workspaceId },
    { channelId: "C_SHARED_ENTRY" },
  );
  expect(authorization.searchParams.get("team")).toBe(current.workspaceId);
  expect(
    (await complete(authorization, current)).searchParams.get("status"),
  ).toBe("connected");
  await flushWaitUntilForTest();
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
    isInstalled: false,
  });

  // The bot belongs to a different Okou organization. Its Slack workspace,
  // authenticated membership and channel access determine the user's capability.
  const installer = actor({ workspaceId: current.workspaceId });
  await complete(await startInstall(), installer);
  await flushWaitUntilForTest();
  authenticate(current);
  context.mocks.slack.users.info.mockResolvedValue({
    ok: true,
    user: {
      id: current.slackUserId,
      team_id: current.workspaceId,
      deleted: false,
    },
  });
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
    isInstalled: true,
    isAdmin: false,
  });
  await accept(
    clients()(integrationsSlackContract).disconnect({
      headers,
      query: { action: "uninstall" },
    }),
    [404],
  );
  mockSharedSlackConversations(["C_OWN_SHARED"]);
  server.use(
    http.get("https://slack.com/api/users.conversations", ({ request }) => {
      if (
        request.headers.get("authorization") !==
          `Bearer xoxb-${current.workspaceId}` ||
        new URL(request.url).searchParams.get("user") !== current.slackUserId
      ) {
        return HttpResponse.json({ ok: false, error: "invalid_auth" });
      }
      return HttpResponse.json({
        ok: true,
        channels: [{ id: "C_OWN_SHARED", name: "shared", is_private: false }],
        response_metadata: {},
      });
    }),
  );
  await accept(
    clients()(integrationsSlackMessageContract).sendMessage({
      headers,
      body: { channel: "C_OWN_SHARED", text: "authorized workspace" },
    }),
    [200],
  );
  await accept(
    clients()(integrationsSlackMessageContract).sendMessage({
      headers,
      body: { channel: "C_BOT_ONLY", text: "not visible to this member" },
    }),
    [404],
  );
  context.mocks.slack.conversations.open.mockResolvedValue({
    ok: true,
    channel: { id: "D123456" },
  });
  await accept(
    clients()(integrationsSlackMessageContract).sendMessage({
      headers,
      body: { user: "U_DM_RECIPIENT", text: "explicit outbound DM" },
    }),
    [200],
  );
  await accept(
    clients()(integrationsSlackReadContract).history({
      headers,
      query: { channel: "D123456" },
    }),
    [404],
  );
  server.use(
    http.get("https://slack.com/api/conversations.info", ({ request }) => {
      return HttpResponse.json({
        ok: true,
        channel: {
          id: new URL(request.url).searchParams.get("channel"),
          properties: {
            posting_restricted_to: { user: ["U_OTHER_ALLOWED"] },
          },
        },
      });
    }),
  );
  context.mocks.slack.chat.postMessage.mockClear();
  await accept(
    clients()(integrationsSlackMessageContract).sendMessage({
      headers,
      body: { channel: "C_OWN_SHARED", text: "posting is restricted" },
    }),
    [404],
  );
  expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  context.mocks.slack.users.info.mockResolvedValue({
    ok: true,
    user: {
      id: current.slackUserId,
      team_id: current.workspaceId,
      deleted: true,
    },
  });
  await accept(
    clients()(integrationsSlackMessageContract).sendMessage({
      headers,
      body: { channel: "C_OWN_SHARED", text: "removed member" },
    }),
    [404],
  );

  authenticate(installer);
  await accept(
    clients()(integrationsSlackContract).disconnect({
      headers,
      query: { action: "uninstall" },
    }),
    [200],
  );
  authenticate(current);
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
    isInstalled: false,
  });
  await accept(
    clients()(integrationsSlackMessageContract).sendMessage({
      headers,
      body: {
        channel: "C_SHARED_ENTRY",
        text: "still cannot borrow entry bot",
      },
    }),
    [404],
  );
});

test.each(["primary email", "missing user", "provider failure"])(
  "preserves connected OAuth state with a %s profile lookup",
  async (outcome) => {
    const current = actor();
    if (outcome === "primary email") {
      context.mocks.clerk.users.getUser.mockResolvedValue({
        id: current.userId,
        primaryEmailAddressId: "primary",
        emailAddresses: [
          { id: "secondary", emailAddress: `secondary-${current.email}` },
          { id: "primary", emailAddress: current.email },
        ],
      });
    } else {
      context.mocks.clerk.users.getUser.mockRejectedValue(
        outcome === "missing user"
          ? new ClerkUserNotFoundTestError()
          : new Error("Clerk profile unavailable"),
      );
    }
    const result = await complete(await startInstall(), current);
    await flushWaitUntilForTest();

    expect(result.searchParams.get("status")).toBe("connected");
    await expect(integrationStatus()).resolves.toMatchObject({
      isConnected: true,
    });
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledExactlyOnceWith(
      current.userId,
    );
    if (outcome === "provider failure") {
      expect(context.mocks.slack.views.publish).not.toHaveBeenCalled();
    } else {
      expect(context.mocks.slack.views.publish).toHaveBeenCalledOnce();
      const home = JSON.stringify(context.mocks.slack.views.publish.mock.calls);
      if (outcome === "primary email") {
        expect(home).toContain(current.email);
        expect(home).not.toContain(`secondary-${current.email}`);
      } else {
        expect(home).not.toContain(current.email);
      }
    }
  },
);

test("installation grants bot and user scopes and connects the OAuth account", async () => {
  const current = actor();
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
  expect(result.pathname).toBe("/settings/slack");
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
    clients()(builtinConnectorsSlugCallbackContract).callback({
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

test("an explicit Slack account switch replaces the previous identity after OAuth", async () => {
  const current = actor();
  await complete(await startInstall(), current);
  await flushWaitUntilForTest();

  const nextSlackUserId = `U_${randomUUID()}`;
  const nextIdentity = { ...current, slackUserId: nextSlackUserId };
  const switched = await complete(
    await startConnect(nextIdentity, { intent: "switch" }),
    nextIdentity,
  );
  expect(switched.searchParams.get("status")).toBe("connected");
  await flushWaitUntilForTest();

  const client = clients()(slackConnectContract);
  const nextStatus = await accept(
    client.getLinkStatus({
      headers,
      query: {
        workspaceId: current.workspaceId,
        slackUserId: nextSlackUserId,
      },
    }),
    [200],
  );
  expect(nextStatus.body.linkStatus).toStrictEqual({ kind: "connected" });

  const previousStatus = await accept(
    client.getLinkStatus({
      headers,
      query: {
        workspaceId: current.workspaceId,
        slackUserId: current.slackUserId,
      },
    }),
    [200],
  );
  expect(previousStatus.body.linkStatus).toStrictEqual({
    kind: "slack_account_mismatch",
    currentSlackUserId: nextSlackUserId,
    requestedSlackUserId: current.slackUserId,
  });
  // The replaced account no longer belongs to anyone: another member of the
  // org may link it.
  actor({ orgId: current.orgId, workspaceId: current.workspaceId });
  const freedStatus = await accept(
    client.getLinkStatus({
      headers,
      query: {
        workspaceId: current.workspaceId,
        slackUserId: current.slackUserId,
      },
    }),
    [200],
  );
  expect(freedStatus.body.linkStatus).toStrictEqual({ kind: "connect" });
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

test("slack success and denial retain the verified conversation context for the canonical page", async () => {
  const current = actor();
  await complete(await startInstall(), current);
  await disconnectChat();
  const origin = { channelId: "C_ORIGIN", threadTs: "42.0" };
  const authorization = await startConnect(current, origin);
  const denied = location(
    await accept(
      clients()(slackOauthContract).callback({
        query: {
          state: parameter(authorization, "state"),
          error: "access_denied",
        },
      }),
      [307],
    ),
  );
  expect(denied.pathname).toBe("/settings/slack");
  expect(Object.fromEntries(denied.searchParams)).toMatchObject({
    w: current.workspaceId,
    u: current.slackUserId,
    c: origin.channelId,
    t: origin.threadTs,
    error: "Slack authorization was not completed. Please try again.",
  });
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: false,
  });
  const retry = await startConnect(current, origin);
  const completed = await complete(retry, current);
  expect(completed.pathname).toBe("/settings/slack");
  expect(Object.fromEntries(completed.searchParams)).toMatchObject({
    status: "connected",
    w: current.workspaceId,
    u: current.slackUserId,
    c: origin.channelId,
    t: origin.threadTs,
  });
  await expect(integrationStatus()).resolves.toMatchObject({
    isConnected: true,
  });
});
