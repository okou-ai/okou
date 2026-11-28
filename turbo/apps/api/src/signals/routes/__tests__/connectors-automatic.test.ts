import { randomUUID } from "node:crypto";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { connectorAccountRoutes } from "../connector-accounts";
import { mockAutomaticMcpOAuthProvider } from "./helpers/api-bdd-connectors";
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";
import { countPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const CALLBACK = "https://api.okou.ai/api/connectors/automatic/callback";
const automatic = setupApp({
  context,
  routes: builtinConnectorsAutomaticRoutes,
  baseUrl: "https://api.okou.ai",
})(builtinConnectorAutomaticContract);
const accounts = setupApp({ context, routes: connectorAccountRoutes })(
  connectorAccountsContract,
);

type Fixture = ReturnType<typeof automaticMcpCatalogFixture>;
type Account =
  | { readonly intent: "add" }
  | { readonly intent: "reconnect"; readonly connectionId: string };

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function member(orgId = `org_${randomUUID()}`): Member {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  return { userId: `user_${randomUUID()}`, orgId };
}

function act(actor: Member): void {
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
}

const add = Object.freeze({ intent: "add" as const });

function reconnect(connectionId: string): Account {
  return { intent: "reconnect", connectionId };
}

async function requestStart(
  actor: Member,
  fixture: Fixture,
  account: Account,
  statuses: readonly (200 | 409 | 503)[],
  nativeCallback?: "ios-https",
) {
  act(actor);
  return await accept(
    automatic.start({
      headers,
      params: { connectorSlug: fixture.slug },
      body: {
        authMethod: "smart-connect",
        account,
        ...(nativeCallback ? { nativeCallback } : {}),
      },
    }),
    statuses,
  );
}

async function authorize(
  actor: Member,
  fixture: Fixture,
  account: Account = add,
  nativeCallback?: "ios-https",
) {
  const started = await requestStart(
    actor,
    fixture,
    account,
    [200],
    nativeCallback,
  );
  if (!("result" in started.body) || started.body.result !== "authorization") {
    throw new Error("Expected an authorization handoff");
  }
  const url = new URL(started.body.authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected an authorization state");
  }
  return { ...started.body, url, state };
}

async function connectNow(actor: Member, fixture: Fixture, account = add) {
  const started = await requestStart(actor, fixture, account, [200]);
  if (!("result" in started.body) || started.body.result !== "connected") {
    throw new Error("Expected an immediate connection");
  }
  return started.body;
}

async function callback(query: {
  readonly state: string;
  readonly code?: string;
  readonly iss?: string;
  readonly error?: string;
}) {
  const response = await accept(
    automatic.callback({ query: { ...query, responseMode: "json" } }),
    [200],
  );
  return response.body;
}

async function receipt(actor: Member, fixture: Fixture, attemptId: string) {
  act(actor);
  return await accept(
    accounts.oauthCompletion({
      headers,
      params: { attemptId },
      query: { kind: "builtin", connectorSlug: fixture.slug },
    }),
    [200, 404],
  );
}

async function readAccount(
  actor: Member,
  fixture: Fixture,
  connectionId: string,
) {
  act(actor);
  const response = await accept(
    accounts.connection({
      headers,
      params: { connectionId },
      query: { kind: "builtin", connectorSlug: fixture.slug },
    }),
    [200],
  );
  return response.body;
}

async function listAccounts(actor: Member, fixture: Fixture) {
  act(actor);
  const response = await accept(
    accounts.connections({
      headers,
      query: { kind: "builtin", connectorSlug: fixture.slug, limit: 100 },
    }),
    [200],
  );
  return response.body.connections;
}

async function completedConnection(
  actor: Member,
  fixture: Fixture,
  attemptId: string,
): Promise<string> {
  const completed = await receipt(actor, fixture, attemptId);
  if (completed.status !== 200) {
    throw new Error("Expected a completed OAuth receipt");
  }
  return completed.body.connectionId;
}

function receiptConnection(
  completion: Awaited<ReturnType<typeof receipt>>,
): string {
  if (completion.status !== 200) {
    throw new Error("Expected a completed OAuth receipt");
  }
  return completion.body.connectionId;
}

const POLICY_SCOPES = Object.freeze([
  "openid",
  "read",
  "write",
  "offline_access",
]);

type PolicyVariant = "declared-scopes" | "provider-prompt" | "explicit-prompt";

/** Connects through the policy connector, then reconnects that account. */
async function connectAndReconnect(
  variant: PolicyVariant,
  registration: "cimd" | "dcr",
) {
  const fixture = automaticMcpCatalogFixture(variant);
  const provider = mockAutomaticMcpOAuthProvider(context, {
    registration,
    endpoint: fixture.endpoint,
    challengeScope: null,
    metadataScopes: ["openid"],
    authorizationServerScopes: [
      "openid",
      "read",
      "write",
      "admin",
      "offline_access",
    ],
    authorizationCodeScopes: [
      "openid read write offline_access",
      "openid read write offline_access",
    ],
  });
  const actor = member();
  const first = await authorize(actor, fixture);
  const firstCallback = await callback({
    state: first.state,
    iss: provider.issuer,
    code: "first-code",
  });
  const original = await receipt(actor, fixture, first.oauthAttemptId);
  if (original.status !== 200) {
    throw new Error("Expected the first OAuth receipt");
  }
  const second = await authorize(
    actor,
    fixture,
    reconnect(original.body.connectionId),
  );
  const secondCallback = await callback({
    state: second.state,
    iss: provider.issuer,
    code: "second-code",
  });
  const reconnected = await receipt(actor, fixture, second.oauthAttemptId);
  const account = await readAccount(actor, fixture, original.body.connectionId);
  return {
    fixture,
    provider,
    urls: [first.url, second.url],
    callbacks: [firstCallback, secondCallback],
    original,
    reconnected,
    account,
  };
}

function expectPolicyAuthorization(
  flow: Awaited<ReturnType<typeof connectAndReconnect>>,
  prompt: string | null,
): void {
  for (const url of flow.urls) {
    expect(url.searchParams.get("scope")).toBe(
      "openid read write offline_access",
    );
    expect(url.searchParams.get("prompt")).toBe(prompt);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(url.searchParams.get("resource")).toBe(flow.fixture.endpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
    expect(url.searchParams.get("state")).toBeTruthy();
  }
  expect(
    flow.callbacks.map((result) => {
      return result.status;
    }),
  ).toStrictEqual(["success", "success"]);
}

type DcrRow = "public-only" | "basic" | "post" | "unspecified";

function dcrRowOptions(row: DcrRow) {
  switch (row) {
    case "public-only": {
      return {
        tokenEndpointAuthMethodsSupported: ["none"],
        dcrTokenEndpointAuthMethod: "none" as const,
      };
    }
    case "basic": {
      return {
        tokenEndpointAuthMethodsSupported: ["none", "client_secret_basic"],
        dcrTokenEndpointAuthMethod: "client_secret_basic" as const,
      };
    }
    case "post": {
      return {
        tokenEndpointAuthMethodsSupported: ["none", "client_secret_post"],
        dcrTokenEndpointAuthMethod: "client_secret_post" as const,
      };
    }
    case "unspecified": {
      return {
        tokenEndpointAuthMethodsSupported: null,
        dcrTokenEndpointAuthMethod: "client_secret_basic" as const,
        dcrDefaultTokenEndpointAuthMethod: "client_secret_basic" as const,
      };
    }
  }
}

/**
 * Sends one add attempt back with a foreign issuer, then connects a second
 * add attempt and reconnects that account with the same registered client.
 */
async function dcrIssuerBindingFlow(row: DcrRow) {
  const fixture = automaticMcpCatalogFixture("oauth");
  const provider = mockAutomaticMcpOAuthProvider(context, {
    registration: "dcr",
    endpoint: fixture.endpoint,
    dcrClientId: `dcr-${"x".repeat(1024)}-${randomUUID()}`,
    ...dcrRowOptions(row),
  });
  const actor = member();
  const foreignAttempt = await authorize(actor, fixture);
  const foreign = await callback({
    state: foreignAttempt.state,
    iss: "https://other.example.test",
    code: "foreign-code",
  });
  const foreignReceipt = await receipt(
    actor,
    fixture,
    foreignAttempt.oauthAttemptId,
  );
  const added = await authorize(actor, fixture);
  const connected = await callback({
    state: added.state,
    iss: provider.issuer,
    code: "added-code",
  });
  const original = await receipt(actor, fixture, added.oauthAttemptId);
  if (original.status !== 200) {
    throw new Error("Expected the added OAuth receipt");
  }
  const reconnectAttempt = await authorize(
    actor,
    fixture,
    reconnect(original.body.connectionId),
  );
  const reconnected = await callback({
    state: reconnectAttempt.state,
    iss: provider.issuer,
    code: "reconnect-code",
  });
  const reconnectReceipt = await receipt(
    actor,
    fixture,
    reconnectAttempt.oauthAttemptId,
  );
  return {
    provider,
    foreign,
    foreignReceipt,
    connected,
    original,
    reconnected,
    reconnectReceipt,
  };
}

function expectDcrIssuerBinding(
  flow: Awaited<ReturnType<typeof dcrIssuerBindingFlow>>,
): void {
  expect(flow.foreign.status).toBe("error");
  expect(flow.foreignReceipt.status).toBe(404);
  expect(flow.connected.status).toBe("success");
  expect(flow.reconnected.status).toBe("success");
  expect(flow.reconnectReceipt.body).toStrictEqual(flow.original.body);
  expect(flow.provider.registrationBodies).toHaveLength(1);
}

describe("builtin MCP automatic authentication", () => {
  it("connectors-automatic-018 keeps public access when optional metadata returns 403 Forbidden", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
      endpoint: fixture.endpoint,
      resourceMetadataStatus: 403,
    });
    const actor = member();

    const connected = await connectNow(actor, fixture);
    const account = await readAccount(actor, fixture, connected.connectionId);

    expect(connected.result).toBe("connected");
    expect(account.connectionStatus).toBe("connected");
    expect(account.oauthScopes).toBeNull();
  });

  it("connectors-automatic-001 returns a native Automatic OAuth attempt after consent or refusal (denied=false)", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
    });
    const actor = member();

    const started = await authorize(actor, fixture, add, "ios-https");
    const query = {
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    };
    const completed = await callback(query);
    const completion = await receipt(actor, fixture, started.oauthAttemptId);
    const replay = await callback(query);

    expect(started.nativeCallbackUrl).toBe(
      `https://app.okou.ai/native/connector-authorization?attemptId=${started.oauthAttemptId}`,
    );
    expect(completed).toMatchObject({
      status: "success",
      nativeAppReturn: {
        platform: "ios",
        attemptId: started.oauthAttemptId,
        httpsHost: "app.okou.ai",
      },
    });
    expect(completion.status).toBe(200);
    expect(replay.nativeAppReturn).toBeUndefined();
  });

  it("connectors-automatic-002 returns a native Automatic OAuth attempt after consent or refusal (denied=true)", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
    });
    const actor = member();

    const started = await authorize(actor, fixture, add, "ios-https");
    const refused = await callback({
      state: started.state,
      iss: provider.issuer,
      error: "access_denied",
    });
    const completion = await receipt(actor, fixture, started.oauthAttemptId);
    const later = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "late-code",
    });

    expect(started.nativeCallbackUrl).toBe(
      `https://app.okou.ai/native/connector-authorization?attemptId=${started.oauthAttemptId}`,
    );
    expect(refused).toMatchObject({
      status: "error",
      nativeAppReturn: {
        platform: "ios",
        attemptId: started.oauthAttemptId,
        httpsHost: "app.okou.ai",
      },
    });
    expect(completion.status).toBe(404);
    expect(later.nativeAppReturn).toBeUndefined();
  });

  it("connectors-automatic-003 preserves a builtin endpoint query through cimd OAuth and account creation", async () => {
    const fixture = automaticMcpCatalogFixture("query");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
    });
    const actor = member();

    const started = await authorize(actor, fixture);
    const completed = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    });
    const completion = await receipt(actor, fixture, started.oauthAttemptId);
    const account = await readAccount(
      actor,
      fixture,
      receiptConnection(completion),
    );

    expect(new URL(fixture.endpoint).search).not.toBe("");
    expect(started.url.searchParams.get("resource")).toBe(fixture.endpoint);
    expect(started.url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(provider.endpointRequests.length).toBeGreaterThan(0);
    for (const request of provider.endpointRequests) {
      expect(request).toBe(fixture.endpoint);
    }
    expect(completed.status).toBe("success");
    expect(completion.status).toBe(200);
    expect(account).toMatchObject({
      connectionStatus: "connected",
      authMethod: "smart-connect",
    });
    expect(provider.tokenBodies[0]?.get("resource")).toBe(fixture.endpoint);
  });

  it("connectors-automatic-004 preserves a builtin endpoint query through dcr OAuth and account creation", async () => {
    const fixture = automaticMcpCatalogFixture("query");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      endpoint: fixture.endpoint,
    });
    const actor = member();

    const started = await authorize(actor, fixture);
    const completed = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    });
    const completion = await receipt(actor, fixture, started.oauthAttemptId);
    const account = await readAccount(
      actor,
      fixture,
      receiptConnection(completion),
    );

    expect(started.url.searchParams.get("resource")).toBe(fixture.endpoint);
    expect(started.url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(provider.endpointRequests.length).toBeGreaterThan(0);
    for (const request of provider.endpointRequests) {
      expect(request).toBe(fixture.endpoint);
    }
    expect(completed.status).toBe("success");
    expect(completion.status).toBe(200);
    expect(account).toMatchObject({
      connectionStatus: "connected",
      authMethod: "smart-connect",
    });
    expect(provider.tokenBodies[0]?.get("resource")).toBe(fixture.endpoint);
  });

  it("connectors-automatic-011 uses cimd OAuth for mixed public and protected tools", async () => {
    const fixture = automaticMcpCatalogFixture("declared-scopes");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      endpoint: fixture.endpoint,
      metadataScopes: ["openid"],
      authorizationServerScopes: ["openid", "read", "write", "offline_access"],
      authorizationCodeScopes: ["openid read write offline_access"],
    });
    const actor = member();

    const started = await authorize(actor, fixture);
    const completed = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    });
    const completion = await receipt(actor, fixture, started.oauthAttemptId);
    const account = await readAccount(
      actor,
      fixture,
      receiptConnection(completion),
    );

    expect(started.url.searchParams.get("scope")).toBe(
      "openid read write offline_access",
    );
    expect(started.url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(completed.status).toBe("success");
    expect(completion.status).toBe(200);
    expect(account.connectionStatus).toBe("connected");
    expect(account.oauthScopes).toStrictEqual([
      "openid",
      "read",
      "write",
      "offline_access",
    ]);
  });

  it("connectors-automatic-012 uses dcr OAuth for mixed public and protected tools", async () => {
    const fixture = automaticMcpCatalogFixture("declared-scopes");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      authentication: "mixed",
      endpoint: fixture.endpoint,
      metadataScopes: ["openid"],
      authorizationServerScopes: ["openid", "read", "write", "offline_access"],
      authorizationCodeScopes: ["openid read write offline_access"],
    });
    const actor = member();

    const started = await authorize(actor, fixture);
    const completed = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    });
    const completion = await receipt(actor, fixture, started.oauthAttemptId);
    const account = await readAccount(
      actor,
      fixture,
      receiptConnection(completion),
    );

    expect(started.url.searchParams.get("scope")).toBe(
      "openid read write offline_access",
    );
    expect(started.url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(completed.status).toBe("success");
    expect(completion.status).toBe(200);
    expect(account.connectionStatus).toBe("connected");
    expect(account.oauthScopes).toStrictEqual([
      "openid",
      "read",
      "write",
      "offline_access",
    ]);
  });

  it("connectors-automatic-013 connects and reconnects accepted no-auth with its exact catalog method", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
      endpoint: fixture.endpoint,
    });
    const actor = member();

    const added = await requestStart(actor, fixture, add, [200]);
    if (!("connectionId" in added.body)) {
      throw new Error("Expected a connection");
    }
    const connectionId = added.body.connectionId ?? "";
    const account = await readAccount(actor, fixture, connectionId);
    const reconnected = await requestStart(
      actor,
      fixture,
      reconnect(connectionId),
      [200],
    );

    expect(added.body).toStrictEqual({ result: "connected", connectionId });
    expect(account).toMatchObject({
      authMethod: "smart-connect",
      connectionStatus: "connected",
      tokenExpiresAt: null,
      reconnectReason: null,
    });
    expect(reconnected.body).toStrictEqual(added.body);
  });

  it("connectors-automatic-017 requires OAuth metadata for declared scopes even when initialization is public", async () => {
    const fixture = automaticMcpCatalogFixture("declared-scopes");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      endpoint: fixture.endpoint,
      resourceMetadataStatus: 404,
    });
    const actor = member();

    const started = await requestStart(actor, fixture, add, [409]);

    expect(started.status).toBe(409);
    await expect(listAccounts(actor, fixture)).resolves.toStrictEqual([]);
  });

  it("connectors-automatic-024 rejects required OAuth discovery failure after public initialization", async () => {
    const fixture = automaticMcpCatalogFixture("declared-scopes");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      endpoint: fixture.endpoint,
      resourceMetadataStatus: 503,
    });
    const actor = member();

    const started = await requestStart(actor, fixture, add, [503]);

    expect(started.status).toBe(503);
    await expect(listAccounts(actor, fixture)).resolves.toStrictEqual([]);
  });

  it("connectors-automatic-025 rejects foreign resource metadata after public initialization", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      endpoint: fixture.endpoint,
      resource: "https://foreign-mcp.example.test/",
    });
    const actor = member();

    const started = await requestStart(actor, fixture, add, [409]);

    expect(started.status).toBe(409);
    await expect(listAccounts(actor, fixture)).resolves.toStrictEqual([]);
  });

  it("connectors-automatic-028 requires OAuth after a challenge even when resource discovery is unavailable", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "oauth",
      endpoint: fixture.endpoint,
      resourceMetadataStatus: 503,
    });
    const actor = member();

    const started = await requestStart(actor, fixture, add, [503]);

    expect(started.status).toBe(503);
    await expect(listAccounts(actor, fixture)).resolves.toStrictEqual([]);
  });

  it("connectors-automatic-032 does not downgrade an advertised OAuth authority when AS discovery fails", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      endpoint: fixture.endpoint,
    });
    server.use(
      http.get(
        `${provider.issuer}/.well-known/oauth-authorization-server`,
        () => {
          return HttpResponse.json(
            { error: "temporarily_unavailable" },
            { status: 503 },
          );
        },
      ),
      http.get(`${provider.issuer}/.well-known/openid-configuration`, () => {
        return HttpResponse.json(
          { error: "temporarily_unavailable" },
          { status: 503 },
        );
      }),
    );
    const actor = member();

    const started = await requestStart(actor, fixture, add, [503]);

    expect(started.status).toBe(503);
    await expect(listAccounts(actor, fixture)).resolves.toStrictEqual([]);
  });

  it("connectors-automatic-034 rejects discovery metadata whose issuer differs from the requested issuer", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
      metadataIssuer: "https://different-issuer.example.test",
    });
    const actor = member();

    const started = await requestStart(actor, fixture, add, [409]);

    expect(started.status).toBe(409);
    expect(provider.tokenBodies).toHaveLength(0);
    await expect(listAccounts(actor, fixture)).resolves.toStrictEqual([]);
  });

  it("connectors-automatic-055 rejects DCR unsupported authentication without creating an account", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      endpoint: fixture.endpoint,
      tokenEndpointAuthMethodsSupported: [
        "client_secret_basic",
        "client_secret_post",
      ],
    });
    server.use(
      http.post(`${provider.issuer}/register`, async ({ request }) => {
        const body: unknown = await request.json();
        return HttpResponse.json({
          ...(typeof body === "object" && body !== null ? body : {}),
          client_id: "automatic-dcr-client",
          token_endpoint_auth_method: "private_key_jwt",
        });
      }),
    );
    const actor = member();

    const started = await requestStart(actor, fixture, add, [409]);

    expect(started.body).toMatchObject({ error: { code: "CONFLICT" } });
    await expect(listAccounts(actor, fixture)).resolves.toStrictEqual([]);
  });

  it("connectors-automatic-060 consumes cancellation without accepting a subsequent authorization code", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
    });
    const actor = member();
    const started = await authorize(actor, fixture);

    const cancelled = await callback({
      state: started.state,
      error: "access_denied",
    });
    const later = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "late-code",
    });
    const completion = await receipt(actor, fixture, started.oauthAttemptId);

    expect(cancelled.status).toBe("error");
    expect(later.status).toBe("error");
    expect(completion.status).toBe(404);
  });

  it("connectors-automatic-036 notifies account readers when OAuth completes an account", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
    });
    const actor = member();
    const started = await authorize(actor, fixture);

    const completed = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    });
    const listed = await listAccounts(actor, fixture);
    const completion = await receipt(actor, fixture, started.oauthAttemptId);

    expect(completed).toStrictEqual({ status: "success", username: null });
    expect(
      countPublishedTo(context.mocks, {
        channel: `user:${actor.userId}`,
        topic: "connector:changed",
      }),
    ).toBeGreaterThan(0);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "connector:changed",
      { connectorSlug: fixture.slug },
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      connectionStatus: "connected",
      authMethod: "smart-connect",
    });
    expect(completion.status).toBe(200);
    expect(completion.body).toStrictEqual({ connectionId: listed[0]?.id });
  });

  it("connectors-automatic-037 persists a verified OIDC identity without expanding scopes", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
      identity: {
        subject: "automatic-user-123",
        tokenUsername: "token-user",
        tokenEmail: "id-token-claim@example.test",
        userInfoUsername: "userinfo-user",
        userInfoEmail: "userinfo-user@example.test",
      },
    });
    const actor = member();

    const started = await authorize(actor, fixture);
    const completed = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    });
    const connectionId = await completedConnection(
      actor,
      fixture,
      started.oauthAttemptId,
    );
    const account = await readAccount(actor, fixture, connectionId);

    expect(started.url.searchParams.get("scope")).toBe("read write");
    expect(completed.status).toBe("success");
    expect(account).toMatchObject({
      externalId: "automatic-user-123",
      externalUsername: "userinfo-user",
      externalEmail: "userinfo-user@example.test",
    });
  });

  it("connectors-automatic-040 keeps a successful connection unnamed when its ID token is invalid", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
      identity: {
        subject: "untrusted-user",
        tokenUsername: "claimed-by-invalid-token",
        tokenEmail: "untrusted@example.test",
        invalidIdToken: true,
      },
    });
    const actor = member();

    const started = await authorize(actor, fixture);
    const completed = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    });
    const connectionId = await completedConnection(
      actor,
      fixture,
      started.oauthAttemptId,
    );
    const account = await readAccount(actor, fixture, connectionId);

    expect(completed.status).toBe("success");
    expect(account).toMatchObject({
      externalId: null,
      externalUsername: null,
      externalEmail: null,
    });
  });

  it("connectors-automatic-005 uses cimd declared-scopes authorization policy on connection and exact-account reconnect", async () => {
    const flow = await connectAndReconnect("declared-scopes", "cimd");

    expectPolicyAuthorization(flow, "consent");
    expect(flow.reconnected.body).toStrictEqual(flow.original.body);
    expect(flow.account.oauthScopes).toStrictEqual(POLICY_SCOPES);
  });

  it("connectors-automatic-006 uses cimd provider-prompt authorization policy on connection and exact-account reconnect", async () => {
    const flow = await connectAndReconnect("provider-prompt", "cimd");

    expectPolicyAuthorization(flow, null);
    expect(flow.reconnected.body).toStrictEqual(flow.original.body);
    expect(flow.account.oauthScopes).toStrictEqual(POLICY_SCOPES);
  });

  it("connectors-automatic-007 uses cimd explicit-prompt authorization policy on connection and exact-account reconnect", async () => {
    const flow = await connectAndReconnect("explicit-prompt", "cimd");

    expectPolicyAuthorization(flow, "login consent");
    expect(flow.reconnected.body).toStrictEqual(flow.original.body);
    expect(flow.account.oauthScopes).toStrictEqual(POLICY_SCOPES);
  });

  it("connectors-automatic-008 uses dcr declared-scopes authorization policy on connection and exact-account reconnect", async () => {
    const flow = await connectAndReconnect("declared-scopes", "dcr");

    expectPolicyAuthorization(flow, "consent");
    expect(flow.reconnected.body).toStrictEqual(flow.original.body);
    expect(flow.account.oauthScopes).toStrictEqual(POLICY_SCOPES);
    expect(flow.provider.registrationBodies).toHaveLength(1);
    expect(flow.provider.registrationBodies[0]?.scope).toBe(
      "openid read write offline_access",
    );
  });

  it("connectors-automatic-014 upgrades a public account only after explicit mixed OAuth reconnect and consent", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
      endpoint: fixture.endpoint,
    });
    const actor = member();
    const connected = await connectNow(actor, fixture);
    const before = await readAccount(actor, fixture, connected.connectionId);
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      endpoint: fixture.endpoint,
      metadataScopes: ["read"],
      authorizationCodeScopes: ["read"],
    });

    const started = await authorize(
      actor,
      fixture,
      reconnect(connected.connectionId),
    );
    const pending = await readAccount(actor, fixture, connected.connectionId);
    const completed = await callback({
      state: started.state,
      iss: provider.issuer,
      code: "upgrade-code",
    });
    const completion = await receipt(actor, fixture, started.oauthAttemptId);
    const after = await readAccount(actor, fixture, connected.connectionId);

    expect(pending).toStrictEqual(before);
    expect(completed.status).toBe("success");
    expect(completion.status).toBe(200);
    expect(completion.body).toStrictEqual({
      connectionId: connected.connectionId,
    });
    expect(after.connectionStatus).toBe("connected");
    expect(after.oauthScopes).toStrictEqual(["read"]);
  });

  it("connectors-automatic-015 preserves an OAuth account when reconnect metadata is unavailable", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      endpoint: fixture.endpoint,
      metadataScopes: ["read"],
      authorizationCodeScopes: ["read"],
    });
    const actor = member();
    const started = await authorize(actor, fixture);
    await callback({
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    });
    const connectionId = await completedConnection(
      actor,
      fixture,
      started.oauthAttemptId,
    );
    const before = await readAccount(actor, fixture, connectionId);
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "mixed",
      endpoint: fixture.endpoint,
      resourceMetadataStatus: 503,
    });

    const rejected = await requestStart(
      actor,
      fixture,
      reconnect(connectionId),
      [503],
    );

    expect(rejected.status).toBe(503);
    await expect(
      readAccount(actor, fixture, connectionId),
    ).resolves.toStrictEqual(before);
  });

  it("connectors-automatic-035 completes parent-resource CIMD OAuth through the fixed callback and exact receipt", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const origin = new URL(fixture.endpoint).origin;
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
      resource: origin,
    });
    const actor = member();
    const peer = member(actor.orgId);

    const started = await authorize(actor, fixture);
    const pending = await receipt(actor, fixture, started.oauthAttemptId);
    const query = {
      state: started.state,
      iss: provider.issuer,
      code: "authorized-code",
    };
    const completed = await callback(query);
    const completion = await receipt(actor, fixture, started.oauthAttemptId);
    const account = await readAccount(
      actor,
      fixture,
      receiptConnection(completion),
    );
    const replay = await callback(query);
    const peerRead = await receipt(peer, fixture, started.oauthAttemptId);

    expect(started.url.searchParams.get("resource")).toBe(origin);
    expect(started.url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(pending.status).toBe(404);
    expect(completed).toStrictEqual({ status: "success", username: null });
    expect(completion.status).toBe(200);
    expect(account).toMatchObject({
      connectionStatus: "connected",
      authMethod: "smart-connect",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: ["read", "write"],
    });
    expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(CALLBACK);
    expect(provider.tokenBodies[0]?.get("resource")).toBe(origin);
    expect(replay.status).toBe("error");
    expect(peerRead.status).toBe(404);
  });

  it("connectors-automatic-041 connects and reuses a public-only DCR client with a long opaque ID and issuer binding", async () => {
    const flow = await dcrIssuerBindingFlow("public-only");

    expectDcrIssuerBinding(flow);
    expect(
      flow.provider.registrationBodies[0]?.token_endpoint_auth_method,
    ).toBe("none");
  });

  it("connectors-automatic-043 connects and reuses a public and confidential basic DCR client with a long opaque ID and issuer binding", async () => {
    const flow = await dcrIssuerBindingFlow("basic");

    expectDcrIssuerBinding(flow);
    expect(
      flow.provider.registrationBodies[0]?.token_endpoint_auth_method,
    ).toBe("client_secret_basic");
  });

  it("connectors-automatic-044 connects and reuses a public and confidential post DCR client with a long opaque ID and issuer binding", async () => {
    const flow = await dcrIssuerBindingFlow("post");

    expectDcrIssuerBinding(flow);
    expect(
      flow.provider.registrationBodies[0]?.token_endpoint_auth_method,
    ).toBe("client_secret_post");
  });

  it("connectors-automatic-051 connects and reuses a unspecified authentication DCR client with a long opaque ID and issuer binding", async () => {
    const flow = await dcrIssuerBindingFlow("unspecified");

    expectDcrIssuerBinding(flow);
    expect(
      flow.provider.registrationBodies[0]?.token_endpoint_auth_method,
    ).toBeUndefined();
  });

  it("connectors-automatic-033 publishes two concurrent no-auth accounts with exactly one default", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
      endpoint: fixture.endpoint,
    });
    const actor = member();

    const [first, second] = await Promise.all([
      connectNow(actor, fixture),
      connectNow(actor, fixture),
    ]);
    const listed = await listAccounts(actor, fixture);

    expect(first.connectionId).toBeTruthy();
    expect(second.connectionId).toBeTruthy();
    expect(first.connectionId).not.toBe(second.connectionId);
    expect(
      new Set(
        listed.map((account) => {
          return account.id;
        }),
      ),
    ).toStrictEqual(new Set([first.connectionId, second.connectionId]));
    expect(listed).toHaveLength(2);
    expect(
      listed.filter((account) => {
        return account.isDefault;
      }),
    ).toHaveLength(1);
    for (const account of listed) {
      expect(account).toMatchObject({
        authMethod: "smart-connect",
        connectionStatus: "connected",
      });
    }
  });

  it("connectors-automatic-059 does not resurrect an account deleted during its reconnect token exchange", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
    });
    const actor = member();
    const first = await authorize(actor, fixture);
    await callback({
      state: first.state,
      iss: provider.issuer,
      code: "first-code",
    });
    const connectionId = await completedConnection(
      actor,
      fixture,
      first.oauthAttemptId,
    );
    const second = await authorize(actor, fixture, reconnect(connectionId));
    let reconnectExchanges = 0;
    server.use(
      http.post(`${provider.issuer}/token`, async () => {
        reconnectExchanges += 1;
        act(actor);
        await accept(
          accounts.delete({
            headers,
            params: { connectionId },
            body: { target: { kind: "builtin", connectorSlug: fixture.slug } },
          }),
          [200],
        );
        // Fall through so the provider then returns its new tokens.
        return undefined;
      }),
    );

    const completed = await callback({
      state: second.state,
      iss: provider.issuer,
      code: "reconnect-code",
    });
    if (reconnectExchanges !== 1) {
      throw new Error("Expected exactly one reconnect token exchange");
    }
    const completion = await receipt(actor, fixture, second.oauthAttemptId);
    const listed = await listAccounts(actor, fixture);

    expect(completed.status).toBe("error");
    expect(completion.status).toBe(404);
    expect(listed).toStrictEqual([]);
  });

  it("pf-063 keeps a direct native Automatic OAuth callback on its connector result page", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
    });
    const actor = member();
    const started = await authorize(actor, fixture, add, "ios-https");

    const redirect = await accept(
      automatic.callback({
        query: {
          state: started.state,
          iss: provider.issuer,
          code: "native-direct-code",
        },
      }),
      [307],
    );

    const location = new URL(redirect.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      `https://app.okou.ai/connectors/${fixture.slug}/callback/success`,
    );
    expect(location.searchParams.get("nativeAppAttemptId")).toBe(
      started.oauthAttemptId,
    );
    expect(location.searchParams.get("nativeAppHttpsHost")).toBe("app.okou.ai");
    await expect(
      completedConnection(actor, fixture, started.oauthAttemptId),
    ).resolves.toBeTruthy();
  });

  it("pf-064 deduplicates repeated Automatic OAuth identity (overlap=false)", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
      identity: {
        subject: "shared-oidc-subject",
        tokenUsername: "same-user",
        tokenEmail: "same-user@example.test",
        userInfoUsername: "same-user",
        userInfoEmail: "same-user@example.test",
      },
    });
    const actor = member();

    const first = await authorize(actor, fixture);
    await callback({
      state: first.state,
      iss: provider.issuer,
      code: "first-code",
    });
    const firstId = await completedConnection(
      actor,
      fixture,
      first.oauthAttemptId,
    );

    const second = await authorize(actor, fixture);
    await callback({
      state: second.state,
      iss: provider.issuer,
      code: "second-code",
    });
    const secondId = await completedConnection(
      actor,
      fixture,
      second.oauthAttemptId,
    );

    expect(secondId).toBe(firstId);
    const listed = await listAccounts(actor, fixture);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(firstId);
  });

  it("pf-066 keeps the same subject from different OAuth issuers as distinct accounts", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const firstProvider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
      issuer: "https://issuer-one.example.test",
      identity: {
        subject: "identical-subject",
        tokenUsername: "user-one",
        tokenEmail: "one@example.test",
        userInfoUsername: "user-one",
        userInfoEmail: "one@example.test",
      },
    });
    const actor = member();

    const first = await authorize(actor, fixture);
    await callback({
      state: first.state,
      iss: firstProvider.issuer,
      code: "code-one",
    });
    const firstId = await completedConnection(
      actor,
      fixture,
      first.oauthAttemptId,
    );

    const secondProvider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      endpoint: fixture.endpoint,
      issuer: "https://issuer-two.example.test",
      identity: {
        subject: "identical-subject",
        tokenUsername: "user-two",
        tokenEmail: "two@example.test",
        userInfoUsername: "user-two",
        userInfoEmail: "two@example.test",
      },
    });
    const second = await authorize(actor, fixture);
    await callback({
      state: second.state,
      iss: secondProvider.issuer,
      code: "code-two",
    });
    const secondId = await completedConnection(
      actor,
      fixture,
      second.oauthAttemptId,
    );

    expect(secondId).not.toBe(firstId);
    await expect(listAccounts(actor, fixture)).resolves.toHaveLength(2);
  });
});
