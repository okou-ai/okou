import { describe, expect, it, beforeEach } from "vitest";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { HttpResponse, http } from "msw";

import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsFixtureExternalId,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";
import { teamsConnectRoutes } from "../teams-connect";

const context = testContext();
const mocks = createRouteMocks(context);
const storages = createStoragesBddApi(context);
const TEAMS_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const BOT_APP_PASSWORD = "teams-test-password";
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
const BOT_FRAMEWORK_TOKEN_URL = `https://login.microsoftonline.com/${TEAMS_APP_TENANT_ID}/oauth2/v2.0/token`;

interface TeamsWelcomeRequest {
  readonly kind: "conversation" | "activity";
  readonly body: unknown;
}

function teamsInstallUrl(tenantId?: string): string {
  const url = new URL(
    "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-000000000001",
  );
  url.searchParams.set("installAppPackage", "true");
  url.searchParams.set("appTenantId", TEAMS_APP_TENANT_ID);
  if (tenantId) {
    url.searchParams.set("tenantId", tenantId);
  }
  return url.toString();
}

function teamsOauthConnectUrl(
  fixture: {
    readonly orgId: string;
    readonly userId: string;
  },
  origin = "https://api.okou.test",
): string {
  const url = new URL("/api/teams/oauth/connect", origin);
  url.searchParams.set("orgId", fixture.orgId);
  url.searchParams.set("userId", fixture.userId);
  return url.toString();
}

function connectBody(
  fixture: TeamsConnectFixture,
  teamsUserId = fixture.teamsUserId,
  teamsAadObjectId = fixture.teamsAadObjectId,
) {
  return {
    tenantId: fixture.teamsTenantId,
    teamsUserId,
    teamsAadObjectId,
    teamsUserDisplayName: "Ada Lovelace",
    teamsUserPrincipalName: fixture.teamsUserPrincipalName,
    teamId: fixture.teamsTeamId,
    teamName: fixture.teamsTeamName,
    serviceUrl: fixture.serviceUrl,
  };
}

function teamsServiceBaseUrl(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/u, "");
}

function teamsWelcomeHandlers(
  fixture: TeamsConnectFixture,
): TeamsWelcomeRequest[] {
  const requests: TeamsWelcomeRequest[] = [];
  const serviceBaseUrl = teamsServiceBaseUrl(fixture.serviceUrl);
  const welcomeConversationId = `a:${teamsFixtureExternalId(
    fixture,
    "teams-welcome-conversation",
  )}`;
  const welcomeActivityId = teamsFixtureExternalId(
    fixture,
    "teams-welcome-activity",
  );

  server.use(
    http.post(BOT_FRAMEWORK_TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      expect(form.get("client_id")).toBe(BOT_APP_ID);
      expect(form.get("client_secret")).toBe(BOT_APP_PASSWORD);
      expect(form.get("scope")).toBe(BOT_FRAMEWORK_SCOPE);
      return HttpResponse.json({
        access_token: "teams-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(`${serviceBaseUrl}/v3/conversations`, async ({ request }) => {
      requests.push({
        kind: "conversation",
        body: await request.json(),
      });
      return HttpResponse.json({ id: welcomeConversationId });
    }),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities`,
      async ({ request }) => {
        requests.push({
          kind: "activity",
          body: await request.json(),
        });
        return HttpResponse.json({ id: welcomeActivityId });
      },
    ),
  );

  return requests;
}

async function seedTeamsInstallation(
  track: (
    fixturePromise: Promise<TeamsConnectFixture>,
  ) => Promise<TeamsConnectFixture>,
  values: Partial<TeamsConnectFixture> = {},
): Promise<TeamsConnectFixture> {
  const fixture = await track(
    Promise.resolve(
      teamsConnectFixture({
        teamsAppId: BOT_APP_ID,
        ...values,
      }),
    ),
  );
  await installTeamsForTest(context.signal, fixture);
  return fixture;
}

describe("GET /api/integrations/teams/connect", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    const response = await accept(client.getStatus({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns uninstalled status when the org has no Teams installation", async () => {
    const fixture = teamsConnectFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isInstalled: false,
      isConnected: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(),
      connectUrl: teamsOauthConnectUrl({
        orgId: fixture.orgId,
        userId: fixture.userId,
      }),
    });
  });

  it("falls back to the web origin when the API backend URL is unset", async () => {
    const fixture = teamsConnectFixture();
    mockEnv("OKOU_API_BACKEND_URL", undefined);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isInstalled: false,
      isConnected: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(),
      connectUrl: teamsOauthConnectUrl(
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
        },
        "https://app.okou.test",
      ),
    });
  });

  it("returns installed but disconnected status for an unlinked user", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isInstalled: true,
      isConnected: false,
      isAdmin: true,
      installUrl: null,
      connectUrl: teamsOauthConnectUrl(fixture),
      tenantId: fixture.teamsTenantId,
      tenantName: fixture.teamsTenantName,
      teamId: fixture.teamsTeamId,
      teamName: fixture.teamsTeamName,
      botName: "Nova",
      defaultAgentName: null,
      permissionMismatch: false,
      reinstallUrl: null,
    });
  });

  it("returns a Teams reinstall URL to admins when the installed app id is stale", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );

    const seedActivity = teamsMessageActivityForTest(fixture, {
      id: teamsFixtureExternalId(fixture, "activity-stale-teams-app"),
    });
    const channelData = seedActivity.channelData as Record<string, unknown>;
    const response = await postTeamsActivityForTest({
      signal: context.signal,
      activity: {
        ...seedActivity,
        channelData: {
          ...channelData,
          teamsAppId: teamsFixtureExternalId(fixture, "stale-teams-app"),
        },
      },
    });
    expect(response.ok).toBeTruthy();

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(status.body).toMatchObject({
      isInstalled: true,
      isAdmin: true,
      permissionMismatch: true,
      reinstallUrl: teamsInstallUrl(fixture.teamsTenantId),
    });
  });

  it("returns connected status when the user has a Teams connection", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isInstalled: true,
      isConnected: true,
      isAdmin: false,
      installUrl: null,
      connectUrl: null,
      tenantId: fixture.teamsTenantId,
      tenantName: fixture.teamsTenantName,
      teamId: fixture.teamsTeamId,
      teamName: fixture.teamsTeamName,
      botName: "Nova",
      defaultAgentName: null,
      environment: {
        requiredSecrets: [],
        requiredVars: [],
        missingSecrets: [],
        missingVars: [],
      },
    });
  });
});

describe("POST /api/integrations/teams/connect", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv();
  });

  it("binds an unbound Teams installation without provisioning artifact storage", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      success: true,
      role: "admin",
    });

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      tenantId: fixture.teamsTenantId,
    });
    await expect(
      storages.listStorages(
        {
          userId: fixture.userId,
          orgId: fixture.orgId,
          orgRole: "org:admin",
          email: `${fixture.userId}@example.test`,
        },
        "user",
      ),
    ).resolves.toStrictEqual([]);
  });

  it("rejects a member connecting an unbound Teams installation", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [403],
    );

    expect(response.body.error.message).toContain("org admins");
  });

  it("allows a member to connect to a bound Teams installation", async () => {
    const fixture = await seedTeamsInstallation(track);
    const adminUserId = `admin_${fixture.userId}`;
    const memberUserId = `member_${fixture.userId}`;
    const adminTeamsUserId = teamsFixtureExternalId(fixture, "29:admin-user");
    const memberTeamsUserId = teamsFixtureExternalId(fixture, "29:member-user");
    const memberTeamsAadObjectId = teamsFixtureExternalId(
      fixture,
      "aad-member-user",
    );

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture, adminTeamsUserId),
      }),
      [200],
    );

    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture, memberTeamsUserId, memberTeamsAadObjectId),
      }),
      [200],
    );

    expect(response.body.role).toBe("member");
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.isConnected).toBeTruthy();
  });

  it("rejects users from the wrong org with a clear error", async () => {
    const fixture = await seedTeamsInstallation(track);
    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );

    mocks.clerk.session(fixture.userId, "org_other", "org:admin");
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [403],
    );

    expect(response.body.error.message).toContain("active organization");
  });

  it("keeps repeated connects for the same Teams user idempotent", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    const first = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    const second = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );

    expect(second.body.connectionId).toBe(first.body.connectionId);
  });

  it("uses the connect Host for a one-time welcome without renaming the Teams bot", async () => {
    const fixture = await seedTeamsInstallation(track);
    const personalConversationId = `a:${teamsFixtureExternalId(
      fixture,
      "personal-conversation",
    )}`;
    const connectActivityId = teamsFixtureExternalId(
      fixture,
      "activity-connect",
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", BOT_APP_PASSWORD);
    const welcomeRequests = teamsWelcomeHandlers(fixture);

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    const okouHeaders = {
      authorization: "Bearer clerk-session",
      origin: "https://app.okou.ai",
    };
    const body = {
      ...connectBody(fixture),
      conversationId: personalConversationId,
      conversationType: "personal",
      activityId: connectActivityId,
    };
    await accept(
      client.connect({
        headers: okouHeaders,
        body,
      }),
      [200],
    );
    await accept(
      client.connect({
        headers: okouHeaders,
        body,
      }),
      [200],
    );

    expect(welcomeRequests).toHaveLength(2);
    expect(welcomeRequests[0]).toMatchObject({
      kind: "conversation",
      body: {
        bot: { id: fixture.teamsBotId, name: "Nova" },
        members: [{ id: fixture.teamsUserId, name: "Ada Lovelace" }],
        isGroup: false,
        channelData: {
          tenant: { id: fixture.teamsTenantId },
        },
      },
    });
    expect(welcomeRequests[1]).toMatchObject({
      kind: "activity",
      body: {
        type: "message",
        summary: "You're connected to Okou!",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: "You're connected to Okou! 🎉\nMention `@Nova` in any channel or send a DM to start chatting with your agent.",
                  wrap: true,
                },
              ],
            },
          },
        ],
      },
    });
  });
});

describe("DELETE /api/integrations/teams/connect", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv();
  });

  it("disconnects the current user without uninstalling Teams", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: false,
      tenantId: fixture.teamsTenantId,
    });
  });

  it("lets admins uninstall Teams for the org", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toStrictEqual({
      isInstalled: false,
      isConnected: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(),
      connectUrl: teamsOauthConnectUrl(fixture),
    });
  });
});
