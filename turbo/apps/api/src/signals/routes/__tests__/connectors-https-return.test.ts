import { randomUUID } from "node:crypto";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { connectorAccountRoutes } from "../connector-accounts";
import { createRouteMocks } from "./helpers/route-test";
import { mockGitHubConnectorOAuth } from "./helpers/api-bdd-connectors";

const context = testContext();
const mocks = createRouteMocks(context);
const routes = Object.freeze([
  ...builtinConnectorsRoutes,
  ...builtinConnectorsSlugCallbackRoutes,
  ...connectorAccountRoutes,
]);
const client = setupApp({ context, routes });
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const slugs = Object.freeze([
  "gmail",
  "google-docs",
  "google-drive",
  "google-sheets",
  "google-calendar",
  "google-ads",
  "google-analytics",
  "google-forms",
  "google-maps",
  "google-meet",
  "youtube",
  "github",
  "notion",
]);

beforeEach(() => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-test-client");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-test-secret");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-secret");
  mockGitHubConnectorOAuth({ userId: 50_160, login: "native-oauth" });
});

async function start(connectorSlug: string, native = true) {
  const response = await accept(
    client(builtinConnectorOauthStartContract).start({
      headers,
      params: { connectorSlug },
      body: {
        authMethod: "oauth",
        account: { intent: "add" },
        callbackTarget: "app",
        ...(native ? { nativeCallback: "ios-https" as const } : {}),
      },
    }),
    [200],
  );
  const url = new URL(response.body.authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected provider state");
  }
  return { ...response.body, state, url };
}

async function receipt(connectorSlug: string, attemptId: string) {
  return await accept(
    client(connectorAccountsContract).oauthCompletion({
      headers,
      params: { attemptId },
      query: { kind: "builtin", connectorSlug },
    }),
    [200, 404],
  );
}

test.each(slugs)(
  "returns %s to iOS only after completing its original backend grant",
  async (connectorSlug) => {
    const callbackUri = `https://app.okou.ai/connectors/${connectorSlug}/callback`;
    server.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        expect(
          new URLSearchParams(await request.text()).get("redirect_uri"),
        ).toBe(callbackUri);
        return HttpResponse.json({
          access_token: "google-token",
          refresh_token: "google-refresh",
          expires_in: 3600,
        });
      }),
      http.get("https://openidconnect.googleapis.com/v1/userinfo", () => {
        return HttpResponse.json({
          sub: "google-native-user",
          name: "Native User",
          email: "native@example.test",
        });
      }),
      http.get("https://www.googleapis.com/oauth2/v2/userinfo", () => {
        return HttpResponse.json({
          id: "google-native-user",
          name: "Native User",
          email: "native@example.test",
        });
      }),
      http.post(
        "https://api.notion.com/v1/oauth/token",
        async ({ request }) => {
          await expect(request.json()).resolves.toMatchObject({
            redirect_uri: callbackUri,
          });
          return HttpResponse.json({
            access_token: "notion-token",
            refresh_token: "notion-refresh",
            owner: {
              user: {
                id: "notion-native-user",
                name: "Native User",
                person: { email: "native@example.test" },
              },
            },
          });
        },
      ),
    );
    const started = await start(connectorSlug);
    const returnUrl = `https://app.okou.ai/native/connector-authorization?attemptId=${started.oauthAttemptId}`;
    expect(started.nativeCallbackUrl).toBe(returnUrl);
    expect(started.url.searchParams.get("redirect_uri")).toBe(callbackUri);
    expect((await receipt(connectorSlug, started.oauthAttemptId)).status).toBe(
      404,
    );

    const callback = await accept(
      client(builtinConnectorsSlugCallbackContract).callback({
        params: { connectorSlug },
        query: {
          code: "provider-code",
          state: started.state,
          responseMode: "json",
        },
      }),
      [200],
    );
    expect(callback.body).toMatchObject({
      status: "success",
      nativeAppReturn: {
        platform: "ios",
        attemptId: started.oauthAttemptId,
        httpsHost: "app.okou.ai",
      },
    });
    const completed = await receipt(connectorSlug, started.oauthAttemptId);
    expect(completed.status).toBe(200);
    if (completed.status !== 200) {
      throw new Error("Expected a saved connection");
    }
    const account = await accept(
      client(connectorAccountsContract).connection({
        headers,
        params: { connectionId: completed.body.connectionId },
        query: { kind: "builtin", connectorSlug },
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      id: completed.body.connectionId,
      connectionStatus: "connected",
    });
  },
);

test("returns provider refusal to iOS without creating a connection or allowing state replay", async () => {
  const started = await start("github");
  const callbacks = client(builtinConnectorsSlugCallbackContract);
  const denied = await accept(
    callbacks.callback({
      params: { connectorSlug: "github" },
      query: {
        state: started.state,
        error: "access_denied",
        responseMode: "json",
      },
    }),
    [200],
  );
  expect(denied.body).toMatchObject({
    status: "error",
    nativeAppReturn: {
      platform: "ios",
      attemptId: started.oauthAttemptId,
      httpsHost: "app.okou.ai",
    },
  });
  expect((await receipt("github", started.oauthAttemptId)).status).toBe(404);
  const replay = await accept(
    callbacks.callback({
      params: { connectorSlug: "github" },
      query: { state: started.state, code: "replayed", responseMode: "json" },
    }),
    [200],
  );
  expect(replay.body).toMatchObject({ status: "error" });
  expect(replay.body.nativeAppReturn).toBeUndefined();
});

test("uses the HTTPS return for direct callbacks and ignores unclaimed native-looking state", async () => {
  const started = await start("github");
  const app = createApp({ signal: context.signal, routes });
  const callback = new URL(
    "https://api.okou.ai/api/connectors/github/callback",
  );
  callback.searchParams.set("state", started.state);
  callback.searchParams.set("error", "access_denied");
  const denied = await app.request(callback.toString(), {
    headers: { "x-okou-web-origin": "https://okou.ai" },
  });
  expect(denied.status).toBe(307);
  expect(denied.headers.get("location")).toBe(started.nativeCallbackUrl);
  callback.searchParams.set("state", `ios-https-v1:${randomUUID()}`);
  const invalid = await app.request(callback.toString(), {
    headers: { "x-okou-web-origin": "https://okou.ai" },
  });
  expect(new URL(invalid.headers.get("location") ?? "").pathname).toBe(
    "/connector/error",
  );
});

test("keeps ordinary web grants and providers outside this delivery on the existing completion path", async () => {
  const web = await start("github", false);
  const unsupported = await start("test-oauth");
  expect(web.nativeCallbackUrl).toBeUndefined();
  expect(unsupported.nativeCallbackUrl).toBeUndefined();
  const result = await accept(
    client(builtinConnectorsSlugCallbackContract).callback({
      params: { connectorSlug: "github" },
      query: { state: web.state, error: "access_denied", responseMode: "json" },
    }),
    [200],
  );
  expect(result.body).toMatchObject({ status: "error" });
  expect(result.body.nativeAppReturn).toBeUndefined();
});

test("keeps staging returns on their associated domain and omits HTTPS mode on arbitrary previews", async () => {
  mockEnv("APP_URL", "https://staging-app.omby.ai");
  const staging = await start("github");
  expect(staging.nativeCallbackUrl).toBe(
    `https://staging-app.omby.ai/native/connector-authorization?attemptId=${staging.oauthAttemptId}`,
  );
  mockEnv("APP_URL", "https://pr-123-app-okou-app-preview.vm0.workers.dev");
  const preview = await start("github");
  expect(preview.nativeCallbackUrl).toBeUndefined();
});
