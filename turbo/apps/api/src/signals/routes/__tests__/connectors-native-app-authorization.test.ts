import { randomUUID } from "node:crypto";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { withMockNowForTest, now } from "../../../lib/time";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { connectorAccountRoutes } from "../connector-accounts";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const target = { kind: "builtin", connectorSlug: "strava" } as const;
const requiredScope = "read,activity:read_all,profile:read_all";
const routes = Object.freeze([
  ...builtinConnectorsRoutes,
  ...builtinConnectorsSlugCallbackRoutes,
  ...connectorAccountRoutes,
]);
function app() {
  return setupApp({ context, routes });
}
function user() {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
}
async function start(
  account: { intent: "add" } | { intent: "reconnect"; connectionId: string } = {
    intent: "add",
  },
) {
  const response = await accept(
    app()(builtinConnectorOauthStartContract).start({
      headers,
      params: { connectorSlug: "strava" },
      body: {
        authMethod: "oauth",
        callbackTarget: "app",
        nativeAppAuthorization: "ios",
        account,
      },
    }),
    [200],
  );
  return response.body;
}
function state(authorizationUrl: string) {
  const value = new URL(authorizationUrl).searchParams.get("state");
  if (!value) {
    throw new Error("OAuth state missing");
  }
  return value;
}
async function complete(
  authorizationUrl: string,
  query: Record<string, string> = {},
) {
  return await accept(
    app()(builtinConnectorsSlugCallbackContract).callback({
      params: { connectorSlug: "strava" },
      query: {
        state: state(authorizationUrl),
        code: "mobile-code",
        scope: requiredScope,
        responseMode: "json",
        ...query,
      },
    }),
    [200],
  );
}
async function receipt(attemptId: string) {
  return await accept(
    app()(connectorAccountsContract).oauthCompletion({
      headers,
      params: { attemptId },
      query: target,
    }),
    [200, 404],
  );
}
function provider(refreshToken: string | null = "rotating-refresh-token") {
  server.use(
    http.post("https://www.strava.com/oauth/token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      expect(body.get("client_secret")).toBe("strava-client-secret");
      expect(body.get("code")).toBe("mobile-code");
      expect(body.get("redirect_uri")).toBeNull();
      return HttpResponse.json({
        access_token: "access-token",
        refresh_token: refreshToken,
        expires_in: 21_600,
        athlete: { id: 42 },
      });
    }),
    http.get("https://www.strava.com/api/v3/athlete", () => {
      return HttpResponse.json({ id: 42, firstname: "Athlete" });
    }),
  );
}

beforeEach(() => {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_ID", "strava-client-id");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_SECRET", "strava-client-secret");
});

test.each([
  { callbackTarget: "app", nativeAppAuthorization: undefined },
  { callbackTarget: undefined, nativeAppAuthorization: "ios" },
] as const)(
  "retains web authorization without both native capability and app callback: $callbackTarget / $nativeAppAuthorization",
  async ({ callbackTarget, nativeAppAuthorization }) => {
    user();
    const response = await accept(
      app()(builtinConnectorOauthStartContract).start({
        headers,
        params: { connectorSlug: "strava" },
        body: {
          authMethod: "oauth",
          callbackTarget,
          nativeAppAuthorization,
          account: { intent: "add" },
        },
      }),
      [200],
    );
    expect(response.body.nativeAppAuthorization).toBeUndefined();
    expect(new URL(response.body.authorizationUrl).pathname).toBe(
      "/oauth/authorize",
    );
  },
);

test("binds mobile authorization to the registered HTTPS callback and confirms the exact account", async () => {
  user();
  provider();
  const first = await start();
  const url = new URL(first.authorizationUrl);
  expect(first.nativeAppAuthorization).toStrictEqual({ provider: "strava" });
  expect(url.origin + url.pathname).toBe(
    "https://www.strava.com/oauth/mobile/authorize",
  );
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://app.okou.ai/connectors/strava/callback",
  );
  expect(url.searchParams.get("scope")).toBe(requiredScope);
  expect(url.searchParams.has("client_secret")).toBeFalsy();
  expect((await receipt(first.oauthAttemptId)).status).toBe(404);
  const completed = await complete(first.authorizationUrl);
  expect(completed.body).toMatchObject({
    status: "success",
    nativeAppReturn: { platform: "ios", attemptId: first.oauthAttemptId },
  });
  const confirmed = await receipt(first.oauthAttemptId);
  expect(confirmed.status).toBe(200);
  if (confirmed.status !== 200) {
    throw new Error("Completion not found");
  }
  const id = confirmed.body.connectionId;
  const account = await accept(
    app()(connectorAccountsContract).connection({
      headers,
      params: { connectionId: id },
      query: target,
    }),
    [200],
  );
  expect(account.body).toMatchObject({
    id,
    target,
    authMethod: "oauth",
    connectionStatus: "connected",
  });
  expect(account.body.oauthScopes).toStrictEqual([
    "read",
    "activity:read_all",
    "profile:read_all",
  ]);
  expect(JSON.stringify(account.body)).not.toContain("rotating-refresh-token");
  const reconnect = await start({ intent: "reconnect", connectionId: id });
  await complete(reconnect.authorizationUrl);
  expect((await receipt(reconnect.oauthAttemptId)).body).toStrictEqual({
    connectionId: id,
  });
  const replay = await complete(first.authorizationUrl);
  expect(replay.body.status).toBe("error");
  expect(replay.body.nativeAppReturn).toBeUndefined();
});

test("returns a denied attempt to iOS without a completion or a second authorization", async () => {
  user();
  const pending = await start();
  const denied = await complete(pending.authorizationUrl, {
    error: "access_denied",
  });
  expect(denied.body).toMatchObject({
    status: "error",
    nativeAppReturn: { platform: "ios", attemptId: pending.oauthAttemptId },
  });
  expect((await receipt(pending.oauthAttemptId)).status).toBe(404);
});

test.each([
  { scope: "read", refreshToken: "refresh" },
  { scope: requiredScope, refreshToken: null },
])(
  "does not declare background access with missing scopes or refresh credentials: $scope / $refreshToken",
  async ({ scope, refreshToken }) => {
    user();
    provider(refreshToken);
    const pending = await start();
    const result = await complete(pending.authorizationUrl, { scope });
    expect(result.body.status).toBe("error");
    expect(result.body.nativeAppReturn?.attemptId).toBe(pending.oauthAttemptId);
    expect((await receipt(pending.oauthAttemptId)).status).toBe(404);
  },
);

test("does not issue an app return for expired, foreign or fabricated state", async () => {
  user();
  const pending = await start();
  await withMockNowForTest(now() + 16 * 60_000, async () => {
    const expired = await complete(pending.authorizationUrl);
    expect(expired.body.status).toBe("error");
    expect(expired.body.nativeAppReturn).toBeUndefined();
  });
  const foreign = await start();
  const wrongTarget = await accept(
    app()(builtinConnectorsSlugCallbackContract).callback({
      params: { connectorSlug: "dropbox" },
      query: {
        state: state(foreign.authorizationUrl),
        error: "access_denied",
        responseMode: "json",
      },
    }),
    [200],
  );
  expect(wrongTarget.body.status).toBe("error");
  expect(wrongTarget.body.nativeAppReturn).toBeUndefined();
  expect(
    (await complete(foreign.authorizationUrl, { error: "access_denied" })).body
      .nativeAppReturn?.attemptId,
  ).toBe(foreign.oauthAttemptId);
  const invalid = await complete(pending.authorizationUrl, {
    state: randomUUID(),
  });
  expect(invalid.body.status).toBe("error");
  expect(invalid.body.nativeAppReturn).toBeUndefined();
});
