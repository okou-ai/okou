import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { teamsOauthContract } from "@okouai/api-contracts/contracts/teams-oauth";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { teamsConnectRoutes } from "../teams-connect";
import { teamsOauthRoutes } from "../teams-oauth";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();
const memberships = createStore();

const APP_URL = "https://app.okou.test";
const SETTINGS_URL = `${APP_URL}/settings/teams`;
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const INVALID_STATE = "Invalid connect state.";

interface MicrosoftProfile {
  readonly tenantId: string;
  readonly aadObjectId: string;
  readonly displayName: string;
  readonly principalName: string;
}

function setupEnv(): void {
  setupTeamsConnectTestEnv(APP_URL);
  mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "teams-client");
  mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "teams-secret");
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

/** Microsoft accepts any code and answers with this profile. */
function serveMicrosoft(profile: MicrosoftProfile): string[] {
  const redirectUris: string[] = [];
  server.use(
    http.post(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        redirectUris.push(form.get("redirect_uri") ?? "");
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
  return redirectUris;
}

function oauthClient() {
  return setupApp({ context, routes: teamsOauthRoutes })(teamsOauthContract);
}

function signIn(userId: string, orgId: string): void {
  createRouteMocks(context).clerk.session(userId, orgId);
}

function locationOf(response: { readonly headers: Headers }): URL {
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  return new URL(location ?? "");
}

async function readStatus(userId: string, orgId: string) {
  signIn(userId, orgId);
  const response = await accept(
    setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    ).getStatus({ headers: SESSION }),
    [200],
  );
  return response.body;
}

async function expectDisconnected(
  userId: string,
  orgId: string,
): Promise<void> {
  const status = await readStatus(userId, orgId);
  expect(status).toMatchObject({
    isConnected: false,
    linkedAccounts: [],
    pendingInstallation: false,
  });
}

/** The signed-in member starts OAuth and receives Microsoft authorization state. */
async function startConnect(userId: string, orgId: string): Promise<string> {
  signIn(userId, orgId);
  const response = await accept(
    oauthClient().connect({ query: {}, extraHeaders: SESSION }),
    [307],
  );
  const state = locationOf(response).searchParams.get("state");
  expect(state).toMatch(/^teams-callback\./u);
  return state ?? "";
}

async function callback(
  query: {
    readonly state?: string;
    readonly code?: string;
    readonly error?: string;
  },
  headers: Record<string, string> = SESSION,
) {
  return await accept(
    oauthClient().callback({ query, extraHeaders: headers }),
    [307],
  );
}

describe("Teams OAuth API routes", () => {
  it("teams-oauth-001 sends a signed-out browser to sign in before a legacy connect link", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();

    const response = await accept(
      oauthClient().connect({
        query: { orgId: fixture.orgId, userId: fixture.userId },
      }),
      [307],
    );

    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(`${APP_URL}/sign-in`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("teams-oauth-002 rejects a connect link naming a different workspace member", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    const otherUserId = `user_other_${fixture.fixtureId}`;
    await seedMember(fixture.orgId, fixture.userId);
    await seedMember(fixture.orgId, otherUserId, "member");
    signIn(fixture.userId, fixture.orgId);

    const response = await accept(
      oauthClient().connect({
        query: { orgId: fixture.orgId, userId: otherUserId },
        extraHeaders: SESSION,
      }),
      [307],
    );

    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(SETTINGS_URL);
    expect(location.searchParams.get("error")).toContain(
      "different account or organization",
    );
  });

  it("teams-oauth-003 rejects caller-authored callback state without connecting", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    await seedMember(fixture.orgId, fixture.userId);
    serveMicrosoft(profileOf(fixture));
    signIn(fixture.userId, fixture.orgId);
    const forged = Buffer.from(
      JSON.stringify({ orgId: fixture.orgId, userId: fixture.userId }),
    ).toString("base64url");

    const response = await callback({ state: forged, code: "accepted-code" });

    expect(locationOf(response).searchParams.get("error")).toBe(INVALID_STATE);
    await expectDisconnected(fixture.userId, fixture.orgId);
  });

  it("teams-oauth-004 opens a settings link without credentials and completes it once", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    await seedMember(fixture.orgId, fixture.userId);
    serveMicrosoft(profileOf(fixture));
    const status = await readStatus(fixture.userId, fixture.orgId);
    const connectState = new URL(status.connectUrl ?? "").searchParams.get(
      "connectState",
    );
    expect(connectState).toBeTruthy();
    const entryQuery = { connectState: connectState ?? "" };

    const opened = await accept(
      oauthClient().connect({ query: entryQuery }),
      [307],
    );
    const authorize = locationOf(opened);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    const state = authorize.searchParams.get("state") ?? "";

    signIn(fixture.userId, fixture.orgId);
    const completed = await callback({ state, code: "first-code" });
    const replayed = await callback({ state, code: "first-code" });
    const reopened = await accept(
      oauthClient().connect({ query: entryQuery }),
      [307],
    );

    expect(locationOf(completed).searchParams.get("status")).toBe("connected");
    expect(locationOf(replayed).searchParams.get("error")).toBe(INVALID_STATE);
    expect(locationOf(reopened).searchParams.get("error")).toBe(
      "This connection link has expired or was already used. Please connect again.",
    );
    const after = await readStatus(fixture.userId, fixture.orgId);
    expect(after.linkedAccounts).toHaveLength(1);
  });

  it("teams-oauth-005 expires an abandoned callback after 15 minutes", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    await seedMember(fixture.orgId, fixture.userId);
    serveMicrosoft(profileOf(fixture));
    const startedAt = now();
    mockNow(startedAt);
    const state = await startConnect(fixture.userId, fixture.orgId);

    mockNow(startedAt + 15 * 60 * 1000);
    const response = await callback({ state, code: "late-code" });

    expect(locationOf(response).searchParams.get("error")).toBe(INVALID_STATE);
    await expectDisconnected(fixture.userId, fixture.orgId);
  });

  it("teams-oauth-006 rejects a callback after the signed-in user switches", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    const otherUserId = `user_other_${fixture.fixtureId}`;
    await seedMember(fixture.orgId, fixture.userId);
    await seedMember(fixture.orgId, otherUserId);
    serveMicrosoft(profileOf(fixture));
    const state = await startConnect(fixture.userId, fixture.orgId);

    signIn(otherUserId, fixture.orgId);
    const response = await callback({ state, code: "switched-code" });

    expect(locationOf(response).searchParams.get("error")).toBe(
      "The active account or organization changed. Please reconnect from settings.",
    );
    await expectDisconnected(fixture.userId, fixture.orgId);
  });

  it("teams-oauth-009 returns a provider error with malformed state to the configured app", async () => {
    setupEnv();

    const response = await callback(
      { state: "not-a-teams-state", error: "access_denied" },
      {},
    );

    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(SETTINGS_URL);
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  it("teams-oauth-010 exchanges the code with the redirect URI recorded at start", async () => {
    setupEnv();
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    const fixture = teamsConnectFixture();
    await seedMember(fixture.orgId, fixture.userId);
    const redirectUris = serveMicrosoft(profileOf(fixture));
    const state = await startConnect(fixture.userId, fixture.orgId);
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");

    const response = await callback({ state, code: "recorded-code" });

    expect(redirectUris).toStrictEqual([
      "https://api.okou.ai/api/integrations/teams/oauth/callback",
    ]);
    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(SETTINGS_URL);
    expect(Object.fromEntries(location.searchParams)).toStrictEqual({
      status: "connected",
      botName: "Okou",
    });
  });

  it("teams-oauth-011 rejects callback state for a user no longer in the workspace", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    await seedMember(fixture.orgId, fixture.userId);
    serveMicrosoft(profileOf(fixture));
    const state = await startConnect(fixture.userId, fixture.orgId);
    await memberships.set(
      deleteOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const response = await callback({ state, code: "departed-code" });

    const location = locationOf(response);
    expect(`${location.origin}${location.pathname}`).toBe(SETTINGS_URL);
    expect(location.searchParams.get("error")).toBe(INVALID_STATE);
  });

  it("teams-oauth-013 refuses a second owner of a linked Teams identity", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    const secondUserId = `user_second_${fixture.fixtureId}`;
    await seedMember(fixture.orgId, fixture.userId);
    await seedMember(fixture.orgId, secondUserId, "member");
    serveMicrosoft(profileOf(fixture));
    const firstState = await startConnect(fixture.userId, fixture.orgId);
    await callback({ state: firstState, code: "first-owner-code" });

    serveMicrosoft(
      profileOf(fixture, {
        displayName: "Changed Name",
        principalName: `changed-${fixture.fixtureId}@example.test`,
      }),
    );
    const secondState = await startConnect(secondUserId, fixture.orgId);
    const response = await callback({
      state: secondState,
      code: "second-owner-code",
    });

    expect(locationOf(response).searchParams.get("error")).toBe(
      "Disconnect your current Teams account before connecting another identity or organization.",
    );
    const first = await readStatus(fixture.userId, fixture.orgId);
    expect(first.linkedAccounts).toStrictEqual([
      {
        tenantId: fixture.teamsTenantId,
        teamsUserId: null,
        teamsAadObjectId: fixture.teamsAadObjectId,
        displayName: "Ada Lovelace",
        userPrincipalName: fixture.teamsUserPrincipalName,
      },
    ]);
    await expectDisconnected(secondUserId, fixture.orgId);
  });

  it("teams-oauth-017 requires the initiating session before claiming the tenant", async () => {
    setupEnv();
    const fixture = teamsConnectFixture();
    await seedMember(fixture.orgId, fixture.userId);
    serveMicrosoft(profileOf(fixture));
    const state = await startConnect(fixture.userId, fixture.orgId);
    const query = { state, code: `code-${randomUUID()}` };

    const redirected = await callback(query, {});
    const unauthenticated = await accept(
      oauthClient().callback({ query: { ...query, responseMode: "json" } }),
      [401],
    );

    expect(locationOf(redirected).searchParams.get("integration")).toBe(
      "teams",
    );
    expect(unauthenticated.status).toBe(401);
    await expectDisconnected(fixture.userId, fixture.orgId);

    const resumed = await accept(
      oauthClient().callback({
        query: { ...query, responseMode: "json" },
        extraHeaders: SESSION,
      }),
      [200],
    );
    expect(new URL(resumed.body.redirectUrl).searchParams.get("status")).toBe(
      "connected",
    );
    const status = await readStatus(fixture.userId, fixture.orgId);
    expect(status.linkedAccounts).toMatchObject([
      {
        tenantId: fixture.teamsTenantId,
        teamsAadObjectId: fixture.teamsAadObjectId,
      },
    ]);
  });
});
