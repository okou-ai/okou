import { randomUUID } from "node:crypto";

import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const STRAVA: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "strava",
});
const STRAVA_SCOPES = Object.freeze([
  "read",
  "activity:read_all",
  "profile:read_all",
]);

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function newMember(): Member {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function as(member: Member) {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  return { authorization: "Bearer clerk-session" };
}

interface StravaTokenExchange {
  readonly body: URLSearchParams;
}

function mockStrava(refreshToken: string): StravaTokenExchange[] {
  const exchanges: StravaTokenExchange[] = [];
  server.use(
    http.post("https://www.strava.com/oauth/token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      exchanges.push({ body });
      return HttpResponse.json({
        access_token: `strava-access-${randomUUID()}`,
        refresh_token: refreshToken,
        expires_in: 21_600,
        scope: STRAVA_SCOPES.join(","),
        athlete: { id: 42, firstname: "Ada", lastname: "Runner" },
      });
    }),
    http.get("https://www.strava.com/api/v3/athlete", () => {
      return HttpResponse.json({
        id: 42,
        firstname: "Ada",
        lastname: "Runner",
      });
    }),
  );
  return exchanges;
}

async function startStrava(
  member: Member,
  options: {
    readonly nativeAppAuthorization?: "ios";
    readonly account?: ConnectorAccountMutationIntent;
  } = {},
) {
  const client = setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorOauthStartContract,
  );
  const response = await accept(
    client.start({
      params: { connectorSlug: "strava" },
      headers: as(member),
      body: {
        authMethod: "oauth",
        callbackTarget: "app",
        ...(options.nativeAppAuthorization
          ? { nativeAppAuthorization: options.nativeAppAuthorization }
          : {}),
        account: options.account ?? { intent: "add" },
      },
    }),
    [200],
  );
  return response.body;
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected an OAuth state in the authorization URL");
  }
  return state;
}

async function stravaCallback(query: Record<string, string>) {
  const client = setupApp({
    context,
    routes: builtinConnectorsSlugCallbackRoutes,
  })(builtinConnectorsSlugCallbackContract);
  const response = await accept(
    client.callback({
      params: { connectorSlug: "strava" },
      query: { ...query, responseMode: "json" },
      headers: {},
    }),
    [200],
  );
  return response.body;
}

function accounts() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

async function readReceipt(member: Member, attemptId: string) {
  return await accept(
    accounts().oauthCompletion({
      headers: as(member),
      params: { attemptId },
      query: STRAVA,
    }),
    [200, 404],
  );
}

describe("Strava native app authorization", () => {
  it("connectors-native-app-authorization-001 keeps web authorization for an app callback without the native capability", async () => {
    const started = await startStrava(newMember());

    expect(started.nativeAppAuthorization).toBeUndefined();
    expect(new URL(started.authorizationUrl).pathname).toBe("/oauth/authorize");
  });

  it("connectors-native-app-authorization-004 returns a denied iOS attempt without a completion", async () => {
    const member = newMember();
    const started = await startStrava(member, {
      nativeAppAuthorization: "ios",
    });

    const denied = await stravaCallback({
      state: stateOf(started.authorizationUrl),
      error: "access_denied",
    });

    expect(denied).toMatchObject({
      status: "error",
      nativeAppReturn: { platform: "ios", attemptId: started.oauthAttemptId },
    });
    const receipt = await readReceipt(member, started.oauthAttemptId);
    expect(receipt.status).toBe(404);
  });

  it("connectors-native-app-authorization-005 refuses background access when the athlete grants only the read scope", async () => {
    const member = newMember();
    mockStrava(`strava-refresh-${randomUUID()}`);
    const started = await startStrava(member, {
      nativeAppAuthorization: "ios",
    });

    const partial = await stravaCallback({
      state: stateOf(started.authorizationUrl),
      code: "mobile-code",
      scope: "read",
    });

    expect(partial).toMatchObject({
      status: "error",
      nativeAppReturn: { attemptId: started.oauthAttemptId },
    });
    const receipt = await readReceipt(member, started.oauthAttemptId);
    expect(receipt.status).toBe(404);
  });
  it("connectors-native-app-authorization-003 binds iOS authorization to the registered HTTPS callback and confirms the exact account", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const member = newMember();
    const refreshToken = `strava-refresh-${randomUUID()}`;
    const exchanges = mockStrava(refreshToken);
    const started = await startStrava(member, {
      nativeAppAuthorization: "ios",
    });

    expect(started.nativeAppAuthorization).toStrictEqual({
      provider: "strava",
    });
    const authorization = new URL(started.authorizationUrl);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      "https://www.strava.com/oauth/mobile/authorize",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/strava/callback",
    );
    expect(authorization.searchParams.get("scope")).toBe(
      STRAVA_SCOPES.join(","),
    );
    expect(authorization.searchParams.get("client_secret")).toBeNull();
    const before = await readReceipt(member, started.oauthAttemptId);
    expect(before.status).toBe(404);

    const firstCallback = {
      state: stateOf(started.authorizationUrl),
      code: "mobile-code",
      scope: STRAVA_SCOPES.join(","),
    };
    const completed = await stravaCallback(firstCallback);
    expect(completed).toMatchObject({
      status: "success",
      nativeAppReturn: { platform: "ios", attemptId: started.oauthAttemptId },
    });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.body.get("code")).toBe("mobile-code");
    expect(exchanges[0]?.body.get("client_secret")).toBeTruthy();
    expect(exchanges[0]?.body.get("redirect_uri")).toBeNull();

    const receipt = await readReceipt(member, started.oauthAttemptId);
    if (receipt.status !== 200) {
      throw new Error("Expected the completed Strava receipt");
    }
    const { connectionId } = receipt.body;
    const account = await accept(
      accounts().connection({
        headers: as(member),
        params: { connectionId },
        query: STRAVA,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      id: connectionId,
      target: STRAVA,
      authMethod: "oauth",
      connectionStatus: "connected",
      oauthScopes: STRAVA_SCOPES,
    });
    expect(JSON.stringify(account.body)).not.toContain(refreshToken);

    const reconnect = await startStrava(member, {
      nativeAppAuthorization: "ios",
      account: { intent: "reconnect", connectionId },
    });
    const reconnected = await stravaCallback({
      state: stateOf(reconnect.authorizationUrl),
      code: "mobile-code",
      scope: STRAVA_SCOPES.join(","),
    });
    expect(reconnected.status).toBe("success");
    const reconnectReceipt = await readReceipt(
      member,
      reconnect.oauthAttemptId,
    );
    expect(reconnectReceipt.status).toBe(200);
    expect(reconnectReceipt.body).toStrictEqual({ connectionId });

    const replayed = await stravaCallback(firstCallback);
    expect(replayed.status).toBe("error");
    expect("nativeAppReturn" in replayed).toBeFalsy();
  });
});
