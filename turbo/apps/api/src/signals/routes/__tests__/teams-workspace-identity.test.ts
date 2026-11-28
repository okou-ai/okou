import { randomUUID } from "node:crypto";

import { integrationsTeamsMessageContract } from "@okouai/api-contracts/contracts/integrations";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { teamsOauthContract } from "@okouai/api-contracts/contracts/teams-oauth";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsTeamsMessageRoutes } from "../integrations-teams-message";
import { teamsConnectRoutes } from "../teams-connect";
import { teamsOauthRoutes } from "../teams-oauth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { connectTeamsAccountForTest } from "./helpers/teams-account";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";
import { now } from "../../../lib/time";

const context = testContext();
const memberships = createStore();

const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const BOT_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_CHANGE_ERROR =
  "Disconnect your current Teams account before connecting another identity or organization.";

type SessionRole = "org:admin" | "org:member";

interface MicrosoftProfile {
  readonly tenantId: string;
  readonly aadObjectId: string;
  readonly displayName: string;
  readonly principalName: string;
}

interface TeamsDelivery {
  readonly conversationId: string;
  readonly body: Record<string, unknown>;
}

interface TeamsProvider {
  readonly conversations: Record<string, unknown>[];
  readonly deliveries: TeamsDelivery[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setupEnv(): void {
  setupTeamsConnectTestEnv();
  mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "teams-identity-client");
  mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", randomUUID());
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", randomUUID());
}

async function seedMember(
  orgId: string,
  userId: string,
  role: "admin" | "member" = "admin",
): Promise<void> {
  await memberships.set(
    seedOrgMembership$,
    { orgId, userId, role },
    context.signal,
  );
}

function profileOf(
  fixture: TeamsConnectFixture,
  overrides: Partial<MicrosoftProfile> = {},
): MicrosoftProfile {
  return {
    tenantId: fixture.teamsTenantId,
    aadObjectId: fixture.teamsAadObjectId,
    displayName: "Ada Lovelace",
    principalName: fixture.teamsUserPrincipalName,
    ...overrides,
  };
}

/** Microsoft OAuth verifies the given profile for any authorization code. */
function serveMicrosoft(profile: MicrosoftProfile): void {
  server.use(
    http.post(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      () => {
        const claims = Buffer.from(
          JSON.stringify({ tid: profile.tenantId, oid: profile.aadObjectId }),
        ).toString("base64url");
        return HttpResponse.json({
          access_token: "microsoft-access-token",
          id_token: `e30.${claims}.signature`,
        });
      },
    ),
    http.get("https://graph.microsoft.com/v1.0/me", () => {
      return HttpResponse.json({
        id: profile.aadObjectId,
        displayName: profile.displayName,
        userPrincipalName: profile.principalName,
      });
    }),
  );
}

/** Teams' Bot Framework connector records conversations and activities. */
function serveTeams(fixture: TeamsConnectFixture): TeamsProvider {
  const provider: TeamsProvider = { conversations: [], deliveries: [] };
  server.use(
    http.post(
      `https://login.microsoftonline.com/${BOT_APP_TENANT_ID}/oauth2/v2.0/token`,
      () => {
        return HttpResponse.json({
          access_token: "teams-bot-access-token",
          expires_in: 3600,
        });
      },
    ),
    http.post(`${fixture.serviceUrl}v3/conversations`, async ({ request }) => {
      const body: unknown = await request.json();
      provider.conversations.push(isRecord(body) ? body : {});
      return HttpResponse.json({
        id: `a:welcome-${provider.conversations.length}-${fixture.fixtureId}`,
      });
    }),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId?`,
      async ({ request, params }) => {
        const body: unknown = await request.json();
        provider.deliveries.push({
          conversationId: String(params.conversationId),
          body: isRecord(body) ? body : {},
        });
        return HttpResponse.json({
          id: `delivery-${provider.deliveries.length}`,
        });
      },
    ),
  );
  return provider;
}

function connectWelcomes(provider: TeamsProvider): TeamsDelivery[] {
  return provider.deliveries.filter((delivery) => {
    return delivery.body.summary === "You're connected to Okou!";
  });
}

function signIn(userId: string, orgId: string, role: SessionRole): void {
  createRouteMocks(context).clerk.session(userId, orgId, role);
}

function locationOf(response: { readonly headers: Headers }): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected a redirect location");
  }
  return new URL(location);
}

/** The signed-in user completes Microsoft OAuth for the given flow. */
async function completeOauth(
  userId: string,
  orgId: string,
  flow: "connect" | "install",
  role: SessionRole = "org:admin",
): Promise<URL> {
  const oauth = setupApp({ context, routes: teamsOauthRoutes })(
    teamsOauthContract,
  );
  signIn(userId, orgId, role);
  const started = await accept(
    oauth.connect({ query: { flow }, extraHeaders: SESSION }),
    [307],
  );
  const state = locationOf(started).searchParams.get("state") ?? "";
  const completed = await accept(
    oauth.callback({
      query: { state, code: `code-${randomUUID()}` },
      extraHeaders: SESSION,
    }),
    [307],
  );
  await flushWaitUntilForTest();
  return locationOf(completed);
}

async function readStatus(
  userId: string,
  orgId: string,
  role: SessionRole = "org:admin",
) {
  signIn(userId, orgId, role);
  const response = await accept(
    setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    ).getStatus({ headers: SESSION }),
    [200],
  );
  return response.body;
}

async function disconnect(
  userId: string,
  orgId: string,
  query: { readonly action?: "uninstall" },
  role: SessionRole = "org:admin",
) {
  signIn(userId, orgId, role);
  return await accept(
    setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    ).disconnect({ headers: SESSION, query }),
    [200],
  );
}

/** Teams reports that the bot was added to the fixture team. */
async function botInstalled(
  fixture: TeamsConnectFixture,
  activityId: string,
): Promise<void> {
  const response = await postTeamsActivityForTest({
    signal: context.signal,
    activity: {
      type: "installationUpdate",
      action: "add",
      id: activityId,
      timestamp: "2026-07-14T08:30:00.000Z",
      serviceUrl: fixture.serviceUrl,
      channelId: "msteams",
      conversation: {
        id: fixture.teamsConversationId,
        conversationType: "channel",
      },
      channelData: {
        tenant: { id: fixture.teamsTenantId, name: fixture.teamsTenantName },
        team: {
          id: fixture.teamsTeamId,
          aadGroupId: fixture.teamsTeamAadGroupId,
          name: fixture.teamsTeamName,
        },
        channel: { id: fixture.teamsChannelId, name: "General" },
        teamsAppId: fixture.teamsAppId,
      },
      from: {
        id: fixture.teamsUserId,
        name: "Ada Lovelace",
        aadObjectId: fixture.teamsAadObjectId,
      },
      recipient: { id: fixture.teamsBotId, name: "Nova" },
    },
  });
  expect(response.status).toBe(200);
  await flushWaitUntilForTest();
}

function linkedAccountOf(profile: MicrosoftProfile) {
  return {
    tenantId: profile.tenantId,
    teamsAadObjectId: profile.aadObjectId,
  };
}

describe("Teams workspace identity", () => {
  it("teams-workspace-identity-005 lets a member connect before installation and disconnect", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    const profile = profileOf(fixture);
    await seedMember(fixture.orgId, fixture.userId, "member");
    serveMicrosoft(profile);

    await completeOauth(fixture.userId, fixture.orgId, "connect", "org:member");
    const connected = await readStatus(
      fixture.userId,
      fixture.orgId,
      "org:member",
    );
    await disconnect(fixture.userId, fixture.orgId, {}, "org:member");
    const disconnected = await readStatus(
      fixture.userId,
      fixture.orgId,
      "org:member",
    );

    expect(connected).toMatchObject({
      workspaceIdentity: true,
      isConnected: true,
      isInstalled: false,
      isAdmin: false,
      installUrl: null,
      tenantId: fixture.teamsTenantId,
      linkedAccounts: [linkedAccountOf(profile)],
    });
    expect(connected.reinstallUrl ?? null).toBeNull();
    expect(disconnected).toMatchObject({
      isConnected: false,
      isInstalled: false,
      pendingInstallation: false,
      linkedAccounts: [],
    });
    expect(disconnected.connectUrl).toStrictEqual(expect.any(String));
  });

  it("teams-workspace-identity-001 sends one personal welcome to the verified identity after connecting", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    await seedMember(fixture.orgId, fixture.userId);
    serveMicrosoft(profileOf(fixture));
    const teams = serveTeams(fixture);

    await completeOauth(fixture.userId, fixture.orgId, "install");
    await botInstalled(fixture, `activity-installed-${fixture.fixtureId}`);

    expect(teams.conversations).toStrictEqual([]);
    expect(connectWelcomes(teams)).toStrictEqual([]);

    const connected = await completeOauth(
      fixture.userId,
      fixture.orgId,
      "connect",
    );

    expect(connected.searchParams.get("status")).toBe("connected");
    expect(teams.conversations).toStrictEqual([
      {
        bot: { id: fixture.teamsBotId, name: "Nova" },
        members: [{ id: fixture.teamsAadObjectId, name: "Ada Lovelace" }],
        isGroup: false,
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    ]);
    expect(connectWelcomes(teams)).toMatchObject([
      { conversationId: `a:welcome-1-${fixture.fixtureId}` },
    ]);

    await completeOauth(fixture.userId, fixture.orgId, "connect");

    expect(connectWelcomes(teams)).toHaveLength(1);
  });

  it("teams-workspace-identity-002 delivers a pending welcome once when the bot becomes ready", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    await seedMember(fixture.orgId, fixture.userId);
    serveMicrosoft(profileOf(fixture));
    const teams = serveTeams(fixture);
    const installedEventId = `activity-installed-${fixture.fixtureId}`;

    await completeOauth(fixture.userId, fixture.orgId, "connect");
    await completeOauth(fixture.userId, fixture.orgId, "install");

    expect(connectWelcomes(teams)).toStrictEqual([]);

    await botInstalled(fixture, installedEventId);

    expect(connectWelcomes(teams)).toHaveLength(1);

    await botInstalled(fixture, installedEventId);

    expect(connectWelcomes(teams)).toHaveLength(1);
  });

  it("teams-workspace-identity-006 keeps bot ownership with the installing organization", async () => {
    setupEnv();
    const owner = teamsConnectFixture();
    await installTeamsForTest(context.signal, owner);
    await connectTeamsAccountForTest(context, owner, { learnSender: false });
    const external = teamsConnectFixture({
      teamsTenantId: owner.teamsTenantId,
    });
    await seedMember(external.orgId, external.userId, "member");
    serveMicrosoft(profileOf(external));

    await completeOauth(
      external.userId,
      external.orgId,
      "connect",
      "org:member",
    );
    signIn(external.userId, external.orgId, "org:member");
    await accept(
      setupApp({ context, routes: integrationsTeamsMessageRoutes })(
        integrationsTeamsMessageContract,
      ).sendMessage({
        headers: SESSION,
        body: {
          conversationId: owner.teamsConversationId,
          text: "message through another workspace bot",
        },
      }),
      [404],
    );
    const externalStatus = await readStatus(
      external.userId,
      external.orgId,
      "org:member",
    );
    const ownerStatus = await readStatus(owner.userId, owner.orgId);

    expect(externalStatus).toMatchObject({
      isConnected: true,
      isInstalled: false,
      linkedAccounts: [linkedAccountOf(profileOf(external))],
    });
    expect(ownerStatus).toMatchObject({
      isConnected: true,
      isInstalled: true,
      linkedAccounts: [linkedAccountOf(profileOf(owner))],
    });
  });

  it("teams-workspace-identity-008 refuses to move a linked identity until it is disconnected", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    const otherUserId = `user_other_${fixture.fixtureId}`;
    const otherOrgId = `org_other_${fixture.fixtureId}`;
    const original = profileOf(fixture);
    const replacement = profileOf(fixture, {
      aadObjectId: `aad-replacement-${fixture.fixtureId}`,
      displayName: "Grace Hopper",
      principalName: `grace-${fixture.fixtureId}@example.test`,
    });
    await seedMember(fixture.orgId, fixture.userId);
    await seedMember(fixture.orgId, otherUserId, "member");
    await seedMember(otherOrgId, fixture.userId);
    serveMicrosoft(original);
    await completeOauth(fixture.userId, fixture.orgId, "connect");

    const otherUser = await completeOauth(
      otherUserId,
      fixture.orgId,
      "connect",
      "org:member",
    );
    const otherOrganization = await completeOauth(
      fixture.userId,
      otherOrgId,
      "connect",
    );
    serveMicrosoft(replacement);
    const otherIdentity = await completeOauth(
      fixture.userId,
      fixture.orgId,
      "connect",
    );

    expect(
      [otherUser, otherOrganization, otherIdentity].map((location) => {
        return location.searchParams.get("error");
      }),
    ).toStrictEqual([
      ACCOUNT_CHANGE_ERROR,
      ACCOUNT_CHANGE_ERROR,
      ACCOUNT_CHANGE_ERROR,
    ]);
    const retained = await readStatus(fixture.userId, fixture.orgId);
    expect(retained.linkedAccounts).toMatchObject([linkedAccountOf(original)]);

    await disconnect(fixture.userId, fixture.orgId, {});
    const reconnected = await completeOauth(
      fixture.userId,
      fixture.orgId,
      "connect",
    );
    const status = await readStatus(fixture.userId, fixture.orgId);

    expect(reconnected.searchParams.get("status")).toBe("connected");
    expect(status).toMatchObject({
      isConnected: true,
      linkedAccounts: [linkedAccountOf(replacement)],
    });
  });

  it("teams-workspace-identity-009 uninstalls the bot and keeps the personal identity", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    const profile = profileOf(fixture);
    await seedMember(fixture.orgId, fixture.userId);
    serveMicrosoft(profile);
    serveTeams(fixture);
    await completeOauth(fixture.userId, fixture.orgId, "connect");

    const install = await completeOauth(
      fixture.userId,
      fixture.orgId,
      "install",
    );
    await botInstalled(fixture, `activity-installed-${fixture.fixtureId}`);
    const installed = await readStatus(fixture.userId, fixture.orgId);
    await disconnect(fixture.userId, fixture.orgId, { action: "uninstall" });
    const uninstalled = await readStatus(fixture.userId, fixture.orgId);

    expect(`${install.origin}${install.pathname}`).toBe(
      "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-000000000001",
    );
    expect(installed).toMatchObject({ isConnected: true, isInstalled: true });
    expect(uninstalled).toMatchObject({
      isInstalled: false,
      isConnected: true,
      linkedAccounts: [linkedAccountOf(profile)],
    });
  });

  it("teams-workspace-identity-014 releases the Teams account when Clerk deletes the membership", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    const profile = profileOf(fixture);
    const nextAdminId = `user_next_${fixture.fixtureId}`;
    const nextOrgId = `org_next_${fixture.fixtureId}`;
    await seedMember(fixture.orgId, fixture.userId);
    await seedMember(nextOrgId, nextAdminId);
    serveMicrosoft(profile);
    await completeOauth(fixture.userId, fixture.orgId, "connect");
    const event = {
      type: "organizationMembership.deleted",
      data: {
        organization: { id: fixture.orgId },
        public_user_data: { user_id: fixture.userId },
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValue(event);

    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: {
          "svix-id": `msg_${randomUUID()}`,
          "svix-timestamp": String(Math.floor(now() / 1000)),
          "svix-signature": "v1,signed-by-clerk",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const next = await completeOauth(nextAdminId, nextOrgId, "connect");
    const status = await readStatus(nextAdminId, nextOrgId);

    expect(next.searchParams.get("status")).toBe("connected");
    expect(status).toMatchObject({
      isConnected: true,
      isInstalled: false,
      linkedAccounts: [linkedAccountOf(profile)],
    });
  });

  it("teams-workspace-identity-016 releases the Teams account when Clerk deletes the user", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    const profile = profileOf(fixture);
    const nextAdminId = `user_next_${fixture.fixtureId}`;
    const nextOrgId = `org_next_${fixture.fixtureId}`;
    await seedMember(fixture.orgId, fixture.userId);
    await seedMember(nextOrgId, nextAdminId);
    serveMicrosoft(profile);
    await completeOauth(fixture.userId, fixture.orgId, "connect");
    const event = { type: "user.deleted", data: { id: fixture.userId } };
    context.mocks.clerk.verifyWebhook.mockResolvedValue(event);

    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: {
          "svix-id": `msg_${randomUUID()}`,
          "svix-timestamp": String(Math.floor(now() / 1000)),
          "svix-signature": "v1,signed-by-clerk",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const next = await completeOauth(nextAdminId, nextOrgId, "connect");
    const status = await readStatus(nextAdminId, nextOrgId);

    expect(next.searchParams.get("status")).toBe("connected");
    expect(status).toMatchObject({
      isConnected: true,
      isInstalled: false,
      linkedAccounts: [linkedAccountOf(profile)],
    });
  });
});
