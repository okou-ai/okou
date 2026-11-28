import { createBddApi } from "./helpers/api-bdd";
import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mcpOAuthContract } from "@okouai/api-contracts/contracts/mcp-oauth";
import { testContext, accept } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { mockEnv } from "../../../lib/env";
import { mcpOAuthClientMetadataRoutes } from "../mcp-oauth-client-metadata";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

type ProviderOptions = Parameters<typeof mockAutomaticMcpOAuthProvider>[1];

function uniqueEndpoint(): string {
  return `https://automatic-mcp-${randomUUID()}.example.test/server`;
}

function uniqueIssuer(): string {
  return `https://issuer-${randomUUID()}.example.test`;
}

/** CIMD client IDs must be HTTPS, so publish them from the hosted API origin. */
function useHostedApiOrigin(): void {
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
}

function installProvider(options: ProviderOptions) {
  useHostedApiOrigin();
  return mockAutomaticMcpOAuthProvider(context, {
    endpoint: uniqueEndpoint(),
    issuer: uniqueIssuer(),
    ...options,
  });
}

async function createAutomaticConnector(
  admin: ReturnType<typeof bdd.user>,
  endpoint: string,
) {
  return await connectors.createCustomConnector(admin, {
    kind: "mcp",
    displayName: "Automatic research",
    endpoint,
    transport: "streamable-http",
    authMode: "automatic",
    fields: [],
    headerInjections: [],
    queryInjections: [],
  });
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return state;
}

async function authorizationScopeFor(options: ProviderOptions) {
  const provider = installProvider(options);
  const admin = bdd.user();
  const connector = await createAutomaticConnector(admin, provider.endpoint);
  const authorizationUrl = await connectors.startCustomConnectorOAuth2(
    admin,
    connector.id,
  );
  return {
    provider,
    params: new URL(authorizationUrl).searchParams,
  };
}

async function connectMixedConnector(registration: "cimd" | "dcr") {
  const provider = installProvider({
    registration,
    authentication: "mixed",
    metadataScopes: ["read", "write"],
  });
  const admin = bdd.user();
  const connector = await createAutomaticConnector(admin, provider.endpoint);
  const authorizationUrl = await connectors.startCustomConnectorOAuth2(
    admin,
    connector.id,
  );
  const params = new URL(authorizationUrl).searchParams;
  const completed =
    await connectors.completeCustomConnectorOAuth2CallbackResult({
      state: stateOf(authorizationUrl),
      code: `code-${randomUUID()}`,
      iss: provider.issuer,
    });
  const accounts = await connectors.listCustomConnectorAccounts(
    admin,
    connector.id,
  );
  return { params, completed, accounts };
}

describe("MCP OAuth foundations", () => {
  it("mcp-oauth-foundations-015 publishes the Okou client metadata document from configured origins", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const client = setupApp({
      context,
      routes: mcpOAuthClientMetadataRoutes,
    })(mcpOAuthContract);

    const response = await accept(client.okouClientMetadata(), [200]);

    expect(response.body).toStrictEqual({
      client_id: "https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json",
      client_name: "Okou",
      client_uri: "https://app.okou.ai/",
      redirect_uris: [
        "https://app.okou.ai/connectors/custom/callback",
        "https://api.okou.ai/api/connectors/automatic/callback",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
    });
  });

  it("mcp-oauth-foundations-001 adds offline access offered only by the authorization server to the challenge scope", async () => {
    const { params } = await authorizationScopeFor({
      registration: "cimd",
      authentication: "oauth",
      challengeScope: "graph:read",
      metadataScopes: ["graph:read", "media:read"],
      authorizationServerScopes: [
        "graph:read",
        "media:read",
        "offline_access",
        "admin",
      ],
    });

    expect(params.get("scope")).toBe("graph:read offline_access");
  });

  it("mcp-oauth-foundations-002 uses the resource scopes when the challenge has none", async () => {
    const { params } = await authorizationScopeFor({
      registration: "cimd",
      authentication: "oauth",
      challengeScope: null,
      metadataScopes: ["graph:read", "media:read"],
      authorizationServerScopes: ["graph:read", "media:read", "offline_access"],
    });

    expect(params.get("scope")).toBe("graph:read media:read offline_access");
  });

  it("mcp-oauth-foundations-004 does not add offline access the authorization server does not offer", async () => {
    const { params } = await authorizationScopeFor({
      registration: "cimd",
      authentication: "oauth",
      challengeScope: "graph:read",
      authorizationServerScopes: ["graph:read", "admin"],
    });

    expect(params.get("scope")).toBe("graph:read");
  });

  it("mcp-oauth-foundations-008 registers the DCR client with the same offline-access scope", async () => {
    const { params, provider } = await authorizationScopeFor({
      registration: "dcr",
      authentication: "oauth",
      challengeScope: "graph:read",
      authorizationServerScopes: ["graph:read", "offline_access", "admin"],
    });

    expect(params.get("scope")).toBe("graph:read offline_access");
    expect(provider.registrationBodies).toHaveLength(1);
    expect(provider.registrationBodies[0]?.scope).toBe(
      "graph:read offline_access",
    );
  });

  it("mcp-oauth-foundations-009 leaves the scope to the provider when no resource scopes are advertised", async () => {
    const { params } = await authorizationScopeFor({
      registration: "cimd",
      authentication: "oauth",
      challengeScope: null,
      metadataScopes: [],
      authorizationServerScopes: ["offline_access", "admin"],
    });

    expect(params.has("scope")).toBeFalsy();
  });

  it("mcp-oauth-foundations-010 connects a publicly initializable MCP server through CIMD", async () => {
    const { params, completed, accounts } = await connectMixedConnector("cimd");

    expect(params.get("scope")).toBe("read write");
    expect(params.get("client_id")).toBe(
      "https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json",
    );
    expect(completed.body.status).toBe("success");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      connectionStatus: "connected",
      oauthScopes: ["read", "write"],
    });
  });

  it("mcp-oauth-foundations-011 connects a publicly initializable MCP server through DCR", async () => {
    const { params, completed, accounts } = await connectMixedConnector("dcr");

    expect(params.get("scope")).toBe("read write");
    expect(params.get("client_id")).toBe("automatic-dcr-client");
    expect(completed.body.status).toBe("success");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      connectionStatus: "connected",
      oauthScopes: ["read", "write"],
    });
  });

  it("mcp-oauth-foundations-012 keeps the connected account when reconnect metadata is unavailable", async () => {
    const endpoint = uniqueEndpoint();
    const issuer = uniqueIssuer();
    useHostedApiOrigin();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "oauth",
      endpoint,
      issuer,
    });
    const admin = bdd.user();
    const connector = await createAutomaticConnector(admin, endpoint);
    const authorizationUrl = await connectors.startCustomConnectorOAuth2(
      admin,
      connector.id,
    );
    const completed =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state: stateOf(authorizationUrl),
        code: `code-${randomUUID()}`,
        iss: provider.issuer,
      });
    expect(completed.body.status).toBe("success");
    const before = await connectors.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    const [account] = before;
    if (!account) {
      throw new Error("Expected a connected account");
    }

    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "oauth",
      endpoint,
      issuer,
      resourceMetadataStatus: 503,
    });
    const reconnect = await connectors.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [502],
      { intent: "reconnect", connectionId: account.id },
    );

    expect(reconnect.status).toBe(502);
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toStrictEqual(before);
  });

  it("mcp-oauth-foundations-014 connects a public MCP server whose optional metadata is an HTML page", async () => {
    const provider = installProvider({
      registration: "none",
      authentication: "none",
    });
    server.use(
      http.get(
        new URL("/.well-known/oauth-protected-resource", provider.endpoint)
          .href,
        () => {
          return new HttpResponse("<!doctype html><title>Docs</title>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        },
      ),
    );
    const admin = bdd.user();
    const connector = await createAutomaticConnector(admin, provider.endpoint);

    const response = await connectors.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [200],
    );

    expect(response.status).toBe(200);
    if (!("result" in response.body)) {
      throw new Error("Expected an OAuth start result");
    }
    expect(response.body.result).toBe("connected");
    const accounts = await connectors.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      connectionStatus: "connected",
      oauthScopes: null,
    });
  });

  it("mcp-oauth-foundations-017 rejects an insecure resource metadata URL before any token request", async () => {
    const provider = installProvider({
      registration: "cimd",
      authentication: "oauth",
      challengeHeader:
        'Bearer resource_metadata="http://oauth.example.com/metadata", scope="read write"',
    });
    const admin = bdd.user();
    const connector = await createAutomaticConnector(admin, provider.endpoint);

    const response = await connectors.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "MCP_OAUTH_UNSAFE_URL",
        message:
          "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method.",
      },
    });
    expect(provider.tokenBodies).toHaveLength(0);
  });

  it("mcp-oauth-foundations-020 follows three same-origin metadata redirects", async () => {
    const issuer = uniqueIssuer();
    const endpoint = uniqueEndpoint();
    useHostedApiOrigin();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "oauth",
      endpoint,
      issuer,
      challengeHeader:
        'Bearer resource_metadata="https://oauth.example.com/redirect/0", scope="read write"',
    });
    const fetchedSteps: number[] = [];
    server.use(
      http.get("https://oauth.example.com/redirect/:step", ({ params }) => {
        const step = Number(params.step);
        fetchedSteps.push(step);
        if (step < 3) {
          return new HttpResponse(null, {
            status: 302,
            headers: {
              location: `https://oauth.example.com/redirect/${step + 1}`,
            },
          });
        }
        return HttpResponse.json({
          resource: endpoint,
          authorization_servers: [issuer],
          scopes_supported: ["read", "write"],
        });
      }),
    );
    const admin = bdd.user();
    const connector = await createAutomaticConnector(admin, endpoint);

    const response = await connectors.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [200],
    );

    if (
      !("result" in response.body) ||
      response.body.result !== "authorization"
    ) {
      throw new Error("Expected an OAuth authorization start");
    }
    const authorizationUrl = new URL(response.body.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      `${issuer}/authorize`,
    );
    expect(response.body.connectionId).toBeTruthy();
    expect(response.body.oauthAttemptId).toBeTruthy();
    expect(fetchedSteps).toStrictEqual([0, 1, 2, 3]);
    expect(provider.tokenBodies).toHaveLength(0);
  });

  it("mcp-oauth-foundations-026 drops the bearer token when userinfo redirects to another origin", async () => {
    const provider = installProvider({
      registration: "cimd",
      authentication: "oauth",
      initialAccessToken: "secret",
      userInfoEndpoint: "https://oauth.example.com/redirect",
      identity: { subject: "redirect-user" },
    });
    const userInfoAuthorizations: (string | null)[] = [];
    server.use(
      http.get("https://oauth.example.com/redirect", ({ request }) => {
        userInfoAuthorizations.push(request.headers.get("authorization"));
        return new HttpResponse(null, {
          status: 302,
          headers: { location: "https://metadata.example.com/document" },
        });
      }),
      http.get("https://metadata.example.com/document", ({ request }) => {
        userInfoAuthorizations.push(request.headers.get("authorization"));
        return HttpResponse.json({
          sub: "redirect-user",
          preferred_username: "redirect-userinfo-name",
        });
      }),
    );
    const admin = bdd.user();
    const connector = await createAutomaticConnector(admin, provider.endpoint);
    const authorizationUrl = await connectors.startCustomConnectorOAuth2(
      admin,
      connector.id,
    );

    const completed =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state: stateOf(authorizationUrl),
        code: `code-${randomUUID()}`,
        iss: provider.issuer,
      });

    expect(completed.status).toBe(200);
    expect(completed.body).toStrictEqual({ status: "success", username: null });
    expect(userInfoAuthorizations).toStrictEqual(["Bearer secret", null]);
    const accounts = await connectors.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      externalId: "redirect-user",
      externalUsername: "redirect-userinfo-name",
      externalEmail: null,
    });
  });
});
