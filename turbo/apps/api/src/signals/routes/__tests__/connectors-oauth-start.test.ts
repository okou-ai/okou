import { createHash, randomUUID } from "node:crypto";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { connectorAccountRoutes } from "../connector-accounts";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const STATE = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface StartOptions {
  readonly callbackTarget?: "app";
}

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function signIn(): Member {
  const member = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(member.userId, member.orgId, "org:member");
  return member;
}

async function signInWithSwitch(key: FeatureSwitchKey): Promise<void> {
  const member = signIn();
  await updateFeatureSwitchesForUser(context, member, { [key]: true });
  mocks.clerk.session(member.userId, member.orgId, "org:member");
}

function okouHosts(): void {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
}

function configureClient(envPrefix: string, clientId: string): void {
  okouHosts();
  mockOptionalEnv(`${envPrefix}_OAUTH_CLIENT_ID`, clientId);
  mockOptionalEnv(`${envPrefix}_OAUTH_CLIENT_SECRET`, `${clientId}-secret`);
}

async function requestStart(
  connectorSlug: string,
  options: StartOptions,
  statuses: readonly (200 | 400 | 401 | 403)[],
  baseUrl = "https://api.okou.ai",
) {
  const client = setupApp({
    context,
    routes: builtinConnectorsRoutes,
    baseUrl,
  })(builtinConnectorOauthStartContract);
  return await accept(
    client.start({
      headers,
      params: { connectorSlug },
      body: { authMethod: "oauth", account: { intent: "add" }, ...options },
    }),
    statuses,
  );
}

async function start(
  connectorSlug: string,
  options: StartOptions = { callbackTarget: "app" },
  baseUrl?: string,
) {
  const response = await requestStart(connectorSlug, options, [200], baseUrl);
  if (!("authorizationUrl" in response.body)) {
    throw new Error("Expected an authorization URL");
  }
  const url = new URL(response.body.authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return { body: response.body, url, state };
}

async function callbackAt(
  baseUrl: string,
  connectorSlug: string,
  query: Readonly<Record<string, string>>,
): Promise<URL> {
  const client = setupApp({
    context,
    routes: builtinConnectorsSlugCallbackRoutes,
    baseUrl,
  })(builtinConnectorsSlugCallbackContract);
  const response = await accept(
    client.callback({ params: { connectorSlug }, query, headers: {} }),
    [307],
  );
  return new URL(response.headers.get("location") ?? "");
}

/**
 * The provider returns the browser to the API callback; connectors whose
 * callback lives on the Web origin are first sent to that canonical callback,
 * which the browser follows.
 */
async function callback(
  connectorSlug: string,
  query: Readonly<Record<string, string>>,
): Promise<URL> {
  const location = await callbackAt(
    "https://api.okou.ai",
    connectorSlug,
    query,
  );
  if (
    location.origin !== "https://www.okou.ai" ||
    location.pathname !== `/api/connectors/${connectorSlug}/callback`
  ) {
    return location;
  }
  return await callbackAt(
    "https://www.okou.ai",
    connectorSlug,
    Object.fromEntries(location.searchParams),
  );
}

function redirectTarget(location: URL): string {
  return `${location.origin}${location.pathname}`;
}

interface ProviderRequest {
  readonly body: URLSearchParams;
  readonly json: boolean;
  readonly authorization: string | null;
}

async function readProviderRequest(request: Request): Promise<ProviderRequest> {
  const body = new URL(request.url).searchParams;
  const text = request.method === "GET" ? "" : await request.text();
  const json = (request.headers.get("content-type") ?? "").includes("json");
  if (json) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      for (const [key, value] of Object.entries(parsed)) {
        body.set(key, String(value));
      }
    }
  } else {
    for (const [key, value] of new URLSearchParams(text)) {
      body.set(key, value);
    }
  }
  return { body, json, authorization: request.headers.get("authorization") };
}

function mockTokenEndpoint(
  url: string,
  response: Readonly<Record<string, unknown>>,
  method: "get" | "post" = "post",
): ProviderRequest[] {
  const requests: ProviderRequest[] = [];
  server.use(
    http[method](url, async ({ request }) => {
      requests.push(await readProviderRequest(request));
      return HttpResponse.json(response);
    }),
  );
  return requests;
}

function mockJson(
  method: "get" | "post",
  url: string,
  response: Readonly<Record<string, unknown>>,
): void {
  server.use(
    http[method](url, () => {
      return HttpResponse.json(response);
    }),
  );
}

const tokens = Object.freeze({
  access_token: "provider-access-token",
  refresh_token: "provider-refresh-token",
  expires_in: 3600,
  token_type: "Bearer",
});

async function connectThroughApp(
  connectorSlug: string,
  query: Readonly<Record<string, string>> = {
    code: `${connectorSlug}-authorization-code`,
  },
) {
  const started = await start(connectorSlug);
  const location = await callback(connectorSlug, {
    ...query,
    state: started.state,
  });
  return { ...started, location };
}

function appCallback(connectorSlug: string): string {
  return `https://app.okou.ai/connectors/${connectorSlug}/callback`;
}

function expectAppAuthorization(
  started: { readonly url: URL; readonly state: string },
  args: {
    readonly authorizeUrl: string;
    readonly clientId: string;
    readonly connectorSlug: string;
    readonly clientIdParam?: string;
  },
): void {
  expect(`${started.url.origin}${started.url.pathname}`).toBe(
    args.authorizeUrl,
  );
  expect(started.url.searchParams.get(args.clientIdParam ?? "client_id")).toBe(
    args.clientId,
  );
  expect(started.url.searchParams.get("redirect_uri")).toBe(
    appCallback(args.connectorSlug),
  );
  expect(started.state).toMatch(STATE);
}

function expectSingleTokenRedirect(
  requests: readonly ProviderRequest[],
  connectorSlug: string,
): void {
  expect(requests).toHaveLength(1);
  expect(requests[0]?.body.get("redirect_uri")).toBe(
    appCallback(connectorSlug),
  );
}

function expectNoPkce(url: URL): void {
  expect(url.searchParams.get("code_challenge")).toBeNull();
  expect(url.searchParams.get("code_challenge_method")).toBeNull();
}

function expectPkce(url: URL, requests: readonly ProviderRequest[]): string {
  const challenge = url.searchParams.get("code_challenge");
  expect(challenge).toMatch(BASE64URL);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const verifier = requests[0]?.body.get("code_verifier") ?? "";
  expect(verifier).toMatch(BASE64URL);
  return verifier;
}

function expectPkceVerifier(
  url: URL,
  requests: readonly ProviderRequest[],
): void {
  const verifier = expectPkce(url, requests);
  expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
    url.searchParams.get("code_challenge"),
  );
}

describe("POST /api/connectors/:connectorSlug/oauth/start", () => {
  it("connectors-oauth-start-087 returns 401 instead of relying on browser cookies when unauthenticated", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorOauthStartContract,
    );

    const response = await accept(
      client.start({
        headers: {},
        params: { connectorSlug: "github" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("connectors-oauth-start-002 returns the future connection id for an unnamed account addition", async () => {
    signIn();

    const started = await start("test-oauth", {});

    expect(started.body.connectionId).toBeTruthy();
    expect(started.state).toMatch(STATE);
  });

  it("connectors-oauth-start-003 keeps an omitted callback target on the existing Web callback", async () => {
    configureClient("GOOGLE", "google-test-client-id");
    signIn();

    const started = await start("youtube", {});

    expect(`${started.url.origin}${started.url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(started.url.searchParams.get("client_id")).toBe(
      "google-test-client-id",
    );
    expect(started.url.searchParams.get("redirect_uri")).toBe(
      "https://www.okou.ai/api/connectors/youtube/callback",
    );
    expect(started.url.searchParams.get("scope")?.split(" ")).toStrictEqual([
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
    expect(started.url.searchParams.get("access_type")).toBe("offline");
    expect(started.url.searchParams.get("prompt")).toBe("consent");
    expect(started.state).toMatch(STATE);
  });

  it("connectors-oauth-start-004 returns the provider authorization URL without an API redirect", async () => {
    configureClient("GH", "test-client-id");
    signIn();

    const started = await start("github", {}, "https://www.okou.ai");

    expect(`${started.url.origin}${started.url.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(started.url.searchParams.get("client_id")).toBe("test-client-id");
    expect(started.url.searchParams.get("redirect_uri")).toBe(
      "https://www.okou.ai/api/connectors/github/callback",
    );
    expect(started.state).toMatch(STATE);
  });

  it("connectors-oauth-start-009 uses the direct Okou App callback for GitHub and reuses its exact redirect URI", async () => {
    configureClient("GH", "test-client-id");
    const requests = mockTokenEndpoint(
      "https://github.com/login/oauth/access_token",
      { access_token: "github-access-token", scope: "repo,project,workflow" },
    );
    mockJson("get", "https://api.github.com/user", {
      id: 4242,
      login: "github-test-user",
      email: "github-test-user@example.test",
    });
    signIn();

    const started = await connectThroughApp("github");

    expectAppAuthorization(started, {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      clientId: "test-client-id",
      connectorSlug: "github",
    });
    expect(started.url.searchParams.get("scope")).toBe("repo project workflow");
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "github");
  });

  it("connectors-oauth-start-010 returns github provider denial to the configured Okou app", async () => {
    configureClient("GH", "test-client-id");
    signIn();

    const started = await connectThroughApp("github", {
      error: "access_denied",
    });

    expect(started.state).toMatch(STATE);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/error",
    );
  });

  it("connectors-oauth-start-013 uses the direct Okou App callback for Airtable and reuses its exact PKCE redirect URI", async () => {
    configureClient("AIRTABLE", "airtable-test-client-id");
    const requests = mockTokenEndpoint("https://airtable.com/oauth2/v1/token", {
      ...tokens,
      scope: "data.records:read",
    });
    mockJson("get", "https://api.airtable.com/v0/meta/whoami", {
      id: "airtable-user-123",
      email: "airtable-user@example.test",
    });
    signIn();

    const started = await connectThroughApp("airtable");

    expect(started.body.connectionId).toMatch(UUID);
    expectAppAuthorization(started, {
      authorizeUrl: "https://airtable.com/oauth2/v1/authorize",
      clientId: "airtable-test-client-id",
      connectorSlug: "airtable",
    });
    expect(started.location.origin).toBe("https://app.okou.ai");
    expectSingleTokenRedirect(requests, "airtable");
    expectPkce(started.url, requests);
    const account = await accept(
      setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      ).connection({
        headers,
        params: { connectionId: started.body.connectionId ?? "" },
        query: { kind: "builtin", connectorSlug: "airtable" },
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      id: started.body.connectionId,
      target: { kind: "builtin", connectorSlug: "airtable" },
      connectionStatus: "connected",
    });
  });

  it("connectors-oauth-start-014 reuses the direct Okou redirect URI for a Google token exchange", async () => {
    configureClient("GOOGLE", "google-test-client-id");
    const requests = mockTokenEndpoint("https://oauth2.googleapis.com/token", {
      ...tokens,
      scope: "https://www.googleapis.com/auth/gmail.modify",
    });
    mockJson("get", "https://openidconnect.googleapis.com/v1/userinfo", {
      sub: "google-user-1",
      email: "google-user@example.test",
      name: "Google User",
    });
    signIn();

    const started = await connectThroughApp("gmail");

    expect(started.url.searchParams.get("redirect_uri")).toBe(
      appCallback("gmail"),
    );
    expect(started.state).toMatch(STATE);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "gmail");
  });

  it("connectors-oauth-start-015 uses the direct Okou App callback for Box and reuses its exact redirect URI", async () => {
    configureClient("BOX", "box-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.box.com/oauth2/token",
      tokens,
    );
    mockJson("get", "https://api.box.com/2.0/users/me", {
      id: "box-user-1",
      name: "Box User",
      login: "box-user@example.test",
    });
    signIn();

    const started = await connectThroughApp("box");

    expectAppAuthorization(started, {
      authorizeUrl: "https://account.box.com/api/oauth2/authorize",
      clientId: "box-test-client-id",
      connectorSlug: "box",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "box");
  });

  it("connectors-oauth-start-016 uses the direct Okou App callback for HubSpot and reuses its exact redirect URI", async () => {
    configureClient("HUBSPOT", "hubspot-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.hubapi.com/oauth/v1/token",
      tokens,
    );
    mockJson(
      "get",
      "https://api.hubapi.com/oauth/v1/access-tokens/provider-access-token",
      {
        user_id: 1001,
        hub_id: 2002,
        user: "hubspot-user@example.test",
        hub_domain: "example.hubspot.com",
      },
    );
    signIn();

    const started = await connectThroughApp("hubspot");

    expectAppAuthorization(started, {
      authorizeUrl: "https://app.hubspot.com/oauth/authorize",
      clientId: "hubspot-test-client-id",
      connectorSlug: "hubspot",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "hubspot");
  });

  it("connectors-oauth-start-017 uses the direct Okou App callback for Meta Ads and reuses its exact redirect URI", async () => {
    configureClient("META_ADS", "meta-ads-test-client-id");
    const tokenUrl = "https://graph.facebook.com/v22.0/oauth/access_token";
    const tokenResponse = { access_token: "meta-token", token_type: "bearer" };
    const posted = mockTokenEndpoint(tokenUrl, tokenResponse);
    const fetched = mockTokenEndpoint(tokenUrl, tokenResponse, "get");
    mockJson("get", "https://graph.facebook.com/v22.0/me", {
      id: "meta-user-1",
      name: "Meta User",
      email: "meta-user@example.test",
    });
    signIn();

    const started = await connectThroughApp("meta-ads");

    expectAppAuthorization(started, {
      authorizeUrl: "https://www.facebook.com/v22.0/dialog/oauth",
      clientId: "meta-ads-test-client-id",
      connectorSlug: "meta-ads",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    const withRedirect = [...posted, ...fetched].filter((request) => {
      return request.body.has("redirect_uri");
    });
    expectSingleTokenRedirect(withRedirect, "meta-ads");
  });

  it("connectors-oauth-start-018 uses the direct Okou App callback for TikTok Ads without adding a token redirect URI", async () => {
    configureClient("TIKTOK_ADS", "tiktok-ads-test-client-id");
    const requests = mockTokenEndpoint(
      "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
      {
        code: 0,
        message: "OK",
        data: {
          access_token: "tiktok-ads-access-token",
          advertiser_ids: ["7000000001"],
        },
      },
    );
    signIn();

    const started = await connectThroughApp("tiktok-ads", {
      auth_code: "tiktok-ads-authorization-code",
    });

    expectAppAuthorization(started, {
      authorizeUrl: "https://business-api.tiktok.com/portal/auth",
      clientId: "tiktok-ads-test-client-id",
      connectorSlug: "tiktok-ads",
      clientIdParam: "app_id",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]?.body ?? [])).toStrictEqual({
      app_id: "tiktok-ads-test-client-id",
      secret: "tiktok-ads-test-client-id-secret",
      auth_code: "tiktok-ads-authorization-code",
    });
  });

  it("connectors-oauth-start-023 uses the direct Okou App callback for Asana and reuses its exact redirect URI", async () => {
    configureClient("ASANA", "asana-test-client-id");
    const requests = mockTokenEndpoint(
      "https://app.asana.com/-/oauth_token",
      tokens,
    );
    mockJson("get", "https://app.asana.com/api/1.0/users/me", {
      data: {
        gid: "asana-user-1",
        name: "Asana User",
        email: "asana-user@example.test",
      },
    });
    signIn();

    const started = await connectThroughApp("asana");

    expectAppAuthorization(started, {
      authorizeUrl: "https://app.asana.com/-/oauth_authorize",
      clientId: "asana-test-client-id",
      connectorSlug: "asana",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "asana");
  });

  it("connectors-oauth-start-024 uses the direct Okou App callback for Gumroad and reuses its exact redirect URI", async () => {
    configureClient("GUMROAD", "gumroad-test-client-id");
    const requests = mockTokenEndpoint(
      "https://gumroad.com/oauth/token",
      tokens,
    );
    mockJson("get", "https://api.gumroad.com/v2/user", {
      success: true,
      user: {
        id: "gumroad-user-1",
        name: "Gumroad User",
        email: "gumroad-user@example.test",
      },
    });
    signIn();

    const started = await connectThroughApp("gumroad");

    expectAppAuthorization(started, {
      authorizeUrl: "https://gumroad.com/oauth/authorize",
      clientId: "gumroad-test-client-id",
      connectorSlug: "gumroad",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "gumroad");
  });

  it("connectors-oauth-start-025 uses the direct Okou App callback for Linear and reuses its exact redirect URI", async () => {
    configureClient("LINEAR", "linear-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.linear.app/oauth/token",
      tokens,
    );
    mockJson("post", "https://api.linear.app/graphql", {
      data: {
        viewer: {
          id: "linear-user-1",
          name: "Linear User",
          email: "linear-user@example.test",
        },
      },
    });
    signIn();

    const started = await connectThroughApp("linear");

    expectAppAuthorization(started, {
      authorizeUrl: "https://linear.app/oauth/authorize",
      clientId: "linear-test-client-id",
      connectorSlug: "linear",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "linear");
  });

  it("connectors-oauth-start-026 uses the direct Okou App callback for Monday.com and reuses its exact redirect URI", async () => {
    configureClient("MONDAY", "monday-test-client-id");
    const requests = mockTokenEndpoint(
      "https://auth.monday.com/oauth2/token",
      tokens,
    );
    mockJson("post", "https://api.monday.com/v2", {
      data: {
        me: {
          id: "1234",
          name: "Monday User",
          email: "monday-user@example.test",
        },
      },
    });
    signIn();

    const started = await connectThroughApp("monday");

    expectAppAuthorization(started, {
      authorizeUrl: "https://auth.monday.com/oauth2/authorize",
      clientId: "monday-test-client-id",
      connectorSlug: "monday",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "monday");
  });

  it("connectors-oauth-start-027 uses the direct Okou App callback for QuickBooks and reuses its exact redirect URI", async () => {
    configureClient("QUICKBOOKS", "quickbooks-test-client-id");
    const requests = mockTokenEndpoint(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      tokens,
    );
    mockJson(
      "get",
      "https://accounts.platform.intuit.com/v1/openid_connect/userinfo",
      { sub: "quickbooks-user-1", email: "quickbooks-user@example.test" },
    );
    signIn();

    const started = await connectThroughApp("quickbooks", {
      code: "quickbooks-authorization-code",
      realmId: "quickbooks-realm-123",
    });

    expectAppAuthorization(started, {
      authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
      clientId: "quickbooks-test-client-id",
      connectorSlug: "quickbooks",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "quickbooks");
  });

  it("connectors-oauth-start-028 uses the direct Okou App callback for Sentry and reuses its exact redirect URI", async () => {
    configureClient("SENTRY", "sentry-test-client-id");
    const requests = mockTokenEndpoint("https://sentry.io/oauth/token/", {
      ...tokens,
      user: {
        id: "sentry-user-1",
        name: "Sentry User",
        email: "sentry-user@example.test",
      },
    });
    signIn();

    const started = await connectThroughApp("sentry");

    expectAppAuthorization(started, {
      authorizeUrl: "https://sentry.io/oauth/authorize/",
      clientId: "sentry-test-client-id",
      connectorSlug: "sentry",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "sentry");
  });

  it("connectors-oauth-start-029 uses the direct Okou App callback for Todoist and reuses its exact redirect URI", async () => {
    configureClient("TODOIST", "todoist-test-client-id");
    const requests = mockTokenEndpoint(
      "https://todoist.com/oauth/access_token",
      {
        access_token: "todoist-access-token",
        token_type: "Bearer",
      },
    );
    mockJson("get", "https://api.todoist.com/api/v1/user", {
      id: "todoist-user-1",
      full_name: "Todoist User",
      email: "todoist-user@example.test",
    });
    signIn();

    const started = await connectThroughApp("todoist");

    expectAppAuthorization(started, {
      authorizeUrl: "https://todoist.com/oauth/authorize",
      clientId: "todoist-test-client-id",
      connectorSlug: "todoist",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "todoist");
  });

  it("connectors-oauth-start-030 uses the direct Okou App callback for Xero and reuses its exact redirect URI", async () => {
    configureClient("XERO", "xero-test-client-id");
    const requests = mockTokenEndpoint(
      "https://identity.xero.com/connect/token",
      tokens,
    );
    mockJson("get", "https://identity.xero.com/connect/userinfo", {
      sub: "xero-user-1",
      name: "Xero User",
      email: "xero-user@example.test",
    });
    signIn();

    const started = await connectThroughApp("xero");

    expectAppAuthorization(started, {
      authorizeUrl: "https://login.xero.com/identity/connect/authorize",
      clientId: "xero-test-client-id",
      connectorSlug: "xero",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "xero");
  });

  it("connectors-oauth-start-031 uses the direct Okou App callback for Stripe Marketplace OAuth", async () => {
    configureClient("STRIPE", "stripe-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.stripe.com/v1/oauth/token",
      {
        access_token: "stripe-access-token",
        refresh_token: "stripe-refresh-token",
        livemode: false,
        stripe_user_id: "acct_stripe_test",
      },
    );
    mockJson("get", "https://api.stripe.com/v1/account", {
      id: "acct_stripe_test",
      email: "stripe-account@example.test",
      business_profile: { name: "Stripe Test Account" },
    });
    signIn();

    const started = await connectThroughApp("stripe");

    expectAppAuthorization(started, {
      authorizeUrl: "https://marketplace.stripe.com/oauth/v2/authorize",
      clientId: "stripe-test-client-id",
      connectorSlug: "stripe",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]?.body ?? [])).toStrictEqual({
      code: "stripe-authorization-code",
      grant_type: "authorization_code",
    });
  });

  it("connectors-oauth-start-032 uses the direct Okou App callback for X and reuses its exact PKCE redirect URI", async () => {
    configureClient("X", "x-test-client-id");
    const requests = mockTokenEndpoint("https://api.x.com/2/oauth2/token", {
      ...tokens,
      scope: "tweet.read tweet.write users.read offline.access",
    });
    mockJson("get", "https://api.x.com/2/users/me", {
      data: { id: "x-user-1", username: "x-test-user", name: "X User" },
    });
    signIn();

    const started = await connectThroughApp("x");

    expectAppAuthorization(started, {
      authorizeUrl: "https://x.com/i/oauth2/authorize",
      clientId: "x-test-client-id",
      connectorSlug: "x",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "x");
    expectPkce(started.url, requests);
  });

  it("connectors-oauth-start-033 uses the direct Okou App callback for Intervals.icu without adding a token redirect URI", async () => {
    configureClient("INTERVALS_ICU", "intervals-icu-test-client-id");
    const requests = mockTokenEndpoint(
      "https://intervals.icu/api/oauth/token",
      {
        access_token: "intervals-icu-access-token",
        athlete: { id: "i12345", name: "Intervals Athlete" },
      },
    );
    signIn();

    const started = await connectThroughApp("intervals-icu");

    expectAppAuthorization(started, {
      authorizeUrl: "https://intervals.icu/oauth/authorize",
      clientId: "intervals-icu-test-client-id",
      connectorSlug: "intervals-icu",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.get("code")).toBe(
      "intervals-icu-authorization-code",
    );
    expect(requests[0]?.body.has("redirect_uri")).toBeFalsy();
  });

  it("connectors-oauth-start-034 uses the direct Okou App callback for Strava without adding a token redirect URI", async () => {
    configureClient("STRAVA", "strava-test-client-id");
    const requests = mockTokenEndpoint("https://www.strava.com/oauth/token", {
      ...tokens,
      scope: "read,activity:read_all,profile:read_all",
      athlete: { id: 5150, firstname: "Strava", lastname: "Athlete" },
    });
    mockJson("get", "https://www.strava.com/api/v3/athlete", {
      id: 5150,
      firstname: "Strava",
      lastname: "Athlete",
    });
    signIn();

    const started = await connectThroughApp("strava");

    expectAppAuthorization(started, {
      authorizeUrl: "https://www.strava.com/oauth/authorize",
      clientId: "strava-test-client-id",
      connectorSlug: "strava",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.get("code")).toBe("strava-authorization-code");
    expect(requests[0]?.body.has("redirect_uri")).toBeFalsy();
  });

  it("connectors-oauth-start-035 propagates the direct Okou App callback through the Vercel token exchange", async () => {
    configureClient("VERCEL", "vercel-test-client-id");
    const requests = mockVercel();
    signIn();

    const started = await connectThroughApp("vercel");

    expect(`${started.url.origin}${started.url.pathname}`).toBe(
      "https://vercel.com/integrations/okou-test-integration/new",
    );
    expect(started.url.searchParams.has("redirect_uri")).toBeFalsy();
    expect(started.state).toMatch(STATE);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "vercel");
  });

  it("connectors-oauth-start-036 propagates the existing Web callback through the Vercel token exchange", async () => {
    configureClient("VERCEL", "vercel-test-client-id");
    const requests = mockVercel();
    signIn();

    const started = await start("vercel", {});
    const location = await callback("vercel", {
      code: "vercel-authorization-code",
      state: started.state,
    });

    expect(`${started.url.origin}${started.url.pathname}`).toBe(
      "https://vercel.com/integrations/okou-test-integration/new",
    );
    expect(started.url.searchParams.has("redirect_uri")).toBeFalsy();
    expect(started.state).toMatch(STATE);
    expect(redirectTarget(location), location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.get("redirect_uri")).toBe(
      "https://www.okou.ai/api/connectors/vercel/callback",
    );
  });

  it("connectors-oauth-start-050 uses the direct Okou App callback for Notion and reuses its exact redirect URI", async () => {
    configureClient("NOTION", "notion-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.notion.com/v1/oauth/token",
      {
        access_token: "notion-access-token",
        refresh_token: "notion-refresh-token",
        bot_id: "notion-bot-1",
        owner: {
          user: {
            id: "notion-user-1",
            name: "Notion User",
            person: { email: "notion-user@example.test" },
          },
        },
      },
    );
    signIn();

    const started = await connectThroughApp("notion");

    expectAppAuthorization(started, {
      authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
      clientId: "notion-test-client-id",
      connectorSlug: "notion",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.json).toBeTruthy();
    expect(Object.fromEntries(requests[0]?.body ?? [])).toStrictEqual({
      grant_type: "authorization_code",
      code: "notion-authorization-code",
      redirect_uri: appCallback("notion"),
    });
  });
});

function mockVercel(): ProviderRequest[] {
  const requests = mockTokenEndpoint(
    "https://api.vercel.com/v2/oauth/access_token",
    {
      access_token: "vercel-access-token",
      token_type: "Bearer",
      team_id: null,
      installation_id: "icfg_vercel",
    },
  );
  mockJson("get", "https://api.vercel.com/v2/user", {
    user: {
      id: "vercel-user-1",
      username: "vercel-user",
      email: "vercel-user@example.test",
    },
  });
  return requests;
}

describe("POST /api/connectors/:connectorSlug/oauth/start for launch-gated connectors", () => {
  it("connectors-oauth-start-052 uses the direct Okou App callback for Cal.com and reuses its exact redirect URI", async () => {
    configureClient("CAL_COM", "cal-com-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.cal.com/v2/auth/oauth2/token",
      tokens,
    );
    mockJson("get", "https://api.cal.com/v2/me", {
      status: "success",
      data: {
        id: 77,
        username: "cal-user",
        email: "cal-user@example.test",
        name: "Cal User",
      },
    });
    signIn();

    const started = await connectThroughApp("cal-com");

    expectAppAuthorization(started, {
      authorizeUrl: "https://app.cal.com/auth/oauth2/authorize",
      clientId: "cal-com-test-client-id",
      connectorSlug: "cal-com",
    });
    expectNoPkce(started.url);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "cal-com");
    expect(requests[0]?.body.has("code_verifier")).toBeFalsy();
  });

  it("connectors-oauth-start-053 uses the direct Okou App callback for Calendly and reuses its exact redirect URI", async () => {
    configureClient("CALENDLY", "calendly-test-client-id");
    const requests = mockTokenEndpoint(
      "https://auth.calendly.com/oauth/token",
      tokens,
    );
    mockJson("get", "https://api.calendly.com/users/me", {
      resource: {
        uri: "https://api.calendly.com/users/calendly-user-1",
        name: "Calendly User",
        email: "calendly-user@example.test",
      },
    });
    signIn();

    const started = await connectThroughApp("calendly");

    expectAppAuthorization(started, {
      authorizeUrl: "https://auth.calendly.com/oauth/authorize",
      clientId: "calendly-test-client-id",
      connectorSlug: "calendly",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "calendly");
    expectPkceVerifier(started.url, requests);
  });

  it("connectors-oauth-start-054 uses the direct Okou App callback for Close and reuses its exact redirect URI", async () => {
    configureClient("CLOSE", "close-test-client-id");
    const requests = mockTokenEndpoint("https://api.close.com/oauth2/token/", {
      ...tokens,
      user_id: "user_close_1",
      organization_id: "orga_close_1",
    });
    mockJson("get", "https://api.close.com/api/v1/me/", {
      id: "user_close_1",
      email: "close-user@example.test",
    });
    signIn();

    const started = await connectThroughApp("close");

    expectAppAuthorization(started, {
      authorizeUrl: "https://app.close.com/oauth2/authorize/",
      clientId: "close-test-client-id",
      connectorSlug: "close",
    });
    expectNoPkce(started.url);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "close");
    expect(requests[0]?.body.has("code_verifier")).toBeFalsy();
  });

  it("connectors-oauth-start-055 uses the direct Okou App callback for Copper and reuses its exact redirect URI", async () => {
    configureClient("COPPER", "copper-test-client-id");
    const requests = mockTokenEndpoint(
      "https://app.copper.com/oauth/token",
      tokens,
    );
    mockJson("get", "https://api.copper.com/developer_api/v1/account", {
      id: 8080,
      name: "Copper Account",
    });
    signIn();

    const started = await connectThroughApp("copper");

    expectAppAuthorization(started, {
      authorizeUrl: "https://app.copper.com/oauth/authorize",
      clientId: "copper-test-client-id",
      connectorSlug: "copper",
    });
    expectNoPkce(started.url);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "copper");
    expect(requests[0]?.body.has("code_verifier")).toBeFalsy();
  });

  it("connectors-oauth-start-056 uses the direct Okou App callback for Datadog and reuses its exact redirect URI", async () => {
    configureClient("DATADOG", "datadog-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.datadoghq.com/oauth2/v1/token",
      { ...tokens, scope: "dashboards_read" },
    );
    signIn();

    const started = await connectThroughApp("datadog", {
      code: "datadog-authorization-code",
      domain: "datadoghq.com",
    });

    expectAppAuthorization(started, {
      authorizeUrl: "https://app.datadoghq.com/oauth2/v1/authorize",
      clientId: "datadog-test-client-id",
      connectorSlug: "datadog",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "datadog");
    expectPkceVerifier(started.url, requests);
  });

  it("connectors-oauth-start-057 uses the direct Okou App callback for DocuSign and reuses its exact redirect URI", async () => {
    configureClient("DOCUSIGN", "docusign-test-client-id");
    const requests = mockTokenEndpoint(
      "https://account-d.docusign.com/oauth/token",
      tokens,
    );
    mockJson("get", "https://account-d.docusign.com/oauth/userinfo", {
      sub: "docusign-user-1",
      name: "DocuSign User",
      email: "docusign-user@example.test",
    });
    await signInWithSwitch(FeatureSwitchKey.DocuSignConnector);

    const started = await connectThroughApp("docusign");

    expectAppAuthorization(started, {
      authorizeUrl: "https://account-d.docusign.com/oauth/auth",
      clientId: "docusign-test-client-id",
      connectorSlug: "docusign",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "docusign");
    expectPkceVerifier(started.url, requests);
  });

  it("connectors-oauth-start-058 uses the direct Okou App callback for Dropbox and reuses its exact redirect URI", async () => {
    configureClient("DROPBOX", "dropbox-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.dropboxapi.com/oauth2/token",
      { ...tokens, account_id: "dbid:dropbox-user-1" },
    );
    mockJson("post", "https://api.dropboxapi.com/2/users/get_current_account", {
      account_id: "dbid:dropbox-user-1",
      email: "dropbox-user@example.test",
      name: { display_name: "Dropbox User" },
    });
    signIn();

    const started = await connectThroughApp("dropbox");

    expectAppAuthorization(started, {
      authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
      clientId: "dropbox-test-client-id",
      connectorSlug: "dropbox",
    });
    expectNoPkce(started.url);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "dropbox");
    expect(requests[0]?.body.has("code_verifier")).toBeFalsy();
  });

  it("connectors-oauth-start-059 uses the direct Okou App callback for Figma and reuses its exact redirect URI", async () => {
    configureClient("FIGMA", "figma-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.figma.com/v1/oauth/token",
      tokens,
    );
    mockJson("get", "https://api.figma.com/v1/me", {
      id: "figma-user-1",
      handle: "Figma User",
      email: "figma-user@example.test",
    });
    signIn();

    const started = await connectThroughApp("figma");

    expectAppAuthorization(started, {
      authorizeUrl: "https://www.figma.com/oauth",
      clientId: "figma-test-client-id",
      connectorSlug: "figma",
    });
    expectNoPkce(started.url);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "figma");
    expect(requests[0]?.body.has("code_verifier")).toBeFalsy();
  });

  it("connectors-oauth-start-060 uses the direct Okou App callback for Mailchimp and reuses its exact redirect URI", async () => {
    configureClient("MAILCHIMP", "mailchimp-test-client-id");
    const requests = mockTokenEndpoint(
      "https://login.mailchimp.com/oauth2/token",
      { access_token: "mailchimp-access-token", scope: null },
    );
    mockJson("get", "https://login.mailchimp.com/oauth2/metadata", {
      dc: "us1",
      api_endpoint: "https://us1.api.mailchimp.com",
      accountname: "Mailchimp Account",
      user_id: 4040,
      login: {
        login_id: 4040,
        login_name: "mailchimp-user",
        login_email: "mailchimp-user@example.test",
      },
    });
    signIn();

    const started = await connectThroughApp("mailchimp");

    expectAppAuthorization(started, {
      authorizeUrl: "https://login.mailchimp.com/oauth2/authorize",
      clientId: "mailchimp-test-client-id",
      connectorSlug: "mailchimp",
    });
    expectNoPkce(started.url);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "mailchimp");
    expect(requests[0]?.body.has("code_verifier")).toBeFalsy();
  });

  it("connectors-oauth-start-061 uses the direct Okou App callback for Mercury and reuses its exact redirect URI", async () => {
    configureClient("MERCURY", "mercury-test-client-id");
    const requests = mockTokenEndpoint(
      "https://oauth2.mercury.com/oauth2/token",
      tokens,
    );
    mockJson("get", "https://api.mercury.com/api/v1/organization", {
      organization: { id: "mercury-org-1", legalBusinessName: "Mercury Org" },
    });
    signIn();

    const started = await connectThroughApp("mercury");

    expectAppAuthorization(started, {
      authorizeUrl: "https://oauth2.mercury.com/oauth2/auth",
      clientId: "mercury-test-client-id",
      connectorSlug: "mercury",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "mercury");
    expectPkceVerifier(started.url, requests);
  });

  it("connectors-oauth-start-062 uses the direct Okou App callback for PostHog and reuses its exact redirect URI", async () => {
    okouHosts();
    const requests = mockTokenEndpoint(
      "https://oauth.posthog.com/oauth/token/",
      {
        ...tokens,
        posthog_region: "us",
        posthog_base_url: "https://us.posthog.com",
      },
    );
    mockJson("get", "https://us.posthog.com/api/users/@me/", {
      id: 9090,
      email: "posthog-user@example.test",
      first_name: "PostHog",
      last_name: "User",
    });
    signIn();

    const started = await connectThroughApp("posthog");

    expectAppAuthorization(started, {
      authorizeUrl: "https://oauth.posthog.com/oauth/authorize/",
      clientId: "https://app.okou.ai/connectors/posthog/metadata.json",
      connectorSlug: "posthog",
    });
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "posthog");
    expectPkceVerifier(started.url, requests);
    expect(requests[0]?.authorization).toBeNull();
    expect(requests[0]?.body.get("client_id")).toBe(
      "https://app.okou.ai/connectors/posthog/metadata.json",
    );
    expect(requests[0]?.body.has("client_secret")).toBeFalsy();
  });

  it("connectors-oauth-start-063 uses the direct Okou App callback for Spotify and reuses its exact redirect URI", async () => {
    configureClient("SPOTIFY", "spotify-test-client-id");
    const requests = mockTokenEndpoint(
      "https://accounts.spotify.com/api/token",
      tokens,
    );
    mockJson("get", "https://api.spotify.com/v1/me", {
      id: "spotify-user-1",
      display_name: "Spotify User",
      email: "spotify-user@example.test",
    });
    await signInWithSwitch(FeatureSwitchKey.SpotifyConnector);

    const started = await connectThroughApp("spotify");

    expectAppAuthorization(started, {
      authorizeUrl: "https://accounts.spotify.com/authorize",
      clientId: "spotify-test-client-id",
      connectorSlug: "spotify",
    });
    expectNoPkce(started.url);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "spotify");
    expect(requests[0]?.body.has("code_verifier")).toBeFalsy();
  });

  it("connectors-oauth-start-064 uses the direct Okou App callback for Webflow and reuses its exact redirect URI", async () => {
    configureClient("WEBFLOW", "webflow-test-client-id");
    const requests = mockTokenEndpoint(
      "https://api.webflow.com/oauth/access_token",
      { access_token: "webflow-access-token", token_type: "bearer" },
    );
    mockJson("get", "https://api.webflow.com/v2/token/authorized_by", {
      id: "webflow-user-1",
      email: "webflow-user@example.test",
      firstName: "Webflow",
      lastName: "User",
    });
    signIn();

    const started = await connectThroughApp("webflow");

    expectAppAuthorization(started, {
      authorizeUrl: "https://webflow.com/oauth/authorize",
      clientId: "webflow-test-client-id",
      connectorSlug: "webflow",
    });
    expectNoPkce(started.url);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "webflow");
    expect(requests[0]?.body.has("code_verifier")).toBeFalsy();
  });

  it("connectors-oauth-start-065 uses the direct Okou App callback for Zoom and reuses its exact redirect URI", async () => {
    configureClient("ZOOM", "zoom-test-client-id");
    const requests = mockTokenEndpoint("https://zoom.us/oauth/token", tokens);
    mockJson("get", "https://api.zoom.us/v2/users/me", {
      id: "zoom-user-1",
      display_name: "Zoom User",
      email: "zoom-user@example.test",
    });
    await signInWithSwitch(FeatureSwitchKey.ZoomConnector);

    const started = await connectThroughApp("zoom");

    expectAppAuthorization(started, {
      authorizeUrl: "https://zoom.us/oauth/authorize",
      clientId: "zoom-test-client-id",
      connectorSlug: "zoom",
    });
    expectNoPkce(started.url);
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "zoom");
    expect(requests[0]?.body.has("code_verifier")).toBeFalsy();
  });

  it("connectors-oauth-start-081 uses the direct Okou App callback for Cloudflare and reuses its exact redirect URI", async () => {
    configureClient("CLOUDFLARE", "cloudflare-test-client-id");
    const requests = mockTokenEndpoint(
      "https://dash.cloudflare.com/oauth2/token",
      { ...tokens, scope: "dns-firewall.read offline_access" },
    );
    mockJson("get", "https://dash.cloudflare.com/oauth2/userinfo", {
      sub: "cloudflare-user-1",
      email: "cloudflare-user@example.test",
      name: "Cloudflare User",
    });
    signIn();

    const started = await connectThroughApp("cloudflare");

    expectAppAuthorization(started, {
      authorizeUrl: "https://dash.cloudflare.com/oauth2/auth",
      clientId: "cloudflare-test-client-id",
      connectorSlug: "cloudflare",
    });
    expect(started.url.searchParams.get("scope")).toBe(
      "dns-firewall.read offline_access",
    );
    expect(redirectTarget(started.location), started.location.href).toBe(
      "https://app.okou.ai/connector/success",
    );
    expectSingleTokenRedirect(requests, "cloudflare");
  });
});

describe("POST /api/connectors/:connectorSlug/oauth/start callback targets and errors", () => {
  it("connectors-oauth-start-082 keeps an omitted Cloudflare callback target on the existing API callback", async () => {
    configureClient("CLOUDFLARE", "cloudflare-test-client-id");
    signIn();

    const started = await start("cloudflare", {});

    expect(started.url.searchParams.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/connectors/cloudflare/callback",
    );
    expect(started.url.searchParams.get("scope")).toBe(
      "dns-firewall.read offline_access",
    );
    expect(started.state).toMatch(STATE);
  });

  it("connectors-oauth-start-083 uses the direct Okou App callback for Slack", async () => {
    configureClient("SLACK", "slack-test-client-id");
    signIn();

    const started = await start("slack");

    expect(started.url.searchParams.get("redirect_uri")).toBe(
      appCallback("slack"),
    );
    expect(started.state).toMatch(STATE);
  });

  it("connectors-oauth-start-088 returns 400 when starting OAuth for a connector without an auth-code grant", async () => {
    signIn();

    const response = await requestStart("serpapi", {}, [400]);

    expect(response.body).toStrictEqual({
      error: {
        message: "serpapi connector does not use an auth-code grant",
        code: "BAD_REQUEST",
      },
    });
  });

  it("connectors-oauth-start-091 returns 403 when the auth method lacks executable platform configuration", async () => {
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
    signIn();

    const response = await requestStart("github", {}, [403]);

    expect(response.body).toStrictEqual({
      error: {
        message: "github connector is not available",
        code: "FORBIDDEN",
      },
    });
  });
});
