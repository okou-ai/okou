import { createStore } from "ccstate";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { teamsOauthRoutes } from "../teams-oauth";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { seedOrgMembership$ } from "./helpers/org-membership";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";
import { teamsConnectRoutes } from "../teams-connect";

const context = testContext();
const mocks = createRouteMocks(context);
const store = createStore();
const API_ORIGIN = "https://api.okou.ai";
const CALLBACK_REDIRECT_URI = `${API_ORIGIN}/api/integrations/teams/oauth/callback`;
const OKOU_APP_ORIGIN = "https://app.okou.ai";
const WEB_ORIGIN = "https://www.okou.ai";
const APP_ORIGIN = "https://app.okou.test";
const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_ME_URL = "https://graph.microsoft.com/v1.0/me";

async function appRequest(
  path: string,
  options: {
    readonly origin?: string;
    readonly headers?: RequestInit["headers"];
  } = {},
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: teamsOauthRoutes,
  });
  return await app.request(`${options.origin ?? "http://api.test"}${path}`, {
    method: "GET",
    headers: options.headers,
  });
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function idToken(payload: Readonly<Record<string, unknown>>): string {
  return `${encodeJwtPart({ alg: "none" })}.${encodeJwtPart(payload)}.sig`;
}

function callbackPath(args: {
  readonly code?: string;
  readonly state: Readonly<Record<string, unknown>>;
}): string {
  const params = new URLSearchParams();
  if (args.code) {
    params.set("code", args.code);
  }
  params.set("state", JSON.stringify(args.state));
  return `/api/integrations/teams/oauth/callback?${params.toString()}`;
}

function mockMicrosoftOAuth(args: {
  readonly tenantId: string;
  readonly aadObjectId: string;
  readonly displayName?: string;
  readonly userPrincipalName: string;
  readonly expectedRedirectUri?: string;
}): void {
  server.use(
    http.post(MICROSOFT_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      expect(body.get("client_id")).toBe("test-microsoft-client-id");
      expect(body.get("client_secret")).toBe("test-microsoft-client-secret");
      expect(body.get("redirect_uri")).toBe(
        args.expectedRedirectUri ??
          `${API_ORIGIN}/api/integrations/teams/oauth/callback`,
      );
      expect(body.get("grant_type")).toBe("authorization_code");
      return HttpResponse.json({
        access_token: "ms-access-token",
        id_token: idToken({
          tid: args.tenantId,
          oid: args.aadObjectId,
        }),
      });
    }),
    http.get(MICROSOFT_ME_URL, ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer ms-access-token",
      );
      return HttpResponse.json({
        id: args.aadObjectId,
        displayName: args.displayName ?? "Ada Lovelace",
        userPrincipalName: args.userPrincipalName,
        mail: null,
      });
    }),
  );
}

async function seedMembership(
  orgId: string,
  userId: string,
  role: "admin" | "member" = "admin",
): Promise<void> {
  await store.set(seedOrgMembership$, { orgId, userId, role }, context.signal);
}

async function seedTeamsInstallation(
  track: (
    fixturePromise: Promise<TeamsConnectFixture>,
  ) => Promise<TeamsConnectFixture>,
): Promise<TeamsConnectFixture> {
  const fixture = await track(Promise.resolve(teamsConnectFixture()));
  await installTeamsForTest(context.signal, fixture);
  return fixture;
}

describe("Teams OAuth API routes", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv(APP_ORIGIN, API_ORIGIN);
    mockEnv("OKOU_WEB_URL", WEB_ORIGIN);
    mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "test-microsoft-client-id");
    mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "test-microsoft-client-secret");
  });

  it("redirects to Microsoft OAuth with connect state without a browser session", async () => {
    const response = await appRequest(
      "/api/teams/oauth/connect?orgId=org_1&userId=user_1",
    );

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(redirectUrl.searchParams.get("client_id")).toBe(
      "test-microsoft-client-id",
    );
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/integrations/teams/oauth/callback`,
    );
    expect(redirectUrl.searchParams.get("scope")).toBe(
      "openid profile email User.Read",
    );
    const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
      readonly orgId: string;
      readonly publicBrand: string;
      readonly redirectUri: string;
      readonly userId: string;
    };
    expect(state).toStrictEqual({
      orgId: "org_1",
      publicBrand: "okou",
      redirectUri: `${API_ORIGIN}/api/integrations/teams/oauth/callback`,
      userId: "user_1",
    });
  });

  it("keeps API-host connect requests on the API callback origin", async () => {
    const response = await appRequest(
      "/api/teams/oauth/connect?orgId=org_1&userId=user_1",
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/integrations/teams/oauth/callback`,
    );
  });

  it("rejects connect requests without org and user state", async () => {
    const response = await appRequest("/api/teams/oauth/connect");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing orgId or userId",
    });
  });

  it.each([
    ["missing", ""],
    ["malformed", `&state=${encodeURIComponent("not-json")}`],
    [
      "omitted-brand",
      `&state=${encodeURIComponent(
        JSON.stringify({
          redirectUri: `${API_ORIGIN}/api/integrations/teams/oauth/callback`,
        }),
      )}`,
    ],
    [
      "invalid-brand",
      `&state=${encodeURIComponent(
        JSON.stringify({
          publicBrand: "other",
          redirectUri: `${API_ORIGIN}/api/integrations/teams/oauth/callback`,
        }),
      )}`,
    ],
  ])(
    "rejects %s callback state using the trusted request brand",
    async (_caseName, stateQuery) => {
      mockEnv("APP_URL", "https://app.okou.ai");

      const response = await appRequest(
        `/api/integrations/teams/oauth/callback?code=valid-code${stateQuery}`,
        { origin: API_ORIGIN },
      );

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe(OKOU_APP_ORIGIN);
      expect(location.pathname).toBe("/settings/teams");
      expect(location.searchParams.get("error")).toBe("Invalid connect state.");
    },
  );

  it("uses the configured app for provider errors with malformed state", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");

    const response = await appRequest(
      `/api/integrations/teams/oauth/callback?error=access_denied&state=${encodeURIComponent("not-json")}`,
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(OKOU_APP_ORIGIN);
    expect(location.pathname).toBe("/settings/teams");
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  it("connects and binds an unbound Teams installation using Microsoft OAuth", async () => {
    const fixture = await seedTeamsInstallation(track);
    await seedMembership(fixture.orgId, fixture.userId, "admin");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockMicrosoftOAuth({
      tenantId: fixture.teamsTenantId,
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
    });

    const response = await appRequest(
      callbackPath({
        code: "valid-code",
        state: {
          orgId: fixture.orgId,
          publicBrand: "okou",
          userId: fixture.userId,
          redirectUri: CALLBACK_REDIRECT_URI,
        },
      }),
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );
    expect(
      new URL(response.headers.get("location")!).searchParams.get("botName"),
    ).toBe("Nova");

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
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
      connectUrl: null,
      tenantId: fixture.teamsTenantId,
      botName: "Nova",
    });
  });

  it("exchanges the code with the redirect URI recorded in the connect state", async () => {
    const fixture = await seedTeamsInstallation(track);
    await seedMembership(fixture.orgId, fixture.userId, "admin");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const recordedRedirectUri =
      "https://pr-1-api.vm7.ai/api/integrations/teams/oauth/callback";
    mockMicrosoftOAuth({
      tenantId: fixture.teamsTenantId,
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
      expectedRedirectUri: recordedRedirectUri,
    });

    const response = await appRequest(
      callbackPath({
        code: "valid-code",
        state: {
          orgId: fixture.orgId,
          publicBrand: "okou",
          userId: fixture.userId,
          redirectUri: recordedRedirectUri,
        },
      }),
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );
    expect(
      new URL(response.headers.get("location")!).searchParams.get("botName"),
    ).toBe("Nova");
  });

  it("rejects OAuth users when the org is already bound to another Microsoft tenant", async () => {
    const fixture = await seedTeamsInstallation(track);
    await seedMembership(fixture.orgId, fixture.userId, "admin");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
        },
      }),
      [200],
    );

    mockMicrosoftOAuth({
      tenantId: `other-${fixture.teamsTenantId}`,
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
    });

    const response = await appRequest(
      callbackPath({
        code: "valid-code",
        state: {
          orgId: fixture.orgId,
          publicBrand: "okou",
          userId: fixture.userId,
          redirectUri: CALLBACK_REDIRECT_URI,
        },
      }),
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(new URL(location!).searchParams.get("error")).toContain(
      "active organization doesn't match",
    );
  });

  it("rejects callback state when the internal user is not an org member", async () => {
    const fixture = await seedTeamsInstallation(track);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    const response = await appRequest(
      callbackPath({
        code: "valid-code",
        state: {
          orgId: fixture.orgId,
          publicBrand: "okou",
          userId: fixture.userId,
          redirectUri: CALLBACK_REDIRECT_URI,
        },
      }),
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(new URL(location!).searchParams.get("error")).toBe(
      "Invalid connect state.",
    );
  });
});
