import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { teamsBrowserConnectRoutes } from "../teams-browser-connect";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsFixtureExternalId,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";
import { teamsConnectRoutes } from "../teams-connect";

const context = testContext();
const mocks = createRouteMocks(context);
const CONNECT_PATH = "http://api.test/api/teams/connect";
const APP_ORIGIN = "https://app.okou.test";

function connectUrl(params: {
  readonly tenantId?: string;
  readonly tenantName?: string;
  readonly teamsUserId?: string;
  readonly teamsAadObjectId?: string;
  readonly teamsUserDisplayName?: string;
  readonly teamsUserPrincipalName?: string;
  readonly displayName?: string;
  readonly upn?: string;
  readonly teamId?: string;
  readonly teamName?: string;
  readonly serviceUrl?: string;
  readonly activityId?: string;
  readonly orgId?: string;
}): string {
  const url = new URL(CONNECT_PATH);
  if (params.tenantId) {
    url.searchParams.set("tenantId", params.tenantId);
  }
  if (params.tenantName) {
    url.searchParams.set("tenantName", params.tenantName);
  }
  if (params.teamsUserId) {
    url.searchParams.set("teamsUserId", params.teamsUserId);
  }
  if (params.teamsAadObjectId) {
    url.searchParams.set("teamsAadObjectId", params.teamsAadObjectId);
  }
  if (params.teamsUserDisplayName) {
    url.searchParams.set("teamsUserDisplayName", params.teamsUserDisplayName);
  }
  if (params.teamsUserPrincipalName) {
    url.searchParams.set(
      "teamsUserPrincipalName",
      params.teamsUserPrincipalName,
    );
  }
  if (params.displayName) {
    url.searchParams.set("displayName", params.displayName);
  }
  if (params.upn) {
    url.searchParams.set("upn", params.upn);
  }
  if (params.teamId) {
    url.searchParams.set("teamId", params.teamId);
  }
  if (params.teamName) {
    url.searchParams.set("teamName", params.teamName);
  }
  if (params.serviceUrl) {
    url.searchParams.set("serviceUrl", params.serviceUrl);
  }
  if (params.activityId) {
    url.searchParams.set("activityId", params.activityId);
  }
  if (params.orgId) {
    url.searchParams.set("orgId", params.orgId);
  }
  return url.toString();
}

async function requestConnect(
  url: string,
  headers?: RequestInit["headers"],
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: teamsBrowserConnectRoutes,
  });
  const requestHeaders = headers ?? { cookie: "__session=opaque" };
  return await app.request(url, { method: "GET", headers: requestHeaders });
}

function connectBody(
  fixture: TeamsConnectFixture,
  teamsUserId = fixture.teamsUserId,
) {
  return {
    tenantId: fixture.teamsTenantId,
    teamsUserId,
    teamsAadObjectId: fixture.teamsAadObjectId,
    teamsUserDisplayName: "Ada Lovelace",
    teamsUserPrincipalName: fixture.teamsUserPrincipalName,
    teamId: fixture.teamsTeamId,
    teamName: fixture.teamsTeamName,
    serviceUrl: fixture.serviceUrl,
  };
}

async function seedTeamsInstallation(
  track: (
    fixturePromise: Promise<TeamsConnectFixture>,
  ) => Promise<TeamsConnectFixture>,
  values: Partial<TeamsConnectFixture> = {},
): Promise<TeamsConnectFixture> {
  const fixture = await track(Promise.resolve(teamsConnectFixture(values)));
  await installTeamsForTest(context.signal, fixture);
  return fixture;
}

async function bindTeamsInstallation(
  fixture: TeamsConnectFixture,
  userId: string,
): Promise<void> {
  mocks.clerk.session(userId, fixture.orgId, "org:admin");
  const client = setupApp({ context, routes: teamsConnectRoutes })(
    teamsConnectContract,
  );
  await accept(
    client.connect({
      headers: { authorization: "Bearer clerk-session" },
      body: connectBody(
        fixture,
        teamsFixtureExternalId(fixture, "29:admin-user"),
      ),
    }),
    [200],
  );
}

async function expectTeamsConnected(
  fixture: TeamsConnectFixture,
  expected: {
    readonly tenantName?: string | null;
    readonly teamId?: string | null;
    readonly teamName?: string | null;
  } = {},
): Promise<void> {
  const client = setupApp({ context, routes: teamsConnectRoutes })(
    teamsConnectContract,
  );
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
    tenantName: expected.tenantName ?? fixture.teamsTenantName,
    teamId: expected.teamId ?? fixture.teamsTeamId,
    teamName: expected.teamName ?? fixture.teamsTeamName,
  });
}

describe("GET /api/teams/connect", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv(APP_ORIGIN);
  });

  it("redirects unauthenticated users to app sign-in with redirect_url", async () => {
    const response = await requestConnect(CONNECT_PATH, {});

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Expected app sign-in redirect");
    }
    const url = new URL(location);
    expect(url.origin).toBe(APP_ORIGIN);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(CONNECT_PATH);
  });

  it("redirects invalid connect links to the Teams connect error page", async () => {
    mocks.clerk.session("user_invalid", "org_invalid", "org:admin");

    const response = await requestConnect(CONNECT_PATH);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(new URL(location!).searchParams.get("error")).toContain(
      "Invalid connect link.",
    );
  });

  it("binds an unbound installation for an admin and creates one connection", async () => {
    const fixture = await seedTeamsInstallation(track, {
      teamsTenantName: "",
      teamsTeamName: "",
    });
    const linkedTeamId = teamsFixtureExternalId(fixture, "team-from-link");
    const linkedActivityId = teamsFixtureExternalId(fixture, "activity-link");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await requestConnect(
      connectUrl({
        tenantId: fixture.teamsTenantId,
        tenantName: "Tenant From Link",
        teamsUserId: fixture.teamsUserId,
        teamsAadObjectId: fixture.teamsAadObjectId,
        teamsUserDisplayName: "Ada Lovelace",
        teamsUserPrincipalName: fixture.teamsUserPrincipalName,
        teamId: linkedTeamId,
        teamName: "Team From Link",
        serviceUrl: fixture.serviceUrl,
        activityId: linkedActivityId,
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?status=connected`);
    const redirectUrl = new URL(location!);
    expect(redirectUrl.searchParams.get("tenantId")).toBe(
      fixture.teamsTenantId,
    );
    expect(redirectUrl.searchParams.get("tenantName")).toBe("Tenant From Link");
    expect(redirectUrl.searchParams.get("teamsUserId")).toBe(
      fixture.teamsUserId,
    );
    expect(redirectUrl.searchParams.get("teamsAadObjectId")).toBe(
      fixture.teamsAadObjectId,
    );
    expect(redirectUrl.searchParams.get("teamsUserDisplayName")).toBe(
      "Ada Lovelace",
    );
    expect(redirectUrl.searchParams.get("teamsUserPrincipalName")).toBe(
      fixture.teamsUserPrincipalName,
    );
    expect(redirectUrl.searchParams.get("teamId")).toBe(linkedTeamId);
    expect(redirectUrl.searchParams.get("serviceUrl")).toBe(fixture.serviceUrl);
    expect(redirectUrl.searchParams.get("activityId")).toBe(linkedActivityId);
    expect(redirectUrl.searchParams.get("teamName")).toBe("Team From Link");
    expect(redirectUrl.searchParams.get("botName")).toBe("Nova");
    await expectTeamsConnected(fixture, {
      tenantName: "Tenant From Link",
      teamId: linkedTeamId,
      teamName: "Team From Link",
    });
  });

  it("rejects a member connecting an unbound installation", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await requestConnect(
      connectUrl({
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(decodeURIComponent(location ?? "")).toContain("admin");
  });

  it("connects from a Teams link that only includes the AAD user id", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await requestConnect(
      connectUrl({
        tenantId: fixture.teamsTenantId,
        teamsAadObjectId: fixture.teamsAadObjectId,
        teamsUserDisplayName: "Ada Lovelace",
        teamsUserPrincipalName: fixture.teamsUserPrincipalName,
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );
    await expectTeamsConnected(fixture);
  });

  it("keeps reconnecting the same Teams user idempotent", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const url = connectUrl({
      tenantId: fixture.teamsTenantId,
      teamsUserId: fixture.teamsUserId,
    });

    const first = await requestConnect(url);
    const second = await requestConnect(url);

    expect(first.status).toBe(307);
    expect(first.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );
    expect(second.status).toBe(307);
    expect(second.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );
    await expectTeamsConnected(fixture);
  });

  it("allows a member to connect to a bound installation", async () => {
    const fixture = await seedTeamsInstallation(track);
    const memberUserId = `member_${fixture.userId}`;
    await bindTeamsInstallation(fixture, `admin_${fixture.userId}`);
    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");

    const response = await requestConnect(
      connectUrl({
        tenantId: fixture.teamsTenantId,
        teamsUserId: teamsFixtureExternalId(fixture, "29:member-user"),
        orgId: fixture.orgId,
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );
    await expectTeamsConnected(fixture);
  });

  it("redirects org mismatch to the organization error", async () => {
    const fixture = await seedTeamsInstallation(track);
    await bindTeamsInstallation(fixture, fixture.userId);
    mocks.clerk.session(fixture.userId, "org_other", "org:admin");

    const response = await requestConnect(
      connectUrl({
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        orgId: "org_other",
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(new URL(location!).searchParams.get("error")).toContain(
      "active organization",
    );
  });
});
