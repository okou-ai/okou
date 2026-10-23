import { randomUUID } from "node:crypto";

import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { beforeEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { integrationsSlackRoutes } from "../integrations-slack";
import { slackOauthRoutes } from "../slack-oauth";

const context = testContext();
const mocks = createRouteMocks(context);
const slackOrgs = createPublicSlackOrgApi(context);
const integrations = createBddIntegrationApi(context);

describe("GET /api/integrations/slack", () => {
  const track = createFixtureTracker<{
    readonly orgId: string;
    readonly slackWorkspaceId: string;
  }>((fixture) => {
    return slackOrgs.uninstallWorkspace(fixture.slackWorkspaceId);
  });

  async function installSlackViaOAuth(args: {
    readonly apiOrigin: string;
    readonly botScopes?: string;
    readonly installerUserId: string;
    readonly orgId: string;
    readonly slackWorkspaceId: string;
  }): Promise<{ readonly orgId: string; readonly slackWorkspaceId: string }> {
    mocks.clerk.session(args.installerUserId, args.orgId, "org:admin");
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          organization: { id: args.orgId },
          role: "org:admin",
          createdAt: 1,
        },
      ],
    });

    const oauthClient = setupApp({
      baseUrl: args.apiOrigin,
      context,
      routes: slackOauthRoutes,
    })(slackOauthContract);
    const started = await accept(
      oauthClient.install({
        query: {},
        extraHeaders: { authorization: "Bearer clerk-session" },
      }),
      [307],
    );
    const authorizationUrl = new URL(started.headers.get("location") ?? "");
    const state = authorizationUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Expected Slack OAuth install state");
    }

    context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
      ok: true,
      access_token: `xoxb-${args.slackWorkspaceId}`,
      bot_user_id: `B_${args.slackWorkspaceId}`,
      team: {
        id: args.slackWorkspaceId,
        name: `Workspace ${args.slackWorkspaceId}`,
      },
      authed_user: { id: `U_${args.slackWorkspaceId}` },
      scope: args.botScopes ?? authorizationUrl.searchParams.get("scope") ?? "",
    });
    await accept(
      oauthClient.callback({
        extraHeaders: { authorization: "Bearer clerk-session" },
        query: { code: `code-${args.slackWorkspaceId}`, state },
      }),
      [307],
    );
    await integrations.connectSlackUser(
      integrations.user({
        userId: args.installerUserId,
        orgId: args.orgId,
        orgRole: "org:admin",
      }),
      {
        workspaceId: args.slackWorkspaceId,
        slackUserId: `U_${args.slackWorkspaceId}`,
      },
    );

    return { orgId: args.orgId, slackWorkspaceId: args.slackWorkspaceId };
  }

  beforeEach(() => {
    mockEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
    mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
    mockEnv("SECRETS_ENCRYPTION_KEY", "0".repeat(64));
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", undefined);
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "mock.ts",
      channel: "D_TEST",
    });
    context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
  });

  async function startStatusOAuth(url: string, orgId: string): Promise<URL> {
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          organization: { id: orgId },
          role: "org:admin",
          createdAt: 1,
        },
      ],
    });
    const entry = new URL(url);
    const query = Object.fromEntries(entry.searchParams);
    const client = setupApp({
      baseUrl: entry.origin,
      context,
      routes: slackOauthRoutes,
    })(slackOauthContract);
    const response = entry.pathname.endsWith("/install")
      ? await client.install({ query })
      : await client.connect({ query });
    const redirect = await accept(Promise.resolve(response), [307]);
    const location = redirect.headers.get("location");
    if (!location) {
      throw new Error("Expected Slack OAuth authorization redirect");
    }
    return new URL(location);
  }

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("keeps successive status requests scoped to their user and organization", async () => {
    const orgId = `org_${randomUUID()}`;
    const adminUserId = `user_${randomUUID()}`;
    const memberUserId = `user_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;
    const slackWorkspaceId = `T_${randomUUID()}`;
    await track(
      installSlackViaOAuth({
        apiOrigin: "https://api.okou.ai",
        installerUserId: adminUserId,
        orgId,
        slackWorkspaceId,
      }),
    );
    const firstClient = setupApp({
      baseUrl: "https://first.example.test",
      context,
      routes: integrationsSlackRoutes,
    })(integrationsSlackContract);
    const secondClient = setupApp({
      baseUrl: "https://second.example.test",
      context,
      routes: integrationsSlackRoutes,
    })(integrationsSlackContract);
    const request = { headers: { authorization: "Bearer clerk-session" } };

    mocks.clerk.session(adminUserId, orgId, "org:admin");
    const connected = await accept(firstClient.getStatus(request), [200]);
    expect(connected.body).toStrictEqual({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      workspaceName: `Workspace ${slackWorkspaceId}`,
      defaultAgentName: null,
      scopeMismatch: false,
      reinstallUrl: null,
    });

    mocks.clerk.session(memberUserId, orgId, "org:member");
    const member = await accept(secondClient.getStatus(request), [200]);
    expect(member.body).toStrictEqual({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
      installUrl: null,
      connectUrl: expect.any(String),
    });
    const connectUrl = new URL(member.body.connectUrl!);
    expect(`${connectUrl.origin}${connectUrl.pathname}`).toBe(
      "https://api.okou.ai/api/slack/oauth/connect",
    );
    const connectAuthorization = await startStatusOAuth(
      connectUrl.toString(),
      orgId,
    );
    expect(connectAuthorization.searchParams.get("team")).toBe(
      slackWorkspaceId,
    );

    mocks.clerk.session(adminUserId, otherOrgId, "org:admin");
    const uninstalled = await accept(firstClient.getStatus(request), [200]);
    expect(uninstalled.body).toStrictEqual({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: expect.any(String),
      connectUrl: null,
    });
    const installUrl = new URL(uninstalled.body.installUrl!);
    expect(`${installUrl.origin}${installUrl.pathname}`).toBe(
      "https://api.okou.ai/api/slack/oauth/install",
    );

    mocks.clerk.session(adminUserId, orgId, "org:admin");
    const returned = await accept(secondClient.getStatus(request), [200]);
    expect(returned.body).toStrictEqual(connected.body);
  });

  it("returns null OAuth URLs when OAuth is disabled after installation", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(
      installSlackViaOAuth({
        apiOrigin: "https://api.okou.ai",
        botScopes: "chat:write",
        installerUserId: `user_${randomUUID()}`,
        orgId,
        slackWorkspaceId: `T_${randomUUID()}`,
      }),
    );
    mockEnv("SLACK_OAUTH_CLIENT_ID", undefined);
    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );
    const request = { headers: { authorization: "Bearer clerk-session" } };

    mocks.clerk.session(userId, orgId, "org:admin");
    const installed = await accept(client.getStatus(request), [200]);
    expect(installed.body).toStrictEqual({
      isConnected: false,
      isInstalled: true,
      isAdmin: true,
      installUrl: null,
      connectUrl: null,
      scopeMismatch: true,
      reinstallUrl: null,
    });

    mocks.clerk.session(userId, `org_${randomUUID()}`, "org:admin");
    const uninstalled = await accept(client.getStatus(request), [200]);
    expect(uninstalled.body).toStrictEqual({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: null,
      connectUrl: null,
    });
  });

  it("returns isConnected=false when user has no connection", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await slackOrgs.installForOrg({ orgId });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isConnected).toBeFalsy();
    const connectUrl = new URL(response.body.connectUrl!);
    expect(`${connectUrl.origin}${connectUrl.pathname}`).toBe(
      "https://api.okou.ai/api/slack/oauth/connect",
    );
    const authorizationUrl = await startStatusOAuth(
      connectUrl.toString(),
      orgId,
    );
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(authorizationUrl.searchParams.get("team")).toBe(
      fixture.slackWorkspaceId,
    );
    expect(authorizationUrl.searchParams.has("user_scope")).toBeTruthy();
  });

  it("returns Okou install URLs on the API origin when Slack is not installed", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const installUrl = new URL(response.body.installUrl!);
    expect(`${installUrl.origin}${installUrl.pathname}`).toBe(
      "https://api.okou.ai/api/slack/oauth/install",
    );
    const authorizationUrl = await startStatusOAuth(
      installUrl.toString(),
      orgId,
    );
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(authorizationUrl.searchParams.has("scope")).toBeTruthy();
    expect(authorizationUrl.searchParams.has("user_scope")).toBeTruthy();
  });

  it("returns Okou install URLs on the Okou API origin", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({
      baseUrl: "https://api.okou.ai",
      context,
      routes: integrationsSlackRoutes,
    })(integrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const installUrl = new URL(response.body.installUrl!);
    expect(`${installUrl.origin}${installUrl.pathname}`).toBe(
      "https://api.okou.ai/api/slack/oauth/install",
    );
  });

  it("returns Okou connect URLs on the Okou API origin", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const installerUserId = `user_${randomUUID()}`;
    const slackWorkspaceId = `T_${randomUUID()}`;
    await track(
      installSlackViaOAuth({
        apiOrigin: "https://api.okou.ai",
        installerUserId,
        orgId,
        slackWorkspaceId,
      }),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({
      baseUrl: "https://api.okou.ai",
      context,
      routes: integrationsSlackRoutes,
    })(integrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const connectUrl = new URL(response.body.connectUrl!);
    expect(`${connectUrl.origin}${connectUrl.pathname}`).toBe(
      "https://api.okou.ai/api/slack/oauth/connect",
    );
  });

  it("returns scopeMismatch=true when installation is missing scopes", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await slackOrgs.installForOrg({
      orgId,
      botScopes: "chat:write,channels:read",
    });
    await slackOrgs.connectMember({
      orgId,
      userId,
      slackWorkspaceId: fixture.slackWorkspaceId,
    });
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.scopeMismatch).toBeTruthy();
    const reinstallUrl = new URL(response.body.reinstallUrl!);
    expect(`${reinstallUrl.origin}${reinstallUrl.pathname}`).toBe(
      "https://api.okou.ai/api/slack/oauth/install",
    );
    const authorizationUrl = await startStatusOAuth(
      reinstallUrl.toString(),
      orgId,
    );
    expect(authorizationUrl.searchParams.get("team")).toBe(
      fixture.slackWorkspaceId,
    );
    expect(authorizationUrl.searchParams.has("scope")).toBeTruthy();
    expect(authorizationUrl.searchParams.has("user_scope")).toBeTruthy();
  });

  it("returns Okou reinstall URLs on the Okou API origin", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const slackWorkspaceId = `T_${randomUUID()}`;
    await track(
      installSlackViaOAuth({
        apiOrigin: "https://api.okou.ai",
        botScopes: "chat:write",
        installerUserId: userId,
        orgId,
        slackWorkspaceId,
      }),
    );
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({
      baseUrl: "https://api.okou.ai",
      context,
      routes: integrationsSlackRoutes,
    })(integrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const reinstallUrl = new URL(response.body.reinstallUrl!);
    expect(`${reinstallUrl.origin}${reinstallUrl.pathname}`).toBe(
      "https://api.okou.ai/api/slack/oauth/install",
    );
    const authorizationUrl = await startStatusOAuth(
      reinstallUrl.toString(),
      orgId,
    );
    expect(authorizationUrl.searchParams.get("team")).toBe(slackWorkspaceId);
    expect(authorizationUrl.searchParams.has("scope")).toBeTruthy();
    expect(authorizationUrl.searchParams.has("user_scope")).toBeTruthy();
  });

  it("treats null bot_scopes as mismatch (requires reinstall)", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await slackOrgs.installForOrg({
      orgId,
      botScopes: null,
    });
    await slackOrgs.connectMember({
      orgId,
      userId,
      slackWorkspaceId: fixture.slackWorkspaceId,
    });
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.scopeMismatch).toBeTruthy();
  });

  it("does not expose scopeMismatch to non-admin users", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await slackOrgs.installForOrg({
      orgId,
      botScopes: "chat:write",
    });
    await slackOrgs.connectMember({
      orgId,
      userId,
      slackWorkspaceId: fixture.slackWorkspaceId,
    });
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.scopeMismatch).toBeUndefined();
    expect(response.body.reinstallUrl).toBeUndefined();
  });

  it("returns scopeMismatch for admin when user is not connected", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await slackOrgs.installForOrg({
      orgId,
      botScopes: "chat:write",
    });
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isConnected).toBeFalsy();
    expect(response.body.scopeMismatch).toBeTruthy();
    const authorizationUrl = await startStatusOAuth(
      response.body.reinstallUrl!,
      orgId,
    );
    expect(authorizationUrl.searchParams.get("team")).toBe(
      fixture.slackWorkspaceId,
    );
    expect(authorizationUrl.searchParams.has("scope")).toBeTruthy();
    expect(authorizationUrl.searchParams.has("user_scope")).toBeTruthy();
  });
});
