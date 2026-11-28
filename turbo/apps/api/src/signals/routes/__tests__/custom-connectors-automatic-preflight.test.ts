import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

type Registration = "cimd" | "dcr" | "none";

function uniqueHost(label = "automatic-mcp"): string {
  return `${label}-${randomUUID()}.example.test`;
}

function installProvider(
  registration: Registration,
  options: { readonly endpoint?: string; readonly resource?: string } = {},
) {
  if (registration === "cimd") {
    // CIMD client IDs must be HTTPS, so publish them from the hosted API origin.
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  }
  return mockAutomaticMcpOAuthProvider(context, {
    registration,
    authentication: registration === "none" ? "none" : "oauth",
    endpoint: options.endpoint ?? `https://${uniqueHost()}/server`,
    issuer: `https://${uniqueHost("issuer")}`,
    ...(options.resource === undefined ? {} : { resource: options.resource }),
  });
}

async function createAutomaticConnector(actor: ApiTestUser, endpoint: string) {
  return await connectors.createCustomConnector(actor, {
    kind: "mcp",
    displayName: `Automatic ${randomUUID().slice(0, 8)}`,
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

async function consent(
  provider: ReturnType<typeof installProvider>,
  authorizationUrl: string,
) {
  return await connectors.completeCustomConnectorOAuth2CallbackResult({
    state: stateOf(authorizationUrl),
    code: `code-${randomUUID()}`,
    iss: provider.issuer,
  });
}

/** Connects through the parent resource the provider advertises. */
async function connectWithParentResource(
  registration: "cimd" | "dcr",
  resourceOf: (origin: string) => string,
) {
  const origin = `https://${uniqueHost()}`;
  const endpoint = `${origin}/tenant/mcp?profile=full`;
  const resource = resourceOf(origin);
  const provider = installProvider(registration, { endpoint, resource });
  const admin = bdd.user();
  const connector = await createAutomaticConnector(admin, endpoint);
  const authorizationUrl = await connectors.startCustomConnectorOAuth2(
    admin,
    connector.id,
  );
  const completed = await consent(provider, authorizationUrl);
  const accounts = await connectors.listCustomConnectorAccounts(
    admin,
    connector.id,
  );
  return {
    probedEndpoints: [...new Set(provider.endpointRequests)],
    authorizationResource: new URL(authorizationUrl).searchParams.get(
      "resource",
    ),
    tokenResources: provider.tokenBodies.map((body) => {
      return body.get("resource");
    }),
    callbackStatus: completed.body.status,
    accounts: accounts.map((account) => {
      return {
        connectionStatus: account.connectionStatus,
        oauthScopes: account.oauthScopes,
      };
    }),
    expected: { endpoint, resource },
  };
}

async function rejectIncompatibleResource(
  resource: (origin: string) => string,
) {
  const origin = `https://${uniqueHost()}`;
  const endpoint = `${origin}/tenant/mcp`;
  const provider = installProvider("dcr", {
    endpoint,
    resource: resource(origin),
  });
  const admin = bdd.user();
  const connector = await createAutomaticConnector(admin, endpoint);
  const started = await connectors.requestStartCustomConnectorOAuth2(
    admin,
    connector.id,
    [400],
  );
  const accounts = await connectors.listCustomConnectorAccounts(
    admin,
    connector.id,
  );
  return {
    code: "error" in started.body ? started.body.error.code : null,
    tokenRequests: provider.tokenBodies.length,
    accounts: accounts.length,
  };
}

/** Starts an add or reconnect and completes consent when the provider needs it. */
async function connectAccount(
  provider: ReturnType<typeof installProvider>,
  actor: ApiTestUser,
  connectorId: string,
  account: Parameters<typeof connectors.requestStartCustomConnectorOAuth2>[3],
  registration: Registration,
): Promise<string> {
  const started = await connectors.requestStartCustomConnectorOAuth2(
    actor,
    connectorId,
    [200],
    account,
  );
  if (!("result" in started.body)) {
    throw new Error("Expected a successful start");
  }
  if (started.body.result === "connected") {
    expect(registration).toBe("none");
    return started.body.connectionId;
  }
  expect(registration).not.toBe("none");
  const completed = await consent(provider, started.body.authorizationUrl);
  expect(completed.body.status).toBe("success");
  const accounts = await connectors.listCustomConnectorAccounts(
    actor,
    connectorId,
  );
  const [only] = accounts;
  if (!only) {
    throw new Error("Expected a connected account");
  }
  return only.id;
}

async function reconnectOnlyExactAccount(registration: Registration) {
  const provider = installProvider(registration);
  const admin = bdd.user();
  const member = bdd.user({
    orgId: admin.orgId ?? undefined,
    orgRole: "org:member",
  });
  const outsider = bdd.user();
  const connector = await createAutomaticConnector(admin, provider.endpoint);
  const otherDefinition = await createAutomaticConnector(
    admin,
    provider.endpoint,
  );
  const accountId = await connectAccount(
    provider,
    admin,
    connector.id,
    { intent: "add" },
    registration,
  );

  const mismatched = [
    { actor: member, connectorId: connector.id, connectionId: accountId },
    { actor: outsider, connectorId: connector.id, connectionId: accountId },
    { actor: admin, connectorId: otherDefinition.id, connectionId: accountId },
    { actor: admin, connectorId: connector.id, connectionId: randomUUID() },
  ];
  const codes: (string | null)[] = [];
  for (const attempt of mismatched) {
    const response = await connectors.requestStartCustomConnectorOAuth2(
      attempt.actor,
      attempt.connectorId,
      [404],
      { intent: "reconnect", connectionId: attempt.connectionId },
    );
    codes.push("error" in response.body ? response.body.error.code : null);
  }
  expect(codes).toStrictEqual([
    "NOT_FOUND",
    "NOT_FOUND",
    "NOT_FOUND",
    "NOT_FOUND",
  ]);

  const reconnectedId = await connectAccount(
    provider,
    admin,
    connector.id,
    { intent: "reconnect", connectionId: accountId },
    registration,
  );
  expect(reconnectedId).toBe(accountId);
  await expect(
    connectors.listCustomConnectorAccounts(admin, connector.id),
  ).resolves.toMatchObject([{ id: accountId, connectionStatus: "connected" }]);
  await expect(
    connectors.listCustomConnectorAccounts(member, connector.id),
  ).resolves.toStrictEqual([]);
}

async function consentAfterDefinitionDeleted(registration: "cimd" | "dcr") {
  const provider = installProvider(registration);
  const admin = bdd.user();
  const connector = await createAutomaticConnector(admin, provider.endpoint);
  const authorizationUrl = await connectors.startCustomConnectorOAuth2(
    admin,
    connector.id,
  );
  await connectors.deleteCustomConnector(admin, connector.id);
  const completed = await consent(provider, authorizationUrl);
  const remaining = await connectors.listCustomConnectors(admin);
  return {
    callback: completed.body,
    tokenRequests: provider.tokenBodies.length,
    remaining,
  };
}

describe("Automatic custom connector preflight", () => {
  it("custom-connectors-automatic-preflight-003 rejects a protected resource on another origin before granting an account", async () => {
    await expect(
      rejectIncompatibleResource(() => {
        return `https://${uniqueHost("foreign-mcp")}/`;
      }),
    ).resolves.toStrictEqual({
      code: "MCP_OAUTH_DISCOVERY_INVALID",
      tokenRequests: 0,
      accounts: 0,
    });
  });

  it("custom-connectors-automatic-preflight-006 rejects a protected resource on a different path before granting an account", async () => {
    await expect(
      rejectIncompatibleResource((origin) => {
        return `${origin}/other`;
      }),
    ).resolves.toStrictEqual({
      code: "MCP_OAUTH_DISCOVERY_INVALID",
      tokenRequests: 0,
      accounts: 0,
    });
  });

  it("custom-connectors-automatic-preflight-001 connects cimd through a parent resource and keeps the transport query", async () => {
    const result = await connectWithParentResource("cimd", (origin) => {
      return `${origin}/tenant`;
    });
    expect(result).toStrictEqual({
      probedEndpoints: [result.expected.endpoint],
      authorizationResource: result.expected.resource,
      tokenResources: [result.expected.resource],
      callbackStatus: "success",
      accounts: [
        { connectionStatus: "connected", oauthScopes: ["read", "write"] },
      ],
      expected: result.expected,
    });
  });

  it("custom-connectors-automatic-preflight-002 connects dcr through an origin resource and keeps the transport query", async () => {
    const result = await connectWithParentResource("dcr", (origin) => {
      return origin;
    });
    expect(result).toStrictEqual({
      probedEndpoints: [result.expected.endpoint],
      authorizationResource: result.expected.resource,
      tokenResources: [result.expected.resource],
      callbackStatus: "success",
      accounts: [
        { connectionStatus: "connected", oauthScopes: ["read", "write"] },
      ],
      expected: result.expected,
    });
  });

  it("custom-connectors-automatic-preflight-011 keeps the exact endpoint query through discovery and connection", async () => {
    const endpoint = `https://${uniqueHost()}/server?lang=en&tag=a&tag=b&empty=&q=hello%20world&plus=a+b`;
    const provider = installProvider("dcr", { endpoint });
    const admin = bdd.user();
    const connector = await createAutomaticConnector(admin, endpoint);
    const started = await connectors.requestStartCustomConnectorOAuth2(
      admin,
      connector.id,
      [200],
    );
    if (
      !("result" in started.body) ||
      started.body.result !== "authorization"
    ) {
      throw new Error("Expected an authorization start");
    }
    const authorizationUrl = started.body.authorizationUrl;
    const completed = await consent(provider, authorizationUrl);
    expect(completed.body.status).toBe("success");
    expect([...new Set(provider.endpointRequests)]).toStrictEqual([endpoint]);
    expect(new URL(authorizationUrl).searchParams.get("resource")).toBe(
      endpoint,
    );
    expect(
      provider.tokenBodies.map((body) => {
        return body.get("resource");
      }),
    ).toStrictEqual([endpoint]);
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toHaveLength(1);
  });

  it("custom-connectors-automatic-preflight-012 reconnects a cimd account only for its exact user, org and definition", async () => {
    await expect(reconnectOnlyExactAccount("cimd")).resolves.toBeUndefined();
  });

  it("custom-connectors-automatic-preflight-013 reconnects a dcr account only for its exact user, org and definition", async () => {
    await expect(reconnectOnlyExactAccount("dcr")).resolves.toBeUndefined();
  });

  it("custom-connectors-automatic-preflight-014 reconnects a no-auth account only for its exact user, org and definition", async () => {
    await expect(reconnectOnlyExactAccount("none")).resolves.toBeUndefined();
  });

  it("custom-connectors-automatic-preflight-018 rejects cimd consent after the owner deletes the definition", async () => {
    await expect(consentAfterDefinitionDeleted("cimd")).resolves.toStrictEqual({
      callback: {
        status: "error",
        message: "Invalid OAuth state - please try again",
      },
      tokenRequests: 0,
      remaining: [],
    });
  });

  it("custom-connectors-automatic-preflight-019 rejects dcr consent after the owner deletes the definition", async () => {
    await expect(consentAfterDefinitionDeleted("dcr")).resolves.toStrictEqual({
      callback: {
        status: "error",
        message: "Invalid OAuth state - please try again",
      },
      tokenRequests: 0,
      remaining: [],
    });
  });

  it("custom-connectors-automatic-preflight-021 rejects consent for a reconnect account deleted after authorization starts", async () => {
    const provider = installProvider("dcr");
    const admin = bdd.user();
    const connector = await createAutomaticConnector(admin, provider.endpoint);
    const accountId = await connectAccount(
      provider,
      admin,
      connector.id,
      { intent: "add" },
      "dcr",
    );
    const authorizationUrl = await connectors.startCustomConnectorOAuth2(
      admin,
      connector.id,
      { intent: "reconnect", connectionId: accountId },
    );
    await connectors.deleteCustomConnectorAccount(
      admin,
      connector.id,
      accountId,
    );
    const completed = await consent(provider, authorizationUrl);
    expect(completed.body.status).toBe("error");
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toStrictEqual([]);
  });
});
