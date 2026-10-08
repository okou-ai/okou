import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES } from "@okouai/api-contracts/contracts/custom-connectors";
import { mcpOAuthContract } from "@okouai/api-contracts/contracts/mcp-oauth";
import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import {
  testMcpOAuthFetchContract,
  type TestMcpOAuthFetchRequest,
} from "@okouai/api-contracts/contracts/test-mcp-oauth-fetch";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mcpOAuthClientMetadataRoutes } from "../mcp-oauth-client-metadata";
import { runnersRoutes } from "../runners";
import { testMcpOAuthFetchRoutes } from "../test-mcp-oauth-fetch";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();

function metadataClient(baseUrl = "http://api.test") {
  return setupApp({
    baseUrl,
    context,
    routes: mcpOAuthClientMetadataRoutes,
  })(mcpOAuthContract);
}

function probeClient() {
  return setupApp({ context, routes: testMcpOAuthFetchRoutes })(
    testMcpOAuthFetchContract,
  );
}

function allowPublicHost(hostname: string, address = "8.8.8.8"): void {
  context.mocks.dns.lookupOverrides.set(hostname, [{ address, family: 4 }]);
}

async function requestProbeSuccess(body: TestMcpOAuthFetchRequest) {
  return await accept(probeClient().request({ body }), [200]);
}

async function requestProbeFailure(body: TestMcpOAuthFetchRequest) {
  return await accept(probeClient().request({ body }), [502]);
}

describe("MCP OAuth foundations", () => {
  const oauthCleanups: (() => Promise<void>)[] = [];

  async function automaticOAuthFixture(
    options: Omit<
      Parameters<typeof mockAutomaticMcpOAuthProvider>[1],
      "registration"
    > = {},
  ) {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      ...options,
    });
    allowPublicHost(new URL(provider.endpoint).hostname, "8.8.4.4");
    allowPublicHost(new URL(provider.issuer).hostname, "1.1.1.1");
    const bdd = createBddApi(context);
    const connectors = createConnectorBddApi(context);
    bdd.acceptAgentStorageWrites();
    const actor = bdd.user({ orgRole: "org:admin" });
    const agent = await bdd.createAgent(actor, {
      displayName: "OAuth transport owner",
    });
    oauthCleanups.push(async () => {
      await bdd.deleteAgent(actor, agent.agentId);
    });
    const connector = await connectors.createCustomConnector(actor, {
      kind: "mcp",
      displayName: "OAuth transport boundaries",
      endpoint: provider.endpoint,
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    });
    oauthCleanups.push(async () => {
      await connectors.deleteCustomConnector(actor, connector.id);
    });
    return {
      actor,
      agent,
      connector,
      connectors,
      provider,
      resourceMetadata: {
        resource: provider.endpoint,
        authorization_servers: [provider.issuer],
      },
      async start(
        resourceMetadataUrl: string,
        statuses: readonly (200 | 400)[],
      ) {
        server.use(
          http.post(provider.endpoint, () => {
            return new HttpResponse(null, {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="read write"`,
              },
            });
          }),
        );
        return await connectors.requestStartCustomConnectorOAuth2(
          actor,
          connector.id,
          statuses,
          agent.agentId,
        );
      },
    };
  }

  function automaticOAuthFailure(code: string) {
    return {
      error: {
        code,
        message:
          "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method.",
      },
    };
  }

  afterEach(async () => {
    for (const cleanup of oauthCleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it("publishes exact public Okou client metadata from configured origins", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");

    const response = await accept(metadataClient().okouClientMetadata(), [200]);

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

  it("does not let the request host change the Okou client identity", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("APP_URL", "https://app.okou.ai");

    const response = await accept(
      metadataClient("https://attacker.example.com").okouClientMetadata(),
      [200],
    );

    expect(response.body.client_id).toBe(
      "https://api.okou.ai/api/oauth/mcp/client-metadata/okou.json",
    );
    expect(response.body.client_uri).toBe("https://app.okou.ai/");
    expect(response.body.redirect_uris).toStrictEqual([
      "https://app.okou.ai/connectors/custom/callback",
      "https://api.okou.ai/api/connectors/automatic/callback",
    ]);
  });

  it("supports OAuth metadata and SDK request body shapes with DNS pinning", async () => {
    allowPublicHost("oauth.example.com");
    server.use(
      http.get("https://oauth.example.com/metadata", ({ request }) => {
        return HttpResponse.json({ method: request.method });
      }),
      http.head("https://oauth.example.com/metadata", () => {
        return new HttpResponse(null, {
          status: 200,
          headers: { "x-oauth-metadata": "present" },
        });
      }),
      http.post("https://oauth.example.com/token", async ({ request }) => {
        return HttpResponse.json({
          contentType: request.headers.get("content-type"),
          body: await request.text(),
        });
      }),
    );

    const metadata = await requestProbeSuccess({
      url: "https://oauth.example.com/metadata",
      method: "GET",
    });
    const head = await requestProbeSuccess({
      url: "https://oauth.example.com/metadata",
      method: "HEAD",
    });
    const form = await requestProbeSuccess({
      url: "https://oauth.example.com/token",
      method: "POST",
      bodyKind: "form",
      body: "grant_type=authorization_code&code=code_test",
    });
    const json = await requestProbeSuccess({
      url: "https://oauth.example.com/token",
      method: "POST",
      bodyKind: "json",
      body: '{"redirect_uris":["https://app.okou.ai/callback"]}',
    });

    expect(metadata).toMatchObject({ status: 200 });
    expect(metadata.body).toMatchObject({ status: 200 });
    expect(JSON.parse(metadata.body.body)).toStrictEqual({ method: "GET" });
    expect(head.body).toMatchObject({
      status: 200,
      body: "",
      headers: expect.objectContaining({ "x-oauth-metadata": "present" }),
    });
    expect(JSON.parse(form.body.body)).toStrictEqual({
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      body: "grant_type=authorization_code&code=code_test",
    });
    expect(JSON.parse(json.body.body)).toStrictEqual({
      contentType: "application/json",
      body: '{"redirect_uris":["https://app.okou.ai/callback"]}',
    });
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
    ]);
  });

  it.each([
    "http://oauth.example.com/metadata",
    "https://user:password@oauth.example.com/metadata",
    "https://oauth.example.com/metadata#fragment",
    "https://localhost/metadata",
    "https://internal/metadata",
  ])("rejects unsafe OAuth URL %s", async (url) => {
    const oauth = await automaticOAuthFixture();
    allowPublicHost("oauth.example.com");

    const response = await oauth.start(url, [400]);

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual(
      automaticOAuthFailure(
        new URL(url).username
          ? CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID
          : CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.UNSAFE_URL,
      ),
    );
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.4.4",
    ]);
    expect(oauth.provider.tokenBodies).toStrictEqual([]);
  });

  it("rejects the whole DNS answer set when one address is private", async () => {
    const oauth = await automaticOAuthFixture();
    context.mocks.dns.lookupOverrides.set("mixed.example.com", [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);

    const response = await oauth.start(
      "https://mixed.example.com/metadata",
      [400],
    );

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual(
      automaticOAuthFailure(
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.UNSAFE_URL,
      ),
    );
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.4.4",
    ]);
    expect(oauth.provider.tokenBodies).toStrictEqual([]);
  });

  it("follows three metadata redirects and pins every hop", async () => {
    const oauth = await automaticOAuthFixture();
    const metadataSteps: number[] = [];
    allowPublicHost("oauth.example.com");
    server.use(
      http.get("https://oauth.example.com/redirect/:step", ({ params }) => {
        const step = Number(params.step);
        metadataSteps.push(step);
        return step < 3
          ? new HttpResponse(null, {
              status: 302,
              headers: { location: `/redirect/${step + 1}` },
            })
          : HttpResponse.json(oauth.resourceMetadata);
      }),
    );

    const response = await oauth.start(
      "https://oauth.example.com/redirect/0",
      [200],
    );

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      result: "authorization",
      authorizationUrl: expect.stringMatching(
        /^https:\/\/automatic-issuer\.example\.test\/authorize\?/u,
      ),
      connectionId: expect.any(String),
      oauthAttemptId: expect.any(String),
    });
    expect(metadataSteps).toStrictEqual([0, 1, 2, 3]);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.4.4",
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
      "1.1.1.1",
    ]);
    expect(oauth.provider.tokenBodies).toStrictEqual([]);
  });

  it("rejects a fourth metadata redirect", async () => {
    const oauth = await automaticOAuthFixture();
    const metadataSteps: number[] = [];
    allowPublicHost("oauth.example.com");
    server.use(
      http.get("https://oauth.example.com/redirect/:step", ({ params }) => {
        const step = Number(params.step);
        metadataSteps.push(step);
        return step < 4
          ? new HttpResponse(null, {
              status: 302,
              headers: { location: `/redirect/${step + 1}` },
            })
          : HttpResponse.json(oauth.resourceMetadata);
      }),
    );

    const response = await oauth.start(
      "https://oauth.example.com/redirect/0",
      [400],
    );

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual(
      automaticOAuthFailure(
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID,
      ),
    );
    expect(metadataSteps).toStrictEqual([0, 1, 2, 3]);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.4.4",
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
      "8.8.8.8",
    ]);
    expect(oauth.provider.tokenBodies).toStrictEqual([]);
  });

  it("revalidates a metadata redirect target before fetching it", async () => {
    const oauth = await automaticOAuthFixture();
    let privateRequests = 0;
    allowPublicHost("oauth.example.com");
    context.mocks.dns.lookupOverrides.set("private.example.com", [
      { address: "10.0.0.1", family: 4 },
    ]);
    server.use(
      http.get("https://oauth.example.com/redirect", () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { location: "https://private.example.com/metadata" },
        });
      }),
      http.get("https://private.example.com/metadata", () => {
        privateRequests += 1;
        return HttpResponse.json(oauth.resourceMetadata);
      }),
    );

    const response = await oauth.start(
      "https://oauth.example.com/redirect",
      [400],
    );

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual(
      automaticOAuthFailure(
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.UNSAFE_URL,
      ),
    );
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.4.4",
      "8.8.8.8",
    ]);
    expect(privateRequests).toBe(0);
    expect(oauth.provider.tokenBodies).toStrictEqual([]);
  });

  it("removes authorization before a metadata redirect", async () => {
    const oauth = await automaticOAuthFixture({
      initialAccessToken: "secret",
      userInfoEndpoint: "https://oauth.example.com/redirect",
      identity: {
        subject: "redirect-user",
        tokenUsername: "id-token-only-name",
      },
    });
    allowPublicHost("oauth.example.com");
    allowPublicHost("metadata.example.com", "1.1.1.1");
    const authorizations: (string | null)[] = [];
    server.use(
      http.get("https://oauth.example.com/redirect", ({ request }) => {
        authorizations.push(request.headers.get("authorization"));
        return request.headers.get("authorization") === "Bearer secret"
          ? new HttpResponse(null, {
              status: 302,
              headers: {
                location: "https://metadata.example.com/document",
              },
            })
          : new HttpResponse(null, { status: 400 });
      }),
      http.get("https://metadata.example.com/document", ({ request }) => {
        authorizations.push(request.headers.get("authorization"));
        return HttpResponse.json({
          sub: "redirect-user",
          preferred_username: "redirect-userinfo-name",
          authorization: request.headers.get("authorization"),
        });
      }),
    );

    const authorizationUrl = await oauth.connectors.startCustomConnectorOAuth2(
      oauth.actor,
      oauth.connector.id,
      oauth.agent.agentId,
    );
    const state = new URL(authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected automatic OAuth authorization state");
    }
    const response =
      await oauth.connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "redirect-identity-code",
        state,
        iss: oauth.provider.issuer,
      });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      status: "success",
      username: null,
    });
    expect(authorizations).toStrictEqual(["Bearer secret", null]);
    const accounts = await oauth.connectors.listCustomConnectorAccounts(
      oauth.actor,
      oauth.connector.id,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      externalId: "redirect-user",
      externalUsername: "redirect-userinfo-name",
      externalEmail: null,
    });
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.4.4",
      "8.8.4.4",
      "1.1.1.1",
      "1.1.1.1",
      "1.1.1.1",
      "1.1.1.1",
      "8.8.8.8",
      "1.1.1.1",
    ]);
  });

  it("rejects token and DCR POST redirects without replay", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    const runnerSecret = "b".repeat(64);
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    useSecretKmsProbe();
    const bdd = createBddApi(context);
    const connectors = createConnectorBddApi(context);
    const runs = createRunsApi(context);
    const firewall = createFirewallApi(context);
    const actor = bdd.user({ orgRole: "org:admin" });
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const group = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "OAuth refresh transport owner",
    });
    oauthCleanups.push(async () => {
      await bdd.deleteAgent(actor, agent.agentId);
    });
    allowPublicHost("oauth.example.com");
    const tokenRequests: {
      readonly body: string;
      readonly authorization: string | null;
      readonly contentType: string | null;
    }[] = [];
    let redirectedRequests = 0;
    server.use(
      http.post("https://oauth.example.com/token", async ({ request }) => {
        const body = await request.text();
        tokenRequests.push({
          body,
          authorization: request.headers.get("authorization"),
          contentType: request.headers.get("content-type"),
        });
        if (new URLSearchParams(body).get("grant_type") !== "refresh_token") {
          return HttpResponse.json({
            access_token: "initial-access-token",
            refresh_token: "secret",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "read",
          });
        }
        return new HttpResponse(null, {
          status: 307,
          headers: { location: "/redirected-token" },
        });
      }),
      http.post("https://oauth.example.com/redirected-token", () => {
        redirectedRequests += 1;
        return HttpResponse.json({
          access_token: "forbidden-replayed-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }),
    );
    const connector = await connectors.createCustomConnector(actor, {
      displayName: "OAuth refresh redirect boundary",
      prefixTemplates: [`https://${randomUUID()}.example.test/v1/`],
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth",
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "redirect-client",
        clientSecret: "redirect-secret",
        authorizationUrl: "https://oauth.example.com/authorize",
        tokenUrl: "https://oauth.example.com/token",
        tokenEndpointAuthMethod: "client_secret_basic",
        pkceMethod: "none",
        scopes: ["read"],
        authorizationParams: {},
      },
    });
    oauthCleanups.push(async () => {
      await connectors.deleteCustomConnector(actor, connector.id);
    });
    const authorizationUrl = await connectors.startCustomConnectorOAuth2(
      actor,
      connector.id,
      agent.agentId,
    );
    const state = new URL(authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected configured OAuth authorization state");
    }
    const connected =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "refresh-redirect-code",
        state,
      });
    expect(connected.body).toStrictEqual({ status: "success", username: null });
    const accounts = await connectors.listCustomConnectorAccounts(
      actor,
      connector.id,
    );
    expect(accounts).toHaveLength(1);
    const account = accounts[0];
    if (!account) {
      throw new Error("Expected the publicly authorized OAuth account");
    }
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Resolve my configured OAuth connector",
    });
    oauthCleanups.push(async () => {
      await runs.requestCancelRun(actor, run.runId, [200]);
      await flushWaitUntilForTest();
    });
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
    };
    const runnerHeaders = {
      authorization: `Bearer vm0_official_${runnerSecret}`,
    };
    await runs.requestHeartbeatRunnerAs(runnerHeaders.authorization, [200], {
      group,
      runnerId: runnerIdentity.runnerId,
      snapshotGeneration: runnerIdentity.heartbeatGeneration,
    });
    const claim = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersJobClaimContract,
      ).claim({
        headers: runnerHeaders,
        params: { id: run.runId },
        body: {
          runnerIdentity,
          capabilities: { piModelConfigGenerations: [1, 2, 3] },
        },
      }),
      [200],
    );
    const sandboxToken = claim.body.sandboxToken;
    if (!sandboxToken) {
      throw new Error("Expected the actual Runner claim sandbox credential");
    }
    await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    await flushWaitUntilForTest();
    tokenRequests.length = 0;
    context.mocks.nodeRequest.pinnedAddresses.length = 0;
    const internalName = `custom_connector_${connector.id.replaceAll("-", "")}`;
    const secretKey = `CUSTOM_${connector.id.replaceAll("-", "")}_S___OAUTH_ACCESS_TOKEN`;
    const response = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${sandboxToken}` },
      {
        encryptedSecrets: firewall.encryptedSecretsBody({}),
        authHeaders: { Authorization: `Bearer ${secretTemplate(secretKey)}` },
        matchedFirewall: {
          name: internalName,
          apiId: `${internalName}:0`,
          customConnectorId: connector.id,
          sourceId: account.id,
          routingVariables: {},
        },
        forceRefresh: true,
      },
      [502],
    );

    expect(response.status).toBe(502);
    expect(response.body).toStrictEqual({
      error: {
        code: "TOKEN_REFRESH_FAILED",
        message: `Access token refresh failed for: ${connector.id}. The upstream provider may be temporarily unavailable.`,
        connectors: [connector.id],
        failureReason: "upstream_provider",
      },
    });
    expect(tokenRequests).toStrictEqual([
      {
        body: "grant_type=refresh_token&refresh_token=secret",
        authorization: `Basic ${Buffer.from("redirect-client:redirect-secret").toString("base64")}`,
        contentType: "application/x-www-form-urlencoded",
      },
    ]);
    expect(redirectedRequests).toBe(0);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.8.8",
    ]);
  });

  it("enforces header and response body size limits", async () => {
    const oauth = await automaticOAuthFixture();
    allowPublicHost("oauth.example.com");
    const emptyMetadata = { ...oauth.resourceMetadata, resource_name: "" };
    const oversizedMetadata = JSON.stringify({
      ...emptyMetadata,
      resource_name: "x".repeat(
        64 * 1024 + 1 - Buffer.byteLength(JSON.stringify(emptyMetadata)),
      ),
    });
    expect(Buffer.byteLength(oversizedMetadata)).toBe(64 * 1024 + 1);
    server.use(
      http.get("https://oauth.example.com/large-header", () => {
        return HttpResponse.json(oauth.resourceMetadata, {
          headers: { "x-large": "x".repeat(17 * 1024) },
        });
      }),
      http.get("https://oauth.example.com/large-body", () => {
        return HttpResponse.text(oversizedMetadata, {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const header = await oauth.start(
      "https://oauth.example.com/large-header",
      [400],
    );
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.4.4",
      "8.8.8.8",
    ]);
    const body = await oauth.start(
      "https://oauth.example.com/large-body",
      [400],
    );

    expect(header.status).toBe(400);
    expect(header.body).toStrictEqual(
      automaticOAuthFailure(
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID,
      ),
    );
    expect(body.status).toBe(400);
    expect(body.body).toStrictEqual(
      automaticOAuthFailure(
        CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID,
      ),
    );
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "8.8.4.4",
      "8.8.8.8",
      "8.8.4.4",
      "8.8.8.8",
    ]);
    expect(oauth.provider.tokenBodies).toStrictEqual([]);
  });

  it("honors caller cancellation and the transport deadline", async () => {
    allowPublicHost("oauth.example.com");

    const cancelled = await requestProbeFailure({
      url: "https://oauth.example.com/metadata",
      method: "GET",
      cancel: true,
    });

    expect(cancelled.status).toBe(502);

    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 10_000 ? AbortSignal.abort() : undefined;
    });
    const timedOut = await requestProbeFailure({
      url: "https://oauth.example.com/metadata",
      method: "GET",
    });

    expect(timedOut.status).toBe(502);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([]);
  });
});
