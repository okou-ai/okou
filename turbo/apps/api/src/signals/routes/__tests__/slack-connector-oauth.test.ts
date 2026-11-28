import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  integrationsSlackDownloadFileContract,
  integrationsSlackMessageContract,
  integrationsSlackUploadCompleteContract,
  integrationsSlackUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { integrationsSlackReadContract } from "@okouai/api-contracts/contracts/integrations-slack-read";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { connectorAccountRoutes } from "../connector-accounts";
import { integrationsSlackRoutes } from "../integrations-slack";
import { integrationsSlackMessageRoutes } from "../integrations-slack-message";
import { integrationsSlackReadRoutes } from "../integrations-slack-read";
import { integrationsSlackUploadCompleteRoutes } from "../integrations-slack-upload-complete";
import { integrationsSlackUploadInitRoutes } from "../integrations-slack-upload-init";
import { slackConnectRoutes } from "../slack-connect";
import { slackOauthRoutes } from "../slack-oauth";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createBddIntegrationApi,
  mockSlackIdentityLookup,
} from "./helpers/api-bdd-integrations";
import { mockSharedSlackConversations } from "./helpers/slack-conversation-access";
import {
  createPublicSlackOrgApi,
  uniqueSlackUserId,
} from "./helpers/slack-public-install";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const clerkDirectory = createStore();

const SLACK_TARGET = { kind: "builtin", connectorSlug: "slack" } as const;

function uniqueTeamId(): string {
  return `T_${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/** The actor's browser session; the actor is a real member of its org. */
async function signIn(actor: ApiTestUser): Promise<{ authorization: string }> {
  if (actor.orgId) {
    await clerkDirectory.set(
      seedOrgMembership$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        role: actor.orgRole === "org:member" ? "member" : "admin",
      },
      context.signal,
    );
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function clients() {
  return setupApp({
    context,
    routes: [
      ...integrationsSlackRoutes,
      ...integrationsSlackMessageRoutes,
      ...integrationsSlackReadRoutes,
      ...integrationsSlackUploadInitRoutes,
      ...integrationsSlackUploadCompleteRoutes,
      ...slackConnectRoutes,
      ...slackOauthRoutes,
      ...connectorAccountRoutes,
    ],
  });
}

async function readStatus(actor: ApiTestUser) {
  const response = await accept(
    clients()(integrationsSlackContract).getStatus({
      headers: await signIn(actor),
    }),
    [200],
  );
  return response.body;
}

async function disconnectChat(actor: ApiTestUser) {
  await accept(
    clients()(integrationsSlackContract).disconnect({
      headers: await signIn(actor),
      query: {},
    }),
    [200],
  );
}

async function listAccounts(actor: ApiTestUser) {
  const response = await accept(
    clients()(connectorAccountsContract).connections({
      headers: await signIn(actor),
      query: { ...SLACK_TARGET, limit: 50 },
    }),
    [200],
  );
  return response.body.connections;
}

function locationOf(response: { readonly headers: Headers }): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected a redirect location");
  }
  return new URL(location);
}

/** Follows an Okou entry link (install or connect) to Slack's consent page. */
async function followEntry(entry: string | null | undefined) {
  if (!entry) {
    throw new Error("Expected a Slack entry link");
  }
  const url = new URL(entry);
  const query = Object.fromEntries(url.searchParams);
  const oauth = clients()(slackOauthContract);
  const response = url.pathname.endsWith("/install")
    ? await accept(oauth.install({ query }), [307])
    : await accept(oauth.connect({ query }), [307]);
  const authorization = locationOf(response);
  expect(authorization.origin).toBe("https://slack.com");
  return authorization;
}

interface SlackGrant {
  readonly teamId: string;
  readonly slackUserId: string;
  readonly email?: string;
  /** Bot scopes Slack grants; defaults to the requested bot scopes. */
  readonly botScopes?: string;
}

/** Slack's consent result for the authorization, then its redirect back. */
async function completeAtSlack(
  authorization: URL,
  grant: SlackGrant,
  callbackActor: ApiTestUser,
) {
  mockSlackIdentityLookup(context, {
    id: grant.slackUserId,
    team_id: grant.teamId,
    real_name: "Slack User",
    profile: {
      email: grant.email ?? `${grant.slackUserId}@slack.test`,
      display_name: "Slack User",
    },
  });
  const requestedBotScopes = authorization.searchParams.get("scope");
  const botScopes = grant.botScopes ?? requestedBotScopes;
  context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
    ok: true,
    team: { id: grant.teamId, name: `Workspace ${grant.teamId}` },
    authed_user: {
      id: grant.slackUserId,
      access_token: `xoxp-${grant.slackUserId}`,
      scope: authorization.searchParams.get("user_scope") ?? "",
    },
    ...(botScopes
      ? {
          access_token: `xoxb-${grant.teamId}`,
          bot_user_id: `UBOT_${grant.teamId}`,
          scope: botScopes,
        }
      : {}),
  });
  return await callback(callbackActor, {
    code: `code-${randomUUID()}`,
    state: authorization.searchParams.get("state") ?? "",
  });
}

async function callback(
  actor: ApiTestUser,
  query: { code?: string; state: string; error?: string },
) {
  const response = await accept(
    clients()(slackOauthContract).callback({
      extraHeaders: await signIn(actor),
      query,
    }),
    [307],
  );
  return locationOf(response);
}

/** The admin installs the bot through the settings install link. */
async function installThroughSettings(admin: ApiTestUser, grant: SlackGrant) {
  configureSlack();
  const status = await readStatus(admin);
  const authorization = await followEntry(status.installUrl);
  const completed = await completeAtSlack(authorization, grant, admin);
  return { authorization, completed };
}

/** POST /connect (or /connect/switch) and follow it to Slack. */
async function startAccountConnect(
  actor: ApiTestUser,
  body: {
    readonly workspaceId: string;
    readonly slackUserId: string;
    readonly channelId?: string;
    readonly threadTs?: string;
  },
  flow: "connect" | "switch" = "connect",
) {
  const connect = clients()(slackConnectContract);
  const request = {
    headers: await signIn(actor),
    body: { ...body, requestUserScopes: true as const },
  };
  const pending =
    flow === "switch"
      ? await accept(connect.switchAccount(request), [202])
      : await accept(connect.connect(request), [202]);
  const authorization = await followEntry(pending.body.authorizationUrl);
  return { pending, authorization };
}

function configureSlack(): void {
  createBddIntegrationApi(context).configureSlackAppMocks();
}

function postedMessages() {
  return context.mocks.slack.chat.postMessage.mock.calls.map((call) => {
    return call[0] as { channel: string; text?: string; blocks?: unknown };
  });
}

function welcomeRecipients(): string[] {
  return postedMessages()
    .filter((message) => {
      return message.text?.includes("Hi! I'm") === true;
    })
    .map((message) => {
      return message.channel;
    });
}

type InstalledSlackAdmin = Awaited<
  ReturnType<typeof installedAdminWithoutChat>
>;

/** A Slack-origin connect from channel C_ORIGIN thread 42.0. */
async function startSlackOriginConnect(org: InstalledSlackAdmin) {
  return await startAccountConnect(org.actor, {
    workspaceId: org.slackWorkspaceId,
    slackUserId: org.slackUserId,
    channelId: "C_ORIGIN",
    threadTs: "42.0",
  });
}

/** Slack completes the consent as another Slack user, U_DIFFERENT. */
async function completeAsDifferentSlackUser(
  org: InstalledSlackAdmin,
  authorization: URL,
) {
  return await completeAtSlack(
    authorization,
    { teamId: org.slackWorkspaceId, slackUserId: "U_DIFFERENT" },
    org.actor,
  );
}

/** An admin whose org installed Slack and whose chat account is disconnected. */
async function installedAdminWithoutChat() {
  const org = await createPublicSlackOrgApi(context).installOrg({
    withConnection: true,
  });
  await flushWaitUntilForTest();
  await disconnectChat(org.actor);
  await flushWaitUntilForTest();
  context.mocks.slack.chat.postMessage.mockClear();
  context.mocks.slack.chat.postEphemeral.mockClear();
  return org;
}

interface SlackFileServed {
  readonly id: string;
  readonly channels: readonly string[];
}

/** Slack's files.info and download for one file owned by another member. */
function serveSlackFile(file: SlackFileServed) {
  const fetches: string[] = [];
  server.use(
    http.get("https://slack.com/api/files.info", () => {
      return HttpResponse.json({
        ok: true,
        file: {
          id: file.id,
          name: "notes.txt",
          mimetype: "text/plain",
          size: 5,
          user: "U_OTHER_MEMBER",
          url_private_download: `https://files.slack.com/files-pri/${file.id}/notes.txt`,
          channels: file.channels,
          groups: [],
          ims: [],
        },
      });
    }),
  );
  context.mocks.slack.fetchFile.mockImplementation((...args: unknown[]) => {
    fetches.push(String(args[0]));
    return Promise.resolve(
      new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "5" },
      }),
    );
  });
  return fetches;
}

async function downloadFile(actor: ApiTestUser, fileId: string) {
  return await accept(
    setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackDownloadFileContract,
    ).download({ headers: await signIn(actor), query: { file_id: fileId } }),
    [200, 404],
  );
}

describe("Slack account connection before installation", () => {
  it("slack-connector-oauth-001 connects a Slack identity before installation without granting any bot", async () => {
    configureSlack();
    const member = createBddApi(context).user({ orgRole: "org:member" });
    const teamId = uniqueTeamId();
    const slackUserId = uniqueSlackUserId();

    const { authorization } = await startAccountConnect(member, {
      workspaceId: teamId,
      slackUserId,
    });
    const completed = await completeAtSlack(
      authorization,
      { teamId, slackUserId },
      member,
    );
    await flushWaitUntilForTest();

    expect(completed.searchParams.get("status")).toBe("connected");
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    await expect(readStatus(member)).resolves.toMatchObject({
      isConnected: true,
      isInstalled: false,
    });
    const message = await accept(
      clients()(integrationsSlackMessageContract).sendMessage({
        headers: await signIn(member),
        body: { channel: "C_OTHER_WORKSPACE", text: "hello" },
      }),
      [200, 404],
    );
    expect(message.status).toBe(404);
    const channels = await accept(
      clients()(integrationsSlackReadContract).listChannels({
        headers: await signIn(member),
        query: { limit: 100 },
      }),
      [200, 404],
    );
    expect(channels.status).toBe(404);
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();

    await disconnectChat(member);

    await expect(readStatus(member)).resolves.toMatchObject({
      isConnected: false,
      isInstalled: false,
    });
  });

  it("slack-connector-oauth-003 delivers pending welcomes when the workspace bot is installed", async () => {
    configureSlack();
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const teamId = uniqueTeamId();
    const memberSlackUserId = uniqueSlackUserId();
    const adminSlackUserId = uniqueSlackUserId();
    const { authorization } = await startAccountConnect(member, {
      workspaceId: teamId,
      slackUserId: memberSlackUserId,
    });
    await completeAtSlack(
      authorization,
      { teamId, slackUserId: memberSlackUserId },
      member,
    );
    await flushWaitUntilForTest();
    expect(welcomeRecipients()).toStrictEqual([]);

    await installThroughSettings(admin, {
      teamId,
      slackUserId: adminSlackUserId,
    });
    await flushWaitUntilForTest();

    expect(welcomeRecipients().sort()).toStrictEqual(
      [memberSlackUserId, adminSlackUserId].sort(),
    );
  });
});

describe("Slack account connection with an installed bot", () => {
  it("slack-connector-oauth-002 sends a DM welcome when the account's own workspace bot is installed", async () => {
    const org = await installedAdminWithoutChat();

    const { authorization } = await startAccountConnect(org.actor, {
      workspaceId: org.slackWorkspaceId,
      slackUserId: org.slackUserId,
    });
    const completed = await completeAtSlack(
      authorization,
      { teamId: org.slackWorkspaceId, slackUserId: org.slackUserId },
      org.actor,
    );
    await flushWaitUntilForTest();

    expect(completed.searchParams.get("status")).toBe("connected");
    const welcome = postedMessages().find((message) => {
      return message.text?.includes("Hi! I'm") === true;
    });
    expect(welcome?.channel).toBe(org.slackUserId);
    expect(welcome?.blocks).toBeDefined();
  });

  it("slack-connector-oauth-016 (1/2) requests OAuth before binding and rejects another Slack identity", async () => {
    const org = await installedAdminWithoutChat();
    const before = await listAccounts(org.actor);

    const { pending, authorization } = await startSlackOriginConnect(org);
    expect(pending.status).toBe(202);
    await expect(readStatus(org.actor)).resolves.toMatchObject({
      isConnected: false,
    });
    const mismatched = await completeAsDifferentSlackUser(org, authorization);

    expect(mismatched.searchParams.get("error")).toContain("Slack account");
    await expect(readStatus(org.actor)).resolves.toMatchObject({
      isConnected: false,
    });
    const after = await listAccounts(org.actor);
    expect(
      after.map((account) => {
        return [account.id, account.externalId];
      }),
    ).toStrictEqual(
      before.map((account) => {
        return [account.id, org.slackUserId];
      }),
    );
  });

  it("slack-connector-oauth-016 (2/2) completes a plain retry as the correct Slack user", async () => {
    const org = await installedAdminWithoutChat();
    const { authorization } = await startSlackOriginConnect(org);
    await completeAsDifferentSlackUser(org, authorization);

    const retry = await startAccountConnect(org.actor, {
      workspaceId: org.slackWorkspaceId,
      slackUserId: org.slackUserId,
    });
    const completed = await completeAtSlack(
      retry.authorization,
      { teamId: org.slackWorkspaceId, slackUserId: org.slackUserId },
      org.actor,
    );

    expect(completed.searchParams.get("status")).toBe("connected");
  });

  it("slack-connector-oauth-023 confirms a Slack-origin connection in the originating thread", async () => {
    const org = await installedAdminWithoutChat();

    const { authorization } = await startAccountConnect(org.actor, {
      workspaceId: org.slackWorkspaceId,
      slackUserId: org.slackUserId,
      channelId: "C_ORIGIN",
      threadTs: "42.0",
    });
    const completed = await completeAtSlack(
      authorization,
      { teamId: org.slackWorkspaceId, slackUserId: org.slackUserId },
      org.actor,
    );
    await flushWaitUntilForTest();

    expect(completed.searchParams.get("status")).toBe("connected");
    await expect(readStatus(org.actor)).resolves.toMatchObject({
      isConnected: true,
    });
    expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_ORIGIN",
        thread_ts: "42.0",
        user: org.slackUserId,
        text: "Your Slack account is connected. Bot tools use your own workspace's Okou installation.",
      }),
    );
    expect(welcomeRecipients()).toContain(org.slackUserId);
  });

  it("slack-connector-oauth-027 keeps the verified conversation context on denial and success", async () => {
    const org = await installedAdminWithoutChat();
    const origin = {
      workspaceId: org.slackWorkspaceId,
      slackUserId: org.slackUserId,
      channelId: "C_ORIGIN",
      threadTs: "42.0",
    };

    const denied = await startAccountConnect(org.actor, origin);
    const denial = await callback(org.actor, {
      error: "access_denied",
      state: denied.authorization.searchParams.get("state") ?? "",
    });

    expect(denial.pathname).toBe("/settings/slack");
    expect(Object.fromEntries(denial.searchParams)).toMatchObject({
      w: org.slackWorkspaceId,
      u: org.slackUserId,
      c: "C_ORIGIN",
      t: "42.0",
      error: "Slack authorization was not completed. Please try again.",
    });
    await expect(readStatus(org.actor)).resolves.toMatchObject({
      isConnected: false,
    });

    const retry = await startAccountConnect(org.actor, origin);
    const completed = await completeAtSlack(
      retry.authorization,
      { teamId: org.slackWorkspaceId, slackUserId: org.slackUserId },
      org.actor,
    );

    expect(completed.pathname).toBe("/settings/slack");
    expect(Object.fromEntries(completed.searchParams)).toMatchObject({
      status: "connected",
      w: org.slackWorkspaceId,
      u: org.slackUserId,
      c: "C_ORIGIN",
      t: "42.0",
    });
    await expect(readStatus(org.actor)).resolves.toMatchObject({
      isConnected: true,
    });
  });

  it("slack-connector-oauth-005 switching to a new home identity drops the old workspace bot capability", async () => {
    const org = await createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
    });
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/F_EARLIER",
      file_id: "F_EARLIER",
    });
    const init = await accept(
      clients()(integrationsSlackUploadInitContract).init({
        headers: await signIn(org.actor),
        body: { filename: "notes.txt", length: 5 },
      }),
      [200],
    );
    expect(init.status).toBe(200);
    const home = { teamId: uniqueTeamId(), slackUserId: uniqueSlackUserId() };
    const target = { workspaceId: home.teamId, slackUserId: home.slackUserId };

    const ordinary = await startAccountConnect(org.actor, target);
    const refused = await completeAtSlack(
      ordinary.authorization,
      home,
      org.actor,
    );

    expect(refused.searchParams.get("error")).toContain("Switch");
    await expect(readStatus(org.actor)).resolves.toMatchObject({
      isConnected: true,
      isInstalled: true,
    });

    const switched = await startAccountConnect(org.actor, target, "switch");
    const completed = await completeAtSlack(
      switched.authorization,
      home,
      org.actor,
    );

    expect(completed.searchParams.get("status")).toBe("connected");
    context.mocks.slack.chat.postMessage.mockClear();
    const message = await accept(
      clients()(integrationsSlackMessageContract).sendMessage({
        headers: await signIn(org.actor),
        body: { channel: "C_GENERAL", text: "hello" },
      }),
      [200, 404],
    );
    expect(message.status).toBe(404);
    const upload = await accept(
      clients()(integrationsSlackUploadCompleteContract).complete({
        headers: await signIn(org.actor),
        body: { fileId: "F_EARLIER", channel: "C_GENERAL" },
      }),
      [200, 404],
    );
    expect(upload.status).toBe(404);
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
  });

  it("slack-connector-oauth-024 replaces the previous identity after an explicit switch", async () => {
    const org = await createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
    });
    const newSlackUserId = uniqueSlackUserId();
    mockSlackIdentityLookup(context, {
      id: newSlackUserId,
      team_id: org.slackWorkspaceId,
      real_name: "New Slack User",
      profile: { display_name: "New Slack User" },
    });

    const { authorization } = await startAccountConnect(
      org.actor,
      { workspaceId: org.slackWorkspaceId, slackUserId: newSlackUserId },
      "switch",
    );
    const completed = await completeAtSlack(
      authorization,
      { teamId: org.slackWorkspaceId, slackUserId: newSlackUserId },
      org.actor,
    );

    expect(completed.searchParams.get("status")).toBe("connected");
    const linkStatus = async (actor: ApiTestUser, slackUserId: string) => {
      const response = await accept(
        clients()(slackConnectContract).getLinkStatus({
          headers: await signIn(actor),
          query: { workspaceId: org.slackWorkspaceId, slackUserId },
        }),
        [200],
      );
      return response.body.linkStatus;
    };
    await expect(linkStatus(org.actor, newSlackUserId)).resolves.toStrictEqual({
      kind: "connected",
    });
    await expect(linkStatus(org.actor, org.slackUserId)).resolves.toMatchObject(
      {
        kind: "slack_account_mismatch",
        currentSlackUserId: newSlackUserId,
      },
    );
    const other = createBddApi(context).user({
      orgId: org.orgId,
      orgRole: "org:member",
    });
    await expect(linkStatus(other, org.slackUserId)).resolves.toStrictEqual({
      kind: "connect",
    });
  });
});

describe("Slack bot installation", () => {
  it("slack-connector-oauth-031 protects the callback from a different signed-in user", async () => {
    configureSlack();
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const otherUser = bdd.user({ orgId: admin.orgId, orgRole: "org:admin" });
    const authorization = await followEntry(
      (await readStatus(admin)).installUrl,
    );
    const state = authorization.searchParams.get("state") ?? "";
    await signIn(otherUser);

    const browser = await accept(
      clients()(slackOauthContract).callback({
        extraHeaders: { cookie: "__session=clerk-session" },
        query: { code: "slack-code", state },
      }),
      [307],
    );

    expect(locationOf(browser).searchParams.get("integration")).toBe("slack");
    await expect(readStatus(admin)).resolves.toMatchObject({
      isInstalled: false,
      isConnected: false,
    });

    const json = await accept(
      clients()(slackOauthContract).callback({
        extraHeaders: await signIn(otherUser),
        query: { code: "slack-code", state, responseMode: "json" },
      }),
      [200],
    );

    expect(new URL(json.body.redirectUrl).searchParams.get("error")).toContain(
      "active account or organization changed",
    );
    await expect(listAccounts(admin)).resolves.toHaveLength(0);
  });
  it("slack-connector-oauth-014 grants bot and user scopes and connects one OAuth account", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const grant = { teamId: uniqueTeamId(), slackUserId: uniqueSlackUserId() };

    const { authorization, completed } = await installThroughSettings(
      admin,
      grant,
    );

    expect(authorization.origin).toBe("https://slack.com");
    expect(authorization.searchParams.get("scope")?.split(",")).toContain(
      "app_mentions:read",
    );
    const userScopes =
      authorization.searchParams.get("user_scope")?.split(",") ?? [];
    expect(userScopes).toContain("chat:write");
    expect(userScopes).not.toContain("identity.basic");
    expect(completed.searchParams.get("status")).toBe("connected");
    await expect(readStatus(admin)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
    });
    const accounts = await listAccounts(admin);
    expect(
      accounts.map((account) => {
        return [account.externalId, account.connectionStatus];
      }),
    ).toStrictEqual([[grant.slackUserId, "connected"]]);

    const replay = await completeAtSlack(authorization, grant, admin);

    expect(replay.searchParams.get("error")).toContain("already used");
    await expect(listAccounts(admin)).resolves.toHaveLength(1);
  });

  it("slack-connector-oauth-018 reinstall refreshes the existing connector and keeps the upgrade redirect", async () => {
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    const grant = { teamId: uniqueTeamId(), slackUserId: uniqueSlackUserId() };
    await installThroughSettings(admin, { ...grant, botScopes: "chat:write" });
    const [original] = await listAccounts(admin);
    const status = await readStatus(admin);
    expect(status.scopeMismatch).toBeTruthy();

    const authorization = await followEntry(status.reinstallUrl);
    const completed = await completeAtSlack(authorization, grant, admin);

    expect(authorization.searchParams.get("team")).toBe(grant.teamId);
    expect(completed.pathname).toBe("/settings/slack");
    expect(completed.searchParams.get("updated")).toBe("1");
    const accounts = await listAccounts(admin);
    expect(
      accounts.map((account) => {
        return account.id;
      }),
    ).toStrictEqual([original?.id]);
    await expect(readStatus(admin)).resolves.toMatchObject({
      scopeMismatch: false,
    });
  });

  it("slack-connector-oauth-025 lets an admin claim an anonymously installed workspace", async () => {
    configureSlack();
    const integrations = createBddIntegrationApi(context);
    const { teamId } = await integrations.installSlackWorkspace(null);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    await expect(readStatus(admin)).resolves.toMatchObject({
      isInstalled: false,
    });

    const { completed } = await installThroughSettings(admin, {
      teamId,
      slackUserId: uniqueSlackUserId(),
    });

    expect(completed.searchParams.get("status")).toBe("connected");
    await expect(readStatus(admin)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
      isAdmin: true,
    });
    await expect(listAccounts(admin)).resolves.toHaveLength(1);
  });
});

describe("Slack connector accounts", () => {
  it("slack-connector-oauth-015 reuses the OAuth account and keeps both disconnects independent", async () => {
    const org = await createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
    });
    const [original] = await listAccounts(org.actor);

    await disconnectChat(org.actor);

    await expect(readStatus(org.actor)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: false,
    });
    const afterChatDisconnect = await listAccounts(org.actor);
    expect(
      afterChatDisconnect.map((account) => {
        return [account.id, account.connectionStatus];
      }),
    ).toStrictEqual([[original?.id, "connected"]]);

    const authorization = await followEntry(
      (await readStatus(org.actor)).connectUrl,
    );
    expect(authorization.searchParams.has("scope")).toBeFalsy();
    expect(authorization.searchParams.get("user_scope")?.split(",")).toContain(
      "users:read",
    );
    const completed = await completeAtSlack(
      authorization,
      { teamId: org.slackWorkspaceId, slackUserId: org.slackUserId },
      org.actor,
    );
    expect(completed.searchParams.get("status")).toBe("connected");
    const reconnected = await listAccounts(org.actor);
    expect(
      reconnected.map((account) => {
        return account.id;
      }),
    ).toStrictEqual([original?.id]);

    // Slack revokes the deleted account's user token.
    server.use(
      http.post("https://slack.com/api/auth.revoke", () => {
        return HttpResponse.json({ ok: true, revoked: true });
      }),
    );
    await accept(
      clients()(connectorAccountsContract).delete({
        headers: await signIn(org.actor),
        params: { connectionId: original?.id ?? "" },
        body: { target: SLACK_TARGET },
      }),
      [200],
    );

    await expect(listAccounts(org.actor)).resolves.toHaveLength(0);
    await expect(readStatus(org.actor)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
    });
  });

  it("slack-connector-oauth-017 refuses a Slack identity already linked to another user", async () => {
    const org = await createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
    });
    const second = createBddApi(context).user({
      orgId: org.orgId,
      orgRole: "org:member",
    });

    const authorization = await followEntry(
      (await readStatus(second)).connectUrl,
    );
    const completed = await completeAtSlack(
      authorization,
      { teamId: org.slackWorkspaceId, slackUserId: org.slackUserId },
      second,
    );

    expect(completed.searchParams.get("error")).toContain("another user");
    await expect(listAccounts(second)).resolves.toHaveLength(0);
    await expect(readStatus(second)).resolves.toMatchObject({
      isConnected: false,
    });
    await expect(listAccounts(org.actor)).resolves.toHaveLength(1);
    await expect(readStatus(org.actor)).resolves.toMatchObject({
      isConnected: true,
    });
  });
});

describe("GET /api/integrations/slack/download-file", () => {
  it("slack-connector-oauth-007 downloads another member's file from a channel the user shares", async () => {
    const org = await createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
    });
    mockSharedSlackConversations(["C_USER_SHARED"]);
    const fetches = serveSlackFile({
      id: "F_ACCESS_CHECK",
      channels: ["C_USER_SHARED"],
    });

    const response = await downloadFile(org.actor, "F_ACCESS_CHECK");

    expect(response.status).toBe(200);
    expect(fetches).toHaveLength(1);
  });

  it("slack-connector-oauth-008 does not download a file only in a bot-only channel", async () => {
    const org = await createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
    });
    mockSharedSlackConversations(["C_USER_SHARED"]);
    const fetches = serveSlackFile({
      id: "F_ACCESS_CHECK",
      channels: ["C_BOT_ONLY"],
    });

    const response = await downloadFile(org.actor, "F_ACCESS_CHECK");

    expect(response.status).toBe(404);
    expect(fetches).toStrictEqual([]);
  });
});
