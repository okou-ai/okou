import { randomUUID } from "node:crypto";

import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { createStore } from "ccstate";
import { beforeEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  deleteSlackIntegrationFixture$,
  seedSlackEnvironmentAgent$,
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/integrations-slack";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { integrationsSlackRoutes } from "../integrations-slack";
import { slackOauthRoutes } from "../slack-oauth";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

describe("GET /api/integrations/slack", () => {
  const track = createFixtureTracker<SlackIntegrationFixture>((fixture) => {
    return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
  });

  async function installSlackViaOAuth(args: {
    readonly apiOrigin: string;
    readonly botScopes?: string;
    readonly installerUserId: string;
    readonly orgId: string;
    readonly slackWorkspaceId: string;
  }): Promise<SlackIntegrationFixture> {
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
        query: { orgId: args.orgId, userId: args.installerUserId },
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
        query: { code: `code-${args.slackWorkspaceId}`, state },
      }),
      [307],
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

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(client.getStatus({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

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

  it("returns isConnected=false when user has no connection", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
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
    expect(response.body.connectUrl).not.toBeNull();
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

    expect(response.body.installUrl).not.toBeNull();
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

  it("returns workspace info for connected user", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, userId: userId },
      context.signal,
    );
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

    expect(response.body.isConnected).toBeTruthy();
    expect(response.body.workspaceName).toBe("Test Org Workspace");
  });

  it("returns empty environment details when no default agent version is configured", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, userId: userId },
      context.signal,
    );
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

    expect(response.body.environment).toStrictEqual({
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    });
  });

  it("returns isAdmin=true for admin members", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, userId: userId },
      context.signal,
    );
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

    expect(response.body.isAdmin).toBeTruthy();
  });

  it("returns isAdmin=false for non-admin members", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, userId: userId },
      context.signal,
    );
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

    expect(response.body.isAdmin).toBeFalsy();
  });

  it("returns environment info when connected", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, userId: userId },
      context.signal,
    );
    await store.set(
      seedSlackEnvironmentAgent$,
      { orgId, userId },
      context.signal,
    );
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

    expect(response.body.environment).toBeDefined();
    expect(response.body.environment?.requiredSecrets).toBeDefined();
    expect(response.body.environment?.requiredVars).toBeDefined();
    expect(response.body.environment?.missingSecrets).toBeDefined();
    expect(response.body.environment?.missingVars).toBeDefined();
  });

  it("returns scopeMismatch=false when installation has all required scopes", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fullScopes = [
      "app_mentions:read",
      "chat:write",
      "channels:read",
      "channels:history",
      "groups:read",
      "groups:history",
      "im:history",
      "im:read",
      "im:write",
      "commands",
      "users:read",
      "users:read.email",
      "reactions:write",
      "files:read",
      "files:write",
    ];
    const fixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: JSON.stringify(fullScopes) },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, userId: userId },
      context.signal,
    );
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

    expect(response.body.scopeMismatch).toBeFalsy();
    expect(response.body.reinstallUrl).toBeNull();
  });

  it("returns scopeMismatch=true when installation is missing scopes", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: JSON.stringify(["chat:write", "channels:read"]) },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, userId: userId },
      context.signal,
    );
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
    const fixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: null },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, userId: userId },
      context.signal,
    );
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
    const fixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: JSON.stringify(["chat:write"]) },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, userId: userId },
      context.signal,
    );
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
    const fixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: JSON.stringify(["chat:write"]) },
        context.signal,
      ),
    );
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
    expect(response.body.reinstallUrl).not.toBeNull();
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
