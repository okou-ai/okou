import { describe, expect, it, beforeEach } from "vitest";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { HttpResponse, http } from "msw";

import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
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
import { createBddApi } from "./helpers/api-bdd";

const context = testContext();
const mocks = createRouteMocks(context);
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
  _fixture: {
    readonly orgId: string;
    readonly userId: string;
  },
  origin = "https://api.okou.test",
) {
  return expect.stringContaining(
    `${origin}/api/teams/oauth/connect?connectState=teams-start.`,
  );
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
  const bdd = createBddApi(context);
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
      linkedAccounts: [],
      pendingInstallation: false,
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
      linkedAccounts: [],
      pendingInstallation: false,
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
      linkedAccounts: [],
      pendingInstallation: false,
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

  it("returns the configured default agent display name for a connected user", async () => {
    const fixture = await seedTeamsInstallation(track);
    const actor = bdd.user({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    bdd.acceptAgentStorageWrites();
    const onboarding = await bdd.readOnboardingStatus(actor);
    expect(onboarding.hasDefaultAgent).toBeTruthy();
    if (!onboarding.defaultAgentId) {
      throw new Error(
        "Expected public onboarding to configure a default agent",
      );
    }
    const agent = await bdd.readAgent(actor, onboarding.defaultAgentId);
    expect(agent.isDefaultAgent).toBeTruthy();
    expect(agent.displayName).toBe("Okou");

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
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      linkedAccounts: [
        {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          displayName: "Ada Lovelace",
          userPrincipalName: fixture.teamsUserPrincipalName,
        },
      ],
      pendingInstallation: false,
      isAdmin: false,
      connectUrl: null,
      defaultAgentName: "Okou",
      environment: {
        requiredSecrets: [],
        requiredVars: [],
        missingSecrets: [],
        missingVars: [],
      },
    });
  });

  it("keeps status identity isolated across users and organizations", async () => {
    const fixture = await seedTeamsInstallation(track);
    const memberUserId = teamsFixtureExternalId(fixture, "user-unlinked");
    const otherOrg = teamsConnectFixture();
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

    const adminStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(adminStatus.body).toStrictEqual({
      isInstalled: true,
      isConnected: true,
      linkedAccounts: [
        {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          displayName: "Ada Lovelace",
          userPrincipalName: fixture.teamsUserPrincipalName,
        },
      ],
      pendingInstallation: false,
      isAdmin: true,
      installUrl: null,
      connectUrl: null,
      tenantId: fixture.teamsTenantId,
      tenantName: fixture.teamsTenantName,
      teamId: fixture.teamsTeamId,
      teamName: fixture.teamsTeamName,
      botName: "Nova",
      defaultAgentName: null,
      permissionMismatch: false,
      reinstallUrl: null,
      environment: {
        requiredSecrets: [],
        requiredVars: [],
        missingSecrets: [],
        missingVars: [],
      },
    });

    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");
    const memberStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberStatus.body).toStrictEqual({
      isInstalled: true,
      isConnected: false,
      linkedAccounts: [],
      pendingInstallation: false,
      isAdmin: false,
      installUrl: null,
      connectUrl: teamsOauthConnectUrl({
        orgId: fixture.orgId,
        userId: memberUserId,
      }),
      tenantId: fixture.teamsTenantId,
      tenantName: fixture.teamsTenantName,
      teamId: fixture.teamsTeamId,
      teamName: fixture.teamsTeamName,
      botName: "Nova",
      defaultAgentName: null,
    });

    mocks.clerk.session(otherOrg.userId, otherOrg.orgId, "org:admin");
    const otherOrgStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(otherOrgStatus.body).toStrictEqual({
      isInstalled: false,
      isConnected: false,
      linkedAccounts: [],
      pendingInstallation: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(),
      connectUrl: teamsOauthConnectUrl(otherOrg),
    });

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const restoredAdminStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(restoredAdminStatus.body).toStrictEqual(adminStatus.body);
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
      linkedAccounts: [
        {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          displayName: "Ada Lovelace",
          userPrincipalName: fixture.teamsUserPrincipalName,
        },
      ],
      pendingInstallation: false,
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

  it("returns not found when the Teams installation is missing", async () => {
    const fixture = await track(Promise.resolve(teamsConnectFixture()));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message:
          "Teams installation not found. Please install the Teams app first.",
      },
    });
  });

  it("binds an unbound Teams installation for its admin", async () => {
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
  });

  it("updates metadata when claiming an installation and preserves omitted fields for a member", async () => {
    const fixture = await seedTeamsInstallation(track);
    const claimedTeamId = teamsFixtureExternalId(fixture, "claimed-team");
    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const claimed = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          ...connectBody(fixture),
          teamId: claimedTeamId,
          teamName: "Claimed team",
        },
      }),
      [200],
    );
    expect(claimed.body.role).toBe("admin");
    const adminStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(adminStatus.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      teamId: claimedTeamId,
      teamName: "Claimed team",
    });

    mocks.clerk.session(
      `member_${fixture.userId}`,
      fixture.orgId,
      "org:member",
    );
    const connected = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: teamsFixtureExternalId(fixture, "29:metadata-member"),
          teamsAadObjectId: teamsFixtureExternalId(
            fixture,
            "aad-metadata-member",
          ),
          teamName: "Member updated team",
        },
      }),
      [200],
    );
    expect(connected.body.role).toBe("member");
    const memberStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberStatus.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      teamId: claimedTeamId,
      teamName: "Member updated team",
    });
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

  it("returns all of the caller's identities without exposing another user's rows", async () => {
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
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture, "29:second", "aad-second"),
      }),
      [200],
    );
    const status = await accept(
      client.getStatus({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(status.body.linkedAccounts).toHaveLength(2);
    expect(status.body.linkedAccounts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
        }),
        expect.objectContaining({
          teamsUserId: "29:second",
          teamsAadObjectId: "aad-second",
        }),
      ]),
    );
    mocks.clerk.session(`other_${fixture.userId}`, fixture.orgId, "org:member");
    const other = await accept(
      client.getStatus({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(other.body).toMatchObject({
      isInstalled: true,
      isConnected: false,
      linkedAccounts: [],
      pendingInstallation: false,
    });
  });

  it.each(["teams", "aad", "both"] as const)(
    "rejects another owner matching %s before metadata or welcome effects",
    async (identity) => {
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
      const before = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", BOT_APP_PASSWORD);
      const deliveries = teamsWelcomeHandlers(fixture);
      mocks.clerk.session(
        `other_${fixture.userId}`,
        fixture.orgId,
        "org:member",
      );
      const rejected = await accept(
        client.connect({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            tenantId: fixture.teamsTenantId,
            ...(identity !== "aad" ? { teamsUserId: fixture.teamsUserId } : {}),
            ...(identity !== "teams"
              ? { teamsAadObjectId: fixture.teamsAadObjectId }
              : {}),
            teamName: "Rejected team",
            teamsUserDisplayName: "Rejected identity",
            conversationType: "personal",
            conversationId: "personal-rejected",
          },
        }),
        [403],
      );
      expect(rejected.body.error.code).toBe("FORBIDDEN");
      expect(deliveries).toStrictEqual([]);
      const other = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(other.body.linkedAccounts).toStrictEqual([]);
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const after = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(after.body).toStrictEqual(before.body);
    },
  );

  it.each(["teams", "aad", "split"] as const)(
    "rejects a contradictory %s identity pair for the same owner",
    async (identity) => {
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
        client.connect({
          headers: { authorization: "Bearer clerk-session" },
          body: connectBody(fixture, "29:second", "aad-second"),
        }),
        [200],
      );
      const before = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      await accept(
        client.connect({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            ...connectBody(
              fixture,
              identity === "aad" ? "29:replacement" : fixture.teamsUserId,
              identity === "aad"
                ? fixture.teamsAadObjectId
                : identity === "split"
                  ? "aad-second"
                  : "aad-replacement",
            ),
            teamName: "Rejected team",
            teamsUserDisplayName: "Rejected identity",
          },
        }),
        [403],
      );
      const after = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(after.body).toStrictEqual(before.body);
    },
  );

  it.each(["teams", "aad"] as const)(
    "enriches a missing %s counterpart without replacing the established identity",
    async (identity) => {
      const fixture = await seedTeamsInstallation(track);
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const client = setupApp({ context, routes: teamsConnectRoutes })(
        teamsConnectContract,
      );
      const first = await accept(
        client.connect({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            tenantId: fixture.teamsTenantId,
            ...(identity === "teams"
              ? { teamsUserId: fixture.teamsUserId }
              : { teamsAadObjectId: fixture.teamsAadObjectId }),
          },
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
      const status = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(status.body.linkedAccounts).toStrictEqual([
        {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          displayName: "Ada Lovelace",
          userPrincipalName: fixture.teamsUserPrincipalName,
        },
      ]);
    },
  );

  it.each([false, true])(
    "arbitrates concurrent owners without a losing installation claim (different org=%s)",
    async (differentOrg) => {
      const fixture = await seedTeamsInstallation(track);
      const otherUser = `other_${fixture.userId}`;
      const otherOrg = differentOrg ? `other_${fixture.orgId}` : fixture.orgId;
      context.mocks.clerk.authenticateRequest.mockImplementation(
        (request: unknown) => {
          if (!(request instanceof Request)) {
            throw new Error("Expected Clerk HTTP request");
          }
          const other =
            request.headers.get("authorization") === "Bearer contender";
          return Promise.resolve({
            isAuthenticated: true,
            toAuth: () => {
              return {
                userId: other ? otherUser : fixture.userId,
                orgId: other ? otherOrg : fixture.orgId,
                orgRole: "org:admin",
              };
            },
          });
        },
      );
      const client = setupApp({ context, routes: teamsConnectRoutes })(
        teamsConnectContract,
      );
      const responses = await Promise.all([
        accept(
          client.connect({
            headers: { authorization: "Bearer clerk-session" },
            body: { ...connectBody(fixture), teamName: "First team" },
          }),
          [200, 403],
        ),
        accept(
          client.connect({
            headers: { authorization: "Bearer contender" },
            body: { ...connectBody(fixture), teamName: "Second team" },
          }),
          [200, 403],
        ),
      ]);
      expect(
        responses
          .map((response) => {
            return response.status;
          })
          .sort(),
      ).toStrictEqual([200, 403]);
      const winner =
        responses[0].status === 200 ? "clerk-session" : "contender";
      const loser = winner === "clerk-session" ? "contender" : "clerk-session";
      const status = await accept(
        client.getStatus({ headers: { authorization: `Bearer ${winner}` } }),
        [200],
      );
      expect(status.body).toMatchObject({
        isConnected: true,
        teamName: winner === "clerk-session" ? "First team" : "Second team",
      });
      expect(status.body.linkedAccounts).toHaveLength(1);
      const rejected = await accept(
        client.getStatus({ headers: { authorization: `Bearer ${loser}` } }),
        [200],
      );
      expect(rejected.body).toMatchObject({
        isInstalled: !differentOrg,
        isConnected: false,
        linkedAccounts: [],
        pendingInstallation: false,
      });
    },
  );

  it("resolves concurrent same-owner inserts to one idempotent connection", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    const responses = await Promise.all(
      [1, 2].map(() => {
        return accept(
          client.connect({
            headers: { authorization: "Bearer clerk-session" },
            body: connectBody(fixture),
          }),
          [200],
        );
      }),
    );
    expect(responses[0]?.body.connectionId).toBe(
      responses[1]?.body.connectionId,
    );
    const status = await accept(
      client.getStatus({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(status.body.linkedAccounts).toHaveLength(1);
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
      linkedAccounts: [],
      pendingInstallation: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(),
      connectUrl: teamsOauthConnectUrl(fixture),
    });
  });
});
