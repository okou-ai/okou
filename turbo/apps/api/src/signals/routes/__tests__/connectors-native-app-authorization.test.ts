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
import { server } from "../../../mocks/server";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const STRAVA: ConnectorAccountTarget = {
  kind: "builtin",
  connectorSlug: "strava",
};
const STRAVA_SCOPES = ["read", "activity:read_all", "profile:read_all"];

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
});
