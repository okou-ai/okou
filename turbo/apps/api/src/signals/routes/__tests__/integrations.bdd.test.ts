import { randomUUID } from "node:crypto";

import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  AGENTPHONE_BDD_AGENT_ID,
  AGENTPHONE_BDD_PHONE_NUMBER,
  uniquePhoneHandle,
} from "./helpers/api-bdd-agentphone";
import {
  createBddIntegrationApi,
  mockSlackIdentityLookup,
} from "./helpers/api-bdd-integrations";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRouteMocks } from "./helpers/route-test";
import { uniqueSlackUserId } from "./helpers/slack-public-install";

const context = testContext();
const bdd = createBddApi(context);
const integrations = createBddIntegrationApi(context);
const runReads = createRunReadsApi(context);
const routeMocks = createRouteMocks(context);

const TELEGRAM_OFFICIAL_BOT_ID = "9876543210";

function signIn(actor: ApiTestUser): { authorization: string } {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function connectorAccountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function stringifyCalls(calls: readonly (readonly unknown[])[]): string[] {
  return calls.map((call) => {
    return JSON.stringify(call[0] ?? {});
  });
}

describe("INT-01: Slack integration and Slack app routes", () => {
  it("integrations.bdd-003 keeps Slack org and user connect status boundaries visible through APIs", async () => {
    const admin = bdd.user({ orgRole: "org:admin" });

    const unauthOrg = await integrations.requestSlackIntegrationStatus(
      null,
      [401],
    );
    expect(unauthOrg.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const unauthConnect = await integrations.requestSlackConnectStatus(
      null,
      [401],
    );
    expect(unauthConnect.body).toMatchObject({
      error: { code: "UNAUTHORIZED", message: "Not authenticated" },
    });

    const adminOrg = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(adminOrg.body).toMatchObject({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      connectUrl: null,
    });

    const adminConnect = await integrations.requestSlackConnectStatus(
      admin,
      [200],
    );
    expect(adminConnect.body).toStrictEqual({
      isConnected: false,
      isAdmin: true,
    });
  });

  it("integrations.bdd-001 keeps signed Slack Events API URL verification boundaries visible through APIs", async () => {
    mockOptionalEnv("SLACK_SIGNING_SECRET", undefined);
    const challengeBody = JSON.stringify({
      type: "url_verification",
      challenge: "slack-bdd-challenge",
    });

    const unconfigured = await integrations.requestSlackEvent(
      challengeBody,
      {},
      [503],
    );
    expect(unconfigured.body).toStrictEqual({
      error: "Slack integration is not configured",
    });

    integrations.configureSlackSigningSecret();

    const missingHeaders = await integrations.requestSlackEvent(
      challengeBody,
      {},
      [401],
    );
    expect(missingHeaders.body).toStrictEqual({
      error: "Missing Slack signature headers",
    });

    const currentTs = String(Math.floor(now() / 1000));
    const invalidSig = await integrations.requestSlackEvent(
      challengeBody,
      {
        "x-slack-request-timestamp": currentTs,
        "x-slack-signature": "v0=invalid",
      },
      [401],
    );
    expect(invalidSig.body).toStrictEqual({
      error: "Invalid signature",
    });

    const staleTs = String(Math.floor(now() / 1000) - 301);
    const staleSig = await integrations.requestSlackEvent(
      challengeBody,
      integrations.signedSlackIngressHeaders(challengeBody, staleTs),
      [401],
    );
    expect(staleSig.body).toStrictEqual({
      error: "Invalid signature",
    });

    const verified = await integrations.requestSlackEvent(
      challengeBody,
      integrations.signedSlackIngressHeaders(challengeBody),
      [200],
    );
    expect(verified.body).toStrictEqual({ challenge: "slack-bdd-challenge" });

    const retryBody = JSON.stringify({
      type: "event_callback",
      team_id: "TBDD_EVENT",
      event_id: `EvRetry${randomUUID()}`,
      event: {
        type: "app_mention",
        user: "UBDD",
        channel: "CBDD",
        text: "<@UBOT> retry",
        ts: "1710000000.000100",
      },
    });
    const retryResponse = await integrations.requestSlackEvent(
      retryBody,
      {
        ...integrations.signedSlackIngressHeaders(retryBody),
        "x-slack-retry-num": "1",
      },
      [200],
    );
    expect(retryResponse.body).toBe("OK");

    const signedEvents: readonly Record<string, unknown>[] = [
      { type: "app_home_opened", user: "UBDD", tab: "home" },
      { type: "app_home_opened", user: "UBDD", tab: "messages" },
      { type: "app_uninstalled" },
      { type: "tokens_revoked", tokens: { bot: ["UBOT"] } },
      { type: "team_join", user: { id: "UNEW" } },
    ];
    for (const event of signedEvents) {
      const payload = JSON.stringify({
        type: "event_callback",
        team_id: "TBDD_EVENT",
        event_id: `EvBDD${randomUUID()}`,
        event,
      });
      const response = await integrations.requestSlackEvent(
        payload,
        integrations.signedSlackIngressHeaders(payload),
        [200],
      );
      expect(response.body).toBe("OK");
    }
    await flushWaitUntilForTest();
  });

  it("integrations.bdd-004 keeps unauthenticated, not-installed, non-admin, and provider-config errors visible through APIs", async () => {
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", undefined);
    mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", undefined);
    mockEnv("APP_URL", "https://app.okou.test");

    await expect(
      integrations.requestListSlackChannels(null, [401]),
    ).resolves.toMatchObject({ body: { error: { code: "UNAUTHORIZED" } } });
    await expect(
      integrations.requestSendSlackMessage(
        null,
        { channel: "C123", text: "hi" },
        [401],
      ),
    ).resolves.toMatchObject({ body: { error: { code: "UNAUTHORIZED" } } });
    await expect(
      integrations.requestSlackDownloadFile(null, "F123", [401]),
    ).resolves.toMatchObject({ body: { error: { code: "UNAUTHORIZED" } } });
    await expect(
      integrations.requestSlackDisconnect(null, undefined, [401]),
    ).resolves.toMatchObject({ body: { error: { code: "UNAUTHORIZED" } } });

    await expect(
      integrations.requestListSlackChannels(admin, [404]),
    ).resolves.toMatchObject({
      body: { error: { message: "No Slack account connected for this user" } },
    });
    await expect(
      integrations.requestSendSlackMessage(
        admin,
        { channel: "C123", text: "hi" },
        [404],
      ),
    ).resolves.toMatchObject({ body: { error: { code: "NOT_FOUND" } } });
    await expect(
      integrations.requestSlackUploadInit(
        admin,
        {
          filename: "report.txt",
          length: 10,
        },
        [404],
      ),
    ).resolves.toMatchObject({ body: { error: { code: "NOT_FOUND" } } });
    await expect(
      integrations.requestSlackUploadComplete(
        admin,
        {
          fileId: "F123",
          channel: "C123",
        },
        [404],
      ),
    ).resolves.toMatchObject({ body: { error: { code: "NOT_FOUND" } } });
    await expect(
      integrations.requestSlackDownloadFile(admin, "F123", [404]),
    ).resolves.toMatchObject({
      body: { error: { message: "No Slack installation found for this org" } },
    });

    await expect(
      integrations.requestSlackDisconnect(member, undefined, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      integrations.requestSlackDisconnect(member, "uninstall", [403]),
    ).resolves.toMatchObject({
      body: { error: { message: "Admin access required" } },
    });
    await expect(
      integrations.requestSlackDisconnect(admin, "uninstall", [404]),
    ).resolves.toMatchObject({
      body: { error: { message: "No Slack installation found" } },
    });

    const unconfiguredInstall = await integrations.requestSlackOauthInstall(
      {},
      [503],
      admin,
    );
    expect(unconfiguredInstall.body).toStrictEqual({
      error: "Slack integration is not configured",
    });

    integrations.configureSlackOauthProvider();
    const configuredInstall = await integrations.requestSlackOauthInstall(
      {},
      [307],
      admin,
    );
    const authorizeUrl = new URL(
      configuredInstall.headers.get("location") ?? "",
    );
    expect(authorizeUrl.hostname).toBe("slack.com");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(
      "slack-bdd-client-id",
    );
    expect(authorizeUrl.searchParams.get("scope")).toContain("chat:write");

    const callbackError = await integrations.requestSlackOauthCallback(
      { error: "access_denied" },
      [307],
    );
    const errorRedirect = new URL(callbackError.headers.get("location") ?? "");
    expect(errorRedirect.pathname).toBe("/settings/slack");
    expect(errorRedirect.searchParams.get("error")).toBe("access_denied");
  });

  it("integrations.bdd-005 (1/3) installs a Slack workspace and exposes admin and member statuses", async () => {
    integrations.configureSlackAppMocks();
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });

    const beforeInstall = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(beforeInstall.body).toMatchObject({
      isConnected: false,
      isInstalled: false,
    });

    const installed = await integrations.installSlackWorkspace(admin);
    await flushWaitUntilForTest();

    const adminStatus = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(adminStatus.body).toMatchObject({
      isConnected: true,
      isInstalled: true,
      workspaceName: `BDD Slack App ${installed.teamId}`,
      scopeMismatch: false,
      reinstallUrl: null,
    });

    const memberStatus = await integrations.requestSlackIntegrationStatus(
      member,
      [200],
    );
    expect(memberStatus.body).toMatchObject({
      isInstalled: true,
      isConnected: false,
    });
    if (!("connectUrl" in memberStatus.body)) {
      throw new Error("Expected Slack integration status body");
    }
    expect(memberStatus.body.connectUrl).toContain("connectorState=");

    const memberConnect = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(memberConnect.body).toStrictEqual({
      isConnected: false,
      isAdmin: false,
    });
  });

  it("integrations.bdd-005 (2/3) connects and disconnects a member on an installed Slack workspace", async () => {
    integrations.configureSlackAppMocks();
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const installed = await integrations.installSlackWorkspace(admin);
    await flushWaitUntilForTest();

    const memberSlackUserId = uniqueSlackUserId();
    await integrations.connectSlackUser(member, {
      workspaceId: installed.teamId,
      slackUserId: memberSlackUserId,
    });
    await flushWaitUntilForTest();

    const connectedMember = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(connectedMember.body).toMatchObject({
      isConnected: true,
      workspaceName: `BDD Slack App ${installed.teamId}`,
    });

    const disconnected = await integrations.requestSlackDisconnect(
      member,
      undefined,
      [200],
    );
    expect(disconnected.body).toStrictEqual({ ok: true });
    await expect(
      integrations.requestSlackConnectStatus(member, [200]),
    ).resolves.toMatchObject({ body: { isConnected: false } });
  });

  it("integrations.bdd-005 (3/3) uninstalls the Slack workspace and publishes the App Home settings link", async () => {
    integrations.configureSlackAppMocks();
    const admin = bdd.user({ orgRole: "org:admin" });
    const installed = await integrations.installSlackWorkspace(admin);
    await flushWaitUntilForTest();

    integrations.clearSlackCallHistory();
    const uninstalled = await integrations.requestSlackDisconnect(
      admin,
      "uninstall",
      [200],
    );
    expect(uninstalled.body).toStrictEqual({ ok: true });
    await flushWaitUntilForTest();

    const publishedViews = stringifyCalls(
      context.mocks.slack.views.publish.mock.calls,
    );
    expect(publishedViews).toHaveLength(1);
    expect(publishedViews[0]).toContain(installed.installerSlackUserId);
    expect(publishedViews[0]).toContain("Open Okou Settings");
    expect(publishedViews[0]).toContain("https://app.okou.test/settings/slack");

    const afterUninstall = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    expect(afterUninstall.body).toMatchObject({
      isConnected: true,
      isInstalled: false,
    });
  });
});

describe("INT-01: Slack app deep webhook flows", () => {
  it("integrations.bdd-014 rejects external Slack ingress with a different workspace", async () => {
    integrations.configureSlackAppMocks();
    const member = bdd.user({ orgRole: "org:admin" });
    const otherAdmin = bdd.user({ orgRole: "org:admin" });
    const home = await integrations.installSlackWorkspace(member);
    await flushWaitUntilForTest();
    await integrations.postSlackEvent(home.teamId, { type: "app_uninstalled" });
    await flushWaitUntilForTest();

    const otherWorkspace = await integrations.installSlackWorkspace(otherAdmin);
    await flushWaitUntilForTest();

    mockSlackIdentityLookup(context, {
      id: home.installerSlackUserId,
      team_id: "T_UNCONNECTED_IDENTITY",
      real_name: "External User",
      profile: { email: member.email, display_name: "External User" },
    });

    await integrations.postSlackEvent(otherWorkspace.teamId, {
      type: "app_mention",
      user: home.installerSlackUserId,
      channel: "C_EXT",
      text: `<@${otherWorkspace.botUserId}> run this`,
      ts: "1710000100.000100",
    });
    await flushWaitUntilForTest();

    const logs = await runReads.requestListLogs(
      member,
      { limit: 20, triggerSource: "slack" },
      [200],
    );
    expect(logs.body.data).toStrictEqual([]);
  });

  it("integrations.bdd-045 prompts disconnected Slack users and filters non-actionable messages", async () => {
    integrations.configureSlackAppMocks();
    const admin = bdd.user({ orgRole: "org:admin" });
    const workspace = await integrations.installSlackWorkspace(admin);
    const unbound = await integrations.installSlackWorkspace(null);
    await flushWaitUntilForTest();

    const unconnectedUser = uniqueSlackUserId();
    mockSlackIdentityLookup(context, {
      id: unconnectedUser,
      team_id: workspace.teamId,
      real_name: "Unlinked User",
      profile: { display_name: "Unlinked User" },
    });
    integrations.clearSlackCallHistory();

    await integrations.postSlackEvent(workspace.teamId, {
      type: "app_mention",
      user: unconnectedUser,
      channel: "C_DISC",
      text: `<@${workspace.botUserId}> hello`,
      ts: "1710000200.000100",
    });
    await flushWaitUntilForTest();
    const ephemerals = stringifyCalls(
      context.mocks.slack.chat.postEphemeral.mock.calls,
    );
    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]?.toLowerCase()).toContain("connect your account");

    integrations.clearSlackCallHistory();
    await integrations.postSlackEvent(workspace.teamId, {
      type: "message",
      channel_type: "im",
      user: unconnectedUser,
      channel: "D_DISC",
      text: "hello dm",
      ts: "1710000201.000100",
    });
    await flushWaitUntilForTest();
    const dmMessages = stringifyCalls(
      context.mocks.slack.chat.postMessage.mock.calls,
    );
    expect(dmMessages).toHaveLength(1);
    expect(dmMessages[0]).toContain("Please connect your account first");

    integrations.clearSlackCallHistory();
    await integrations.postSlackEvent(workspace.teamId, {
      type: "message",
      channel_type: "im",
      bot_id: "B_OTHER",
      channel: "D_DISC",
      text: "bot dm",
      ts: "1710000202.000100",
    });
    await integrations.postSlackEvent(workspace.teamId, {
      type: "message",
      subtype: "message_changed",
      channel_type: "im",
      channel: "D_DISC",
      ts: "1710000203.000100",
    });
    await integrations.postSlackEvent(workspace.teamId, {
      type: "message",
      channel_type: "channel",
      user: unconnectedUser,
      channel: "C_DISC",
      text: "plain channel chatter",
      ts: "1710000204.000100",
    });
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.postMessage.mock.calls).toStrictEqual([]);
    expect(context.mocks.slack.chat.postEphemeral.mock.calls).toStrictEqual([]);

    await integrations.postSlackEvent(workspace.teamId, {
      type: "message",
      subtype: "file_share",
      channel_type: "im",
      user: unconnectedUser,
      channel: "D_DISC",
      text: "uploaded file",
      ts: "1710000205.000100",
    });
    await flushWaitUntilForTest();
    const fileShareMessages = stringifyCalls(
      context.mocks.slack.chat.postMessage.mock.calls,
    );
    expect(fileShareMessages).toHaveLength(1);
    expect(fileShareMessages[0]).toContain("Please connect your account first");

    integrations.clearSlackCallHistory();
    await integrations.postSlackEvent(unbound.teamId, {
      type: "message",
      channel_type: "im",
      user: unconnectedUser,
      channel: "D_UNBOUND",
      text: "hello unbound",
      ts: "1710000206.000100",
    });
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.postMessage.mock.calls).toStrictEqual([]);
    expect(context.mocks.slack.chat.postEphemeral.mock.calls).toStrictEqual([]);
    expect(context.mocks.slack.users.info.mock.calls).toStrictEqual([]);
  });

  it("integrations.bdd-047 serves Slack help, connect, and disconnect commands", async () => {
    integrations.configureSlackAppMocks();
    const member = bdd.user({ orgRole: "org:admin" });
    await bdd.bootstrapLimitedFreeOnboarding(member);
    const workspace = await integrations.installSlackWorkspace(member);
    await flushWaitUntilForTest();

    const runCommand = async (text: string) => {
      return JSON.stringify(
        await integrations.postSlackCommand({
          teamId: workspace.teamId,
          userId: workspace.installerSlackUserId,
          channelId: "C_CMD",
          text,
        }),
      );
    };

    for (const helpInput of ["", "help", "unknown"]) {
      const reply = await runCommand(helpInput);
      expect(reply).toContain(`<@${workspace.botUserId}> Slack Bot Help`);
      expect(reply).toContain("/okou help");
      expect(reply).toContain("/okou connect");
      expect(reply).toContain("/okou disconnect");
      expect(reply).toContain(`<@${workspace.botUserId}>`);
    }

    const alreadyConnected = await runCommand("connect");
    expect(alreadyConnected.toLowerCase()).toContain("already connected");

    integrations.clearSlackCallHistory();
    const firstDisconnect = await runCommand("disconnect");
    expect(firstDisconnect.toLowerCase()).toContain("disconnected");
    await flushWaitUntilForTest();
    expect(
      context.mocks.slack.views.publish.mock.calls.length,
    ).toBeGreaterThanOrEqual(1);

    const afterDisconnect = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(afterDisconnect.body).toMatchObject({ isConnected: false });

    const secondDisconnect = await runCommand("disconnect");
    expect(secondDisconnect.toLowerCase()).toContain("not connected");

    const finalConnect = await runCommand("connect");
    expect(finalConnect).toContain("https://app.okou.test/settings/slack");
  });

  it("integrations.bdd-050 (1/5) sends a DM welcome when reconnecting from a channel", async () => {
    integrations.configureSlackAppMocks();
    mockEnv("APP_URL", "https://app.okou.ai");
    const member = bdd.user({ orgRole: "org:admin" });
    await bdd.bootstrapLimitedFreeOnboarding(member);
    const workspace = await integrations.installSlackWorkspace(member);
    await flushWaitUntilForTest();
    await integrations.requestSlackDisconnect(member, undefined, [200]);
    integrations.clearSlackCallHistory();

    await integrations.connectSlackUser(member, {
      workspaceId: workspace.teamId,
      slackUserId: workspace.installerSlackUserId,
      channelId: "C_BDD_HOME",
    });
    await flushWaitUntilForTest();

    const welcomes = stringifyCalls(
      context.mocks.slack.chat.postMessage.mock.calls,
    );
    expect(
      welcomes.some((msg) => {
        return msg.includes("Hi! I'm");
      }),
    ).toBeTruthy();
  });

  it("integrations.bdd-050 (2/5) publishes the connected App Home and sends nothing on Messages tab opens", async () => {
    integrations.configureSlackAppMocks();
    mockEnv("APP_URL", "https://app.okou.ai");
    const member = bdd.user({ orgRole: "org:admin" });
    await bdd.bootstrapLimitedFreeOnboarding(member);
    const workspace = await integrations.installSlackWorkspace(member);
    await flushWaitUntilForTest();

    integrations.clearSlackCallHistory();
    await integrations.postSlackEvent(workspace.teamId, {
      type: "app_home_opened",
      user: workspace.installerSlackUserId,
      tab: "home",
    });
    await integrations.postSlackEvent(workspace.teamId, {
      type: "app_home_opened",
      user: workspace.installerSlackUserId,
      tab: "home",
    });
    await integrations.postSlackEvent(workspace.teamId, {
      type: "app_home_opened",
      user: workspace.installerSlackUserId,
      tab: "messages",
    });
    await integrations.postSlackEvent(workspace.teamId, {
      type: "app_home_opened",
      user: workspace.installerSlackUserId,
      tab: "messages",
    });
    await flushWaitUntilForTest();

    const connectedViews = stringifyCalls(
      context.mocks.slack.views.publish.mock.calls,
    );
    expect(connectedViews.length).toBeGreaterThanOrEqual(1);
    const connectedHome = connectedViews[0] ?? "";
    expect(connectedHome).toContain("home_environment_setup");
    expect(connectedHome).toContain("https://app.okou.ai/works");
    expect(connectedHome).toContain("Connected to Okou");
    expect(connectedHome).toContain("/okou help");
    expect(connectedHome).toContain("chat with Okou");
    expect(connectedHome).toContain("/okou connect");
    expect(connectedHome).toContain("/okou disconnect");
    expect(context.mocks.slack.chat.postMessage.mock.calls).toStrictEqual([]);
  });

  it("integrations.bdd-050 (3/5) disconnects via App Home once, updates the view, and clears state on uninstall", async () => {
    integrations.configureSlackAppMocks();
    mockEnv("APP_URL", "https://app.okou.ai");
    const member = bdd.user({ orgRole: "org:admin" });
    await bdd.bootstrapLimitedFreeOnboarding(member);
    const workspace = await integrations.installSlackWorkspace(member);
    await flushWaitUntilForTest();

    integrations.clearSlackCallHistory();
    const firstClick = await integrations.postSlackInteractive({
      type: "block_actions",
      team: { id: workspace.teamId },
      user: { id: workspace.installerSlackUserId },
      actions: [{ action_id: "home_disconnect" }],
    });
    expect(firstClick).toBe("");
    await flushWaitUntilForTest();
    const disconnectViews = stringifyCalls(
      context.mocks.slack.views.publish.mock.calls,
    );
    expect(disconnectViews).toHaveLength(1);
    expect(disconnectViews[0]).toContain("https://app.okou.ai/settings/slack");
    await expect(
      integrations.requestSlackConnectStatus(member, [200]),
    ).resolves.toMatchObject({ body: { isConnected: false } });

    integrations.clearSlackCallHistory();
    await integrations.postSlackInteractive({
      type: "block_actions",
      team: { id: workspace.teamId },
      user: { id: workspace.installerSlackUserId },
      actions: [{ action_id: "home_disconnect" }],
    });
    await flushWaitUntilForTest();
    expect(context.mocks.slack.views.publish.mock.calls).toStrictEqual([]);

    await integrations.postSlackEvent(workspace.teamId, {
      type: "app_home_opened",
      user: workspace.installerSlackUserId,
      tab: "home",
    });
    await integrations.postSlackEvent(workspace.teamId, {
      type: "app_home_opened",
      user: workspace.installerSlackUserId,
      tab: "messages",
    });
    await flushWaitUntilForTest();
    const disconnectedHome =
      stringifyCalls(context.mocks.slack.views.publish.mock.calls).at(-1) ?? "";
    expect(disconnectedHome).toContain("Account not connected");
    expect(disconnectedHome).toContain("home_login_prompt");
    expect(disconnectedHome).toContain(
      `https://app.okou.ai/settings/slack?w=${workspace.teamId}&u=${workspace.installerSlackUserId}`,
    );
    expect(context.mocks.slack.chat.postMessage.mock.calls).toStrictEqual([]);

    await integrations.postSlackEvent(workspace.teamId, {
      type: "app_uninstalled",
    });
    await flushWaitUntilForTest();
    await expect(
      integrations.requestSlackIntegrationStatus(member, [200]),
    ).resolves.toMatchObject({
      body: { isInstalled: false, isConnected: false },
    });
  });

  it("integrations.bdd-050 (4/5) publishes no App Home after an unbound workspace is uninstalled", async () => {
    integrations.configureSlackAppMocks();
    const unbound = await integrations.installSlackWorkspace(null);
    await flushWaitUntilForTest();
    await integrations.postSlackEvent(unbound.teamId, {
      type: "app_uninstalled",
    });
    await flushWaitUntilForTest();

    integrations.clearSlackCallHistory();
    await integrations.postSlackEvent(unbound.teamId, {
      type: "app_home_opened",
      user: unbound.installerSlackUserId,
      tab: "home",
    });
    await flushWaitUntilForTest();
    expect(context.mocks.slack.views.publish.mock.calls).toStrictEqual([]);
  });

  it("integrations.bdd-050 (5/5) clears installation while preserving user connection on tokens_revoked", async () => {
    integrations.configureSlackAppMocks();
    const member = bdd.user({ orgRole: "org:admin" });
    const unbound = await integrations.installSlackWorkspace(null);
    await flushWaitUntilForTest();
    await integrations.connectSlackUser(member, {
      workspaceId: unbound.teamId,
      slackUserId: uniqueSlackUserId(),
    });
    await flushWaitUntilForTest();

    await integrations.postSlackEvent(unbound.teamId, {
      type: "tokens_revoked",
      tokens: { bot: [unbound.botUserId] },
    });
    await flushWaitUntilForTest();
    await expect(
      integrations.requestSlackIntegrationStatus(member, [200]),
    ).resolves.toMatchObject({
      body: { isInstalled: false, isConnected: true },
    });
  });
});

describe("INT-02: Telegram integration", () => {
  it("integrations.bdd-056 keeps Telegram webhook missing, auth, and no-op update boundaries visible", async () => {
    mockOptionalEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", undefined);
    mockOptionalEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", undefined);
    mockOptionalEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", undefined);

    const unconfigured = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({ update_id: 1 }),
      {},
      [404],
    );
    expect(unconfigured.body).toBe("Not Found");

    const secret = `tg-secret-${randomUUID()}`;
    mockEnv(
      "TELEGRAM_OFFICIAL_BOT_TOKEN",
      `${TELEGRAM_OFFICIAL_BOT_ID}:${randomUUID()}`,
    );
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", secret);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "official_okou_bot");

    const missingSecret = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({ update_id: 2 }),
      {},
      [401],
    );
    expect(missingSecret.body).toBe("Unauthorized");

    const badSecret = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({ update_id: 3 }),
      { "x-telegram-bot-api-secret-token": "bad-secret" },
      [401],
    );
    expect(badSecret.body).toBe("Unauthorized");

    const noMessage = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({ update_id: 4 }),
      { "x-telegram-bot-api-secret-token": secret },
      [200],
    );
    expect(noMessage.body).toBe("OK");

    const emptyPrivateMessage = await integrations.requestTelegramWebhook(
      OFFICIAL_TELEGRAM_BOT_ID,
      JSON.stringify({
        update_id: 5,
        message: {
          message_id: 10,
          date: Math.floor(now() / 1000),
          chat: { id: 1001, type: "private" },
          from: { id: 1001, is_bot: false, first_name: "Test" },
        },
      }),
      { "x-telegram-bot-api-secret-token": secret },
      [200],
    );
    expect(emptyPrivateMessage.body).toBe("OK");
  });
});

describe("INT-03: GitHub and AgentPhone integrations", () => {
  it("integrations.bdd-061 starts configured GitHub user OAuth with connector state", async () => {
    integrations.clearGithubAppProvider();
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "bdd-github-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "bdd-github-client-secret");

    const exchangedRedirectUris: (string | null)[] = [];
    server.use(
      http.post(
        "https://github.com/login/oauth/access_token",
        async ({ request }) => {
          const form = new URLSearchParams(await request.text());
          exchangedRedirectUris.push(form.get("redirect_uri"));
          return HttpResponse.json({
            access_token: "gho_bdd_token",
            scope: "repo,project,workflow",
          });
        },
      ),
      http.get("https://api.github.com/user", () => {
        return HttpResponse.json({
          id: 4242,
          login: "bdd-github-user",
          email: null,
        });
      }),
    );

    const actor = bdd.user({ orgRole: "org:admin" });
    const started = await integrations.requestGithubOauthConnect(
      actor,
      {},
      [307],
    );
    expect(started.headers.get("cache-control")).toBe("no-store");
    const authorizeUrl = new URL(started.headers.get("location") ?? "");
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe(
      "bdd-github-client-id",
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/connectors/github/callback",
    );
    const state = authorizeUrl.searchParams.get("state") ?? "";
    expect(state).toMatch(/^[0-9a-f]{64}$/u);

    const beforeAccounts = await accept(
      connectorAccountsClient().connections({
        headers: signIn(actor),
        query: { kind: "builtin", connectorSlug: "github" },
      }),
      [200],
    );
    expect(beforeAccounts.body.connections).toStrictEqual([]);

    const callbackRequest = setupRawAppRequest({
      context,
      routes: builtinConnectorsSlugCallbackRoutes,
    });
    const callbackResponse = await callbackRequest(
      `https://api.okou.ai/api/connectors/github/callback?${new URLSearchParams({ code: "bdd-gh-code", state }).toString()}`,
      { method: "GET" },
    );
    expect(callbackResponse.status).toBe(307);
    const successUrl = new URL(callbackResponse.headers.get("location") ?? "");
    expect(`${successUrl.origin}${successUrl.pathname}`).toBe(
      "https://app.okou.ai/connector/success",
    );
    expect(successUrl.searchParams.has("message")).toBeFalsy();
    expect(exchangedRedirectUris).toStrictEqual([
      "https://api.okou.ai/api/connectors/github/callback",
    ]);

    const afterAccounts = await accept(
      connectorAccountsClient().connections({
        headers: signIn(actor),
        query: { kind: "builtin", connectorSlug: "github" },
      }),
      [200],
    );
    expect(afterAccounts.body.connections).toHaveLength(1);
    expect(afterAccounts.body.connections[0]).toMatchObject({
      externalId: "4242",
      externalUsername: "bdd-github-user",
      externalEmail: null,
      connectionStatus: "connected",
    });
  });

  it("integrations.bdd-064 keeps GitHub no-install read and upload-init surfaces visible through APIs", async () => {
    integrations.configureGithubAppInstallProvider();
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    context.mocks.s3.send.mockResolvedValue({});

    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });

    const adminRead = await integrations.readGithubInstallation(admin);
    expect(adminRead.status).toBe(404);
    expect(adminRead.body).toMatchObject({
      error: { message: "No GitHub installation found" },
    });
    if (!("installUrl" in adminRead.body) || !adminRead.body.installUrl) {
      throw new Error("Expected admin GitHub install URL");
    }
    const installUrl = new URL(adminRead.body.installUrl);
    expect(`${installUrl.origin}${installUrl.pathname}`).toBe(
      "https://github.com/apps/bdd-github-app/installations/new",
    );
    expect(installUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/github/app/setup/callback",
    );

    const memberRead = await integrations.readGithubInstallation(member);
    expect(memberRead.status).toBe(404);
    expect(memberRead.body).toMatchObject({ installUrl: null });

    const init = await integrations.requestGithubUploadInit(
      admin,
      {
        filename: "artifact.txt",
        contentType: "text/plain",
        length: 10,
      },
      [200],
    );
    expect(init.body).toMatchObject({
      filename: "artifact.txt",
      contentType: "text/plain",
      size: 10,
    });
    if (!("uploadUrl" in init.body)) {
      throw new Error("Expected GitHub upload init body");
    }
    expect(new URL(init.body.uploadUrl).protocol).toMatch(/^https?:$/u);

    const complete = await integrations.requestGithubUploadComplete(
      admin,
      {
        uploadId: init.body.uploadId,
        repo: "okou-ai/okou",
        issueNumber: 1,
      },
      [404],
    );
    expect(complete.body).toMatchObject({
      error: { message: "No GitHub installation found" },
    });
  });

  it("integrations.bdd-065 keeps AgentPhone status, invalid connect, auth, and unlinked-send errors visible through APIs", async () => {
    integrations.configureAgentPhoneProvider();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        const err = new Error("NotFound");
        err.name = "NotFound";
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const user = bdd.user({ orgRole: "org:admin" });
    const status = await integrations.getAgentPhoneLinkStatus(user);
    expect(status).toStrictEqual({
      linked: false,
      agentPhoneNumber: AGENTPHONE_BDD_PHONE_NUMBER,
      configured: true,
    });

    const badConnect = await integrations.requestConnectAgentPhone(
      user,
      {
        phoneHandle: uniquePhoneHandle(),
        agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
        timestamp: Math.floor(now() / 1000),
        signature: "bad-signature",
      },
      [400],
    );
    expect(badConnect.body).toMatchObject({ error: { code: "BAD_REQUEST" } });

    const unauthSend = await integrations.requestSendPhoneMessage(
      null,
      { text: "hello" },
      [401],
    );
    expect(unauthSend.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const unlinkedSend = await integrations.requestSendPhoneMessage(
      user,
      { text: "hello" },
      [404],
    );
    expect(unlinkedSend.body).toMatchObject({
      error: { message: "No phone is connected to this Okou account" },
    });

    const uploadInit = await integrations.requestPhoneUploadInit(
      user,
      {
        filename: "agentphone-note.txt",
        contentType: "text/plain",
        length: 13,
      },
      [200],
    );
    expect(uploadInit.body).toMatchObject({
      filename: "agentphone-note.txt",
      contentType: "text/plain",
      size: 13,
    });
    if (!("uploadUrl" in uploadInit.body)) {
      throw new Error("Expected phone upload init body");
    }
    expect(new URL(uploadInit.body.uploadUrl).protocol).toMatch(/^https?:$/u);

    const uploadComplete = await integrations.requestPhoneUploadComplete(
      user,
      { uploadId: uploadInit.body.uploadId },
      [404],
    );
    expect(uploadComplete.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});
