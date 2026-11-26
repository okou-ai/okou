import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { createRouteMocks } from "./helpers/route-test";
import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { mockGitHubConnectorOAuth } from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const APP_ORIGIN = "https://app.okou.ai";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

type NativeSlug =
  | "gmail"
  | "google-drive"
  | "google-sheets"
  | "google-calendar"
  | "github"
  | "notion"
  | "test-oauth";

function useHostedApp(): void {
  mockEnv("APP_URL", APP_ORIGIN);
}

function signIn(actor: ApiTestUser): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
}

/** Google exchanges codes only for the app callback registered for that connector. */
function mockGoogleProvider(slug: NativeSlug): void {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  const expectedRedirect = `${APP_ORIGIN}/connectors/${slug}/callback`;
  const identity = {
    sub: "native-google-user",
    id: "native-google-user",
    email: "native@example.test",
    name: "Native User",
  };
  server.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("redirect_uri") !== expectedRedirect) {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }
      return HttpResponse.json({
        access_token: `google-access-${randomUUID()}`,
        refresh_token: `google-refresh-${randomUUID()}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: body.get("scope") ?? undefined,
      });
    }),
    http.get("https://openidconnect.googleapis.com/v1/userinfo", () => {
      return HttpResponse.json(identity);
    }),
    http.get("https://www.googleapis.com/oauth2/v2/userinfo", () => {
      return HttpResponse.json(identity);
    }),
  );
}

function mockNotionProvider(): void {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-client-secret");
  const expectedRedirect = `${APP_ORIGIN}/connectors/notion/callback`;
  server.use(
    http.post("https://api.notion.com/v1/oauth/token", async ({ request }) => {
      const text = await request.text();
      const redirect = text.trim().startsWith("{")
        ? (JSON.parse(text) as { redirect_uri?: unknown }).redirect_uri
        : new URLSearchParams(text).get("redirect_uri");
      if (redirect !== expectedRedirect) {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }
      return HttpResponse.json({
        access_token: `notion-access-${randomUUID()}`,
        refresh_token: "notion-refresh-token",
        bot_id: `bot-${randomUUID()}`,
        owner: { user: { id: "native-notion-user", name: "Native User" } },
      });
    }),
  );
}

async function startOauth(
  actor: ApiTestUser,
  slug: NativeSlug,
  native: boolean,
) {
  signIn(actor);
  const response = await accept(
    setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorOauthStartContract,
    ).start({
      params: { connectorSlug: slug },
      headers,
      body: {
        authMethod: "oauth",
        callbackTarget: "app",
        ...(native ? { nativeCallback: "ios-https" as const } : {}),
        account: { intent: "add" },
      },
    }),
    [200],
  );
  return response.body;
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return state;
}

async function callbackResult(
  slug: NativeSlug,
  query: { readonly state: string } & Record<string, string>,
) {
  const response = await accept(
    setupApp({ context, routes: builtinConnectorsSlugCallbackRoutes })(
      builtinConnectorsSlugCallbackContract,
    ).callback({
      params: { connectorSlug: slug },
      query: { ...query, responseMode: "json" },
      headers: {},
    }),
    [200],
  );
  if (response.status !== 200) {
    throw new Error("Expected a JSON callback result");
  }
  return response.body;
}

function accountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

async function readReceipt(
  actor: ApiTestUser,
  attemptId: string,
  target: ConnectorAccountTarget,
) {
  signIn(actor);
  return await accept(
    accountsClient().oauthCompletion({
      headers,
      params: { attemptId },
      query: target,
    }),
    [200, 404],
  );
}

function nativeReturn(attemptId: string) {
  return { platform: "ios", attemptId, httpsHost: "app.okou.ai" };
}

async function returnsToIosAfterGrant(slug: NativeSlug) {
  useHostedApp();
  const actor = bdd.user();
  const target: ConnectorAccountTarget = {
    kind: "builtin",
    connectorSlug: slug,
  };
  const started = await startOauth(actor, slug, true);
  const attemptId = started.oauthAttemptId;
  expect(started.nativeCallbackUrl).toBe(
    `${APP_ORIGIN}/native/connector-authorization?attemptId=${attemptId}`,
  );
  expect(
    new URL(started.authorizationUrl).searchParams.get("redirect_uri"),
  ).toBe(`${APP_ORIGIN}/connectors/${slug}/callback`);
  const before = await readReceipt(actor, attemptId, target);
  expect(before.status).toBe(404);

  const result = await callbackResult(slug, {
    state: stateOf(started.authorizationUrl),
    code: `code-${randomUUID()}`,
  });
  expect(result).toMatchObject({
    status: "success",
    nativeAppReturn: nativeReturn(attemptId),
  });
  const receipt = await readReceipt(actor, attemptId, target);
  if (receipt.status !== 200) {
    throw new Error("Expected a completion receipt");
  }
  signIn(actor);
  const connection = await accept(
    accountsClient().connection({
      headers,
      params: { connectionId: receipt.body.connectionId },
      query: target,
    }),
    [200],
  );
  expect(connection.body).toMatchObject({
    id: receipt.body.connectionId,
    connectionStatus: "connected",
  });
}

describe("connector HTTPS return to iOS", () => {
  it("connectors-https-return-014 returns a provider refusal to iOS without a connection or state replay", async () => {
    useHostedApp();
    mockGitHubConnectorOAuth({ login: "native-oauth" });
    const actor = bdd.user();
    const started = await startOauth(actor, "github", true);
    const state = stateOf(started.authorizationUrl);
    const refusal = await callbackResult("github", {
      state,
      error: "access_denied",
    });
    expect(refusal).toMatchObject({
      status: "error",
      nativeAppReturn: nativeReturn(started.oauthAttemptId),
    });
    const receipt = await readReceipt(actor, started.oauthAttemptId, {
      kind: "builtin",
      connectorSlug: "github",
    });
    expect(receipt.status).toBe(404);
    const replay = await callbackResult("github", { state, code: "replayed" });
    expect(replay.status).toBe("error");
    expect(replay).not.toHaveProperty("nativeAppReturn");
  });

  it("connectors-https-return-001 returns gmail to iOS only after its backend grant completes", async () => {
    mockGoogleProvider("gmail");
    await expect(returnsToIosAfterGrant("gmail")).resolves.toBeUndefined();
  });

  it("connectors-https-return-003 returns google-drive to iOS only after its backend grant completes", async () => {
    mockGoogleProvider("google-drive");
    await expect(
      returnsToIosAfterGrant("google-drive"),
    ).resolves.toBeUndefined();
  });

  it("connectors-https-return-004 returns google-sheets to iOS only after its backend grant completes", async () => {
    mockGoogleProvider("google-sheets");
    await expect(
      returnsToIosAfterGrant("google-sheets"),
    ).resolves.toBeUndefined();
  });

  it("connectors-https-return-005 returns google-calendar to iOS only after its backend grant completes", async () => {
    mockGoogleProvider("google-calendar");
    await expect(
      returnsToIosAfterGrant("google-calendar"),
    ).resolves.toBeUndefined();
  });

  it("connectors-https-return-012 returns github to iOS only after its backend grant completes", async () => {
    mockGitHubConnectorOAuth({ login: "native-oauth" });
    await expect(returnsToIosAfterGrant("github")).resolves.toBeUndefined();
  });

  it("connectors-https-return-013 returns notion to iOS only after its backend grant completes", async () => {
    mockNotionProvider();
    await expect(returnsToIosAfterGrant("notion")).resolves.toBeUndefined();
  });

  it("connectors-https-return-016 keeps web grants unchanged and returns connectors outside the original list", async () => {
    useHostedApp();
    mockGitHubConnectorOAuth();
    const actor = bdd.user();
    const web = await startOauth(actor, "github", false);
    const native = await startOauth(actor, "test-oauth", true);
    expect(web).not.toHaveProperty("nativeCallbackUrl");
    expect(native.nativeCallbackUrl).toBe(
      `${APP_ORIGIN}/native/connector-authorization?attemptId=${native.oauthAttemptId}`,
    );
    const nativeRefusal = await callbackResult("test-oauth", {
      state: stateOf(native.authorizationUrl),
      error: "access_denied",
    });
    expect(nativeRefusal).toMatchObject({
      status: "error",
      nativeAppReturn: nativeReturn(native.oauthAttemptId),
    });
    const webRefusal = await callbackResult("github", {
      state: stateOf(web.authorizationUrl),
      error: "access_denied",
    });
    expect(webRefusal.status).toBe("error");
    expect(webRefusal).not.toHaveProperty("nativeAppReturn");
  });

  it("connectors-https-return-015 redirects direct callbacks to the result page with native return params and ignores unclaimed native state", async () => {
    useHostedApp();
    mockGitHubConnectorOAuth();
    const actor = bdd.user();
    const started = await startOauth(actor, "github", true);
    const callback = setupApp({
      baseUrl: "https://api.okou.ai",
      context,
      routes: builtinConnectorsSlugCallbackRoutes,
    })(builtinConnectorsSlugCallbackContract);
    const [direct, unclaimed] = await Promise.all([
      accept(
        callback.callback({
          params: { connectorSlug: "github" },
          query: {
            state: stateOf(started.authorizationUrl),
            error: "access_denied",
          },
          headers: {},
          extraHeaders: { "x-okou-web-origin": "https://okou.ai" },
        }),
        [307],
      ),
      accept(
        callback.callback({
          params: { connectorSlug: "github" },
          query: {
            state: `ios-https-v1:${randomUUID()}`,
            error: "access_denied",
          },
          headers: {},
          extraHeaders: { "x-okou-web-origin": "https://okou.ai" },
        }),
        [307],
      ),
    ]);
    const directUrl = new URL(direct.headers.get("location") ?? "");
    expect(`${directUrl.origin}${directUrl.pathname}`).toBe(
      `${APP_ORIGIN}/connectors/github/callback/error`,
    );
    expect(directUrl.searchParams.get("nativeAppAttemptId")).toBe(
      started.oauthAttemptId,
    );
    expect(directUrl.searchParams.get("nativeAppHttpsHost")).toBe(
      "app.okou.ai",
    );
    expect(directUrl.searchParams.get("message")).toBeTruthy();

    const unclaimedUrl = new URL(unclaimed.headers.get("location") ?? "");
    expect(unclaimedUrl.pathname).toBe("/connector/error");
    expect(unclaimedUrl.searchParams.has("nativeAppAttemptId")).toBeFalsy();
    expect(unclaimedUrl.searchParams.has("nativeAppHttpsHost")).toBeFalsy();
  });
});
