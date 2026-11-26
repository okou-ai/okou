import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

interface AccessSetup {
  readonly admin: ApiTestUser;
  readonly configId: string;
  readonly accessClientId: string;
  readonly accessSecret: string;
}

/** An organization admin with the Access feature and one organization configuration. */
async function accessWorkspace(): Promise<AccessSetup> {
  context.mocks.dns.resolve4.mockResolvedValue(["93.184.216.34"]);
  context.mocks.dns.resolve6.mockRejectedValue(
    Object.assign(new Error("no AAAA record"), { code: "ENODATA" }),
  );
  const admin = bdd.user();
  await connectors.updateFeatureSwitches(admin, {
    [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
  });
  const accessClientId = `access-client-${randomUUID()}`;
  const accessSecret = `access-secret-${randomUUID()}`;
  createRouteMocks(context).clerk.session(
    admin.userId,
    admin.orgId,
    admin.orgRole,
  );
  const config = await accept(
    setupApp({ context, routes: cloudflareAccessRoutes })(
      cloudflareAccessContract,
    ).create({
      headers: { authorization: "Bearer clerk-session" },
      query: { view: "scoped" },
      body: {
        id: randomUUID(),
        name: `Gateway ${randomUUID().slice(0, 8)}`,
        scope: "organization",
        credentials: { clientId: accessClientId, clientSecret: accessSecret },
      },
    }),
    [201],
  );
  return {
    admin,
    configId: config.body.id,
    accessClientId,
    accessSecret,
  };
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return state;
}

async function expectConnectedWithoutSecret(
  setup: AccessSetup,
  connectorId: string,
): Promise<void> {
  const accounts = await connectors.listCustomConnectorAccounts(
    setup.admin,
    connectorId,
  );
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({ connectionStatus: "connected" });
  expect(JSON.stringify(accounts)).not.toContain(setup.accessSecret);
}

async function staticHttpOAuthCase(args: {
  readonly tokenInsidePrefix: boolean;
  readonly tokenEndpointAuthMethod:
    "client_secret_basic" | "client_secret_post";
}) {
  const setup = await accessWorkspace();
  const id = randomUUID();
  const prefix = `https://api-${id}.example.test/v1/`;
  const tokenUrl = args.tokenInsidePrefix
    ? `${prefix}oauth/token`
    : `https://auth-${id}.example.test/oauth/token`;
  const clientId = `app-client-${id}`;
  const clientSecret = `app-secret-${id}`;
  const tokenRequests: { headers: Headers; body: URLSearchParams }[] = [];
  server.use(
    http.post(tokenUrl, async ({ request }) => {
      tokenRequests.push({
        headers: new Headers(request.headers),
        body: new URLSearchParams(await request.text()),
      });
      return HttpResponse.json({
        access_token: `access-${id}`,
        refresh_token: `refresh-${id}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
  );
  const connector = await connectors.createCustomConnector(setup.admin, {
    displayName: "Internal Orders",
    prefixTemplates: [prefix],
    authMode: "oauth",
    fields: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
    ],
    queryInjections: [],
    oauthConfig: {
      providerAdapter: "standard",
      clientId,
      clientSecret,
      authorizationUrl: `https://auth-${id}.example.test/authorize`,
      tokenUrl,
      tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
      pkceMethod: "S256",
      scopes: ["read"],
      authorizationParams: {},
    },
    networkBinding: { type: "cloudflare_access", configId: setup.configId },
  });

  const authorizationUrl = await connectors.startCustomConnectorOAuth2(
    setup.admin,
    connector.id,
  );
  expect(authorizationUrl).not.toContain(setup.accessSecret);
  expect(
    new URL(authorizationUrl).searchParams.get("code_challenge_method"),
  ).toBe("S256");
  const completed =
    await connectors.completeCustomConnectorOAuth2CallbackResult({
      state: stateOf(authorizationUrl),
      code: `code-${id}`,
    });
  expect(completed.body.status).toBe("success");
  await expectConnectedWithoutSecret(setup, connector.id);
  expect(tokenRequests).toHaveLength(1);
  const [exchange] = tokenRequests;
  if (!exchange) {
    throw new Error("Expected one code exchange");
  }
  expect(exchange.body.get("code_verifier")).toBeTruthy();
  return { setup, exchange, clientId, clientSecret };
}

type McpChallenge = "parameters" | "bare" | "combined";

async function automaticMcpCase(args: {
  readonly registration: "none" | "cimd" | "dcr";
  readonly challenge: McpChallenge;
  readonly access: boolean;
  readonly protectedIssuer: boolean;
}) {
  const setup = await accessWorkspace();
  if (args.registration === "cimd") {
    // CIMD client IDs must be HTTPS, so publish them from the hosted API origin.
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  }
  const id = randomUUID();
  const endpoint = `https://mcp-${id}.example.test/server`;
  const provider = mockAutomaticMcpOAuthProvider(context, {
    registration: args.registration,
    authentication: args.registration === "none" ? "none" : "oauth",
    endpoint,
    issuer: `https://issuer-${id}.example.test`,
    ...(args.protectedIssuer ? { tokenEndpoint: `${endpoint}/token` } : {}),
    ...(args.challenge === "parameters"
      ? {}
      : { discovery: "well-known-oidc" as const, challengeScope: null }),
    ...(args.challenge === "combined"
      ? { challengeHeader: 'Digest realm="mcp", Bearer' }
      : {}),
  });
  const connector = await connectors.createCustomConnector(setup.admin, {
    kind: "mcp",
    displayName: "Internal research",
    endpoint,
    transport: "streamable-http",
    authMode: "automatic",
    fields: [],
    headerInjections: [],
    queryInjections: [],
    ...(args.access
      ? {
          networkBinding: {
            type: "cloudflare_access" as const,
            configId: setup.configId,
          },
        }
      : {}),
  });

  const started = await connectors.requestStartCustomConnectorOAuth2(
    setup.admin,
    connector.id,
    [200],
  );
  if (started.status !== 200) {
    throw new Error("Expected the authorization start to succeed");
  }
  expect(provider.endpointHeaders.length).toBeGreaterThan(0);
  expect(
    provider.endpointHeaders.map((headers) => {
      return headers.get("cf-access-client-secret");
    }),
  ).toStrictEqual(
    provider.endpointHeaders.map(() => {
      return args.access ? setup.accessSecret : null;
    }),
  );
  return { setup, provider, connector, started: started.body };
}

/** Completes provider consent and reports what the provider and owner observed. */
async function completeAutomaticMcpCase(
  run: Awaited<ReturnType<typeof automaticMcpCase>>,
) {
  const { setup, provider, connector, started } = run;
  if (started.result !== "authorization") {
    throw new Error("Expected an authorization URL");
  }
  const completed =
    await connectors.completeCustomConnectorOAuth2CallbackResult({
      state: stateOf(started.authorizationUrl),
      code: `code-${randomUUID()}`,
      iss: provider.issuer,
    });
  const accounts = await connectors.listCustomConnectorAccounts(
    setup.admin,
    connector.id,
  );
  return {
    authorizationUrlExposesAccess: started.authorizationUrl.includes(
      setup.accessSecret,
    ),
    callbackStatus: completed.body.status,
    registrations: provider.registrationBodies.length,
    tokenRequestsWithAccess: provider.tokenHeaders.map((headers) => {
      return headers.get("cf-access-client-secret") === setup.accessSecret;
    }),
    accountStatuses: accounts.map((account) => {
      return account.connectionStatus;
    }),
    accountsExposeAccess: JSON.stringify(accounts).includes(setup.accessSecret),
  };
}

function connectedOutcome(registrations: number, tokenAccess: boolean) {
  return {
    authorizationUrlExposesAccess: false,
    callbackStatus: "success",
    registrations,
    tokenRequestsWithAccess: [tokenAccess],
    accountStatuses: ["connected"],
    accountsExposeAccess: false,
  };
}

describe("custom connector Cloudflare Access OAuth setup", () => {
  it("custom-connector-cloudflare-oauth-003 (1/2) starts S256 authorization without exposing the Access secret", async () => {
    const setup = await accessWorkspace();
    const id = randomUUID();
    const connector = await connectors.createCustomConnector(setup.admin, {
      displayName: "Internal Orders",
      prefixTemplates: [`https://api-${id}.example.test/v1/`],
      authMode: "oauth",
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      oauthConfig: {
        providerAdapter: "standard",
        clientId: `app-client-${id}`,
        clientSecret: `app-secret-${id}`,
        authorizationUrl: `https://auth-${id}.example.test/authorize`,
        tokenUrl: `https://auth-${id}.example.test/oauth/token`,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read"],
        authorizationParams: {},
      },
      networkBinding: { type: "cloudflare_access", configId: setup.configId },
    });

    const authorizationUrl = await connectors.startCustomConnectorOAuth2(
      setup.admin,
      connector.id,
    );

    expect(authorizationUrl).not.toContain(setup.accessSecret);
    expect(
      new URL(authorizationUrl).searchParams.get("code_challenge_method"),
    ).toBe("S256");
  });

  it("custom-connector-cloudflare-oauth-003 (2/2) exchanges the code outside the prefix with the app secret and no Access headers", async () => {
    const { exchange, clientSecret } = await staticHttpOAuthCase({
      tokenInsidePrefix: false,
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(exchange.body.get("client_secret")).toBe(clientSecret);
    expect(exchange.headers.get("cf-access-client-id")).toBeNull();
    expect(exchange.headers.get("cf-access-client-secret")).toBeNull();
  });

  it("custom-connector-cloudflare-oauth-001 sends Basic app auth and Access headers to a token endpoint inside the prefix", async () => {
    const { setup, exchange, clientId, clientSecret } =
      await staticHttpOAuthCase({
        tokenInsidePrefix: true,
        tokenEndpointAuthMethod: "client_secret_basic",
      });
    expect(exchange.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    );
    expect(exchange.body.has("client_secret")).toBeFalsy();
    expect(exchange.headers.get("cf-access-client-id")).toBe(
      setup.accessClientId,
    );
    expect(exchange.headers.get("cf-access-client-secret")).toBe(
      setup.accessSecret,
    );
  });

  it("custom-connector-cloudflare-oauth-002 posts the app secret with Access headers to a token endpoint inside the prefix", async () => {
    const { setup, exchange, clientSecret } = await staticHttpOAuthCase({
      tokenInsidePrefix: true,
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(exchange.body.get("client_secret")).toBe(clientSecret);
    expect(exchange.headers.get("cf-access-client-id")).toBe(
      setup.accessClientId,
    );
    expect(exchange.headers.get("cf-access-client-secret")).toBe(
      setup.accessSecret,
    );
  });

  it("custom-connector-cloudflare-oauth-007 connects a no-auth Access-bound MCP server directly", async () => {
    const { setup, connector, started } = await automaticMcpCase({
      registration: "none",
      challenge: "parameters",
      access: true,
      protectedIssuer: false,
    });
    expect(started.result).toBe("connected");
    expect(JSON.stringify(started)).not.toContain(setup.accessSecret);
    await expectConnectedWithoutSecret(setup, connector.id);
  });

  it("custom-connector-cloudflare-oauth-008 authorizes an Access-bound CIMD MCP server without sending Access to the issuer", async () => {
    const run = await automaticMcpCase({
      registration: "cimd",
      challenge: "parameters",
      access: true,
      protectedIssuer: false,
    });
    await expect(completeAutomaticMcpCase(run)).resolves.toStrictEqual(
      connectedOutcome(0, false),
    );
  });

  it("custom-connector-cloudflare-oauth-009 authorizes an Access-bound DCR MCP server without sending Access to the issuer", async () => {
    const run = await automaticMcpCase({
      registration: "dcr",
      challenge: "parameters",
      access: true,
      protectedIssuer: false,
    });
    await expect(completeAutomaticMcpCase(run)).resolves.toStrictEqual(
      connectedOutcome(1, false),
    );
  });

  it("custom-connector-cloudflare-oauth-011 authorizes an Access-bound DCR MCP server discovered through a bare challenge", async () => {
    const run = await automaticMcpCase({
      registration: "dcr",
      challenge: "bare",
      access: true,
      protectedIssuer: false,
    });
    await expect(completeAutomaticMcpCase(run)).resolves.toStrictEqual(
      connectedOutcome(1, false),
    );
  });

  it("custom-connector-cloudflare-oauth-012 authorizes an unbound CIMD MCP server behind a combined challenge", async () => {
    const run = await automaticMcpCase({
      registration: "cimd",
      challenge: "combined",
      access: false,
      protectedIssuer: false,
    });
    await expect(completeAutomaticMcpCase(run)).resolves.toStrictEqual(
      connectedOutcome(0, false),
    );
  });

  it("custom-connector-cloudflare-oauth-014 authorizes an unbound DCR MCP server behind a combined challenge", async () => {
    const run = await automaticMcpCase({
      registration: "dcr",
      challenge: "combined",
      access: false,
      protectedIssuer: false,
    });
    await expect(completeAutomaticMcpCase(run)).resolves.toStrictEqual(
      connectedOutcome(1, false),
    );
  });

  it("custom-connector-cloudflare-oauth-019 sends Access to a CIMD token endpoint on the protected MCP origin", async () => {
    const run = await automaticMcpCase({
      registration: "cimd",
      challenge: "bare",
      access: true,
      protectedIssuer: true,
    });
    await expect(completeAutomaticMcpCase(run)).resolves.toStrictEqual(
      connectedOutcome(0, true),
    );
  });

  it("custom-connector-cloudflare-oauth-020 sends Access to a DCR token endpoint on the protected MCP origin", async () => {
    const run = await automaticMcpCase({
      registration: "dcr",
      challenge: "bare",
      access: true,
      protectedIssuer: true,
    });
    await expect(completeAutomaticMcpCase(run)).resolves.toStrictEqual(
      connectedOutcome(1, true),
    );
  });
});
