import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorScopeDiffContract,
  builtinConnectorsBySlugContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import { afterEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  invalidateApiTestConnectorCatalogCompatibility,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import {
  readConnectorCredentialStorageState,
  setConnectorDefaultState,
} from "./helpers/connector-credential-storage-state";

import { createRouteMocks } from "./helpers/route-test";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";

const context = testContext();
const mocks = createRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function seedAuthenticatedFixture(): AuthenticatedFixture {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function connectGitlab(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    ).connect({
      params: { connectorSlug: "gitlab" },
      body: {
        authMethod: "api-token",
        account: { intent: "add" },
        values: {
          accessToken: "gl-test-token",
          host: "gitlab.example.com",
        },
      },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function deleteConnector(
  fixture: AuthenticatedFixture,
  connectorSlug: "gitlab" | "openai" | "manual-mcp",
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const client = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  const accounts = await accept(
    client.connections({
      headers: authHeaders(),
      query: { kind: "builtin", connectorSlug },
    }),
    [200, 404],
  );
  if (accounts.status === 404) {
    return;
  }
  for (const account of accounts.body.connections) {
    await accept(
      client.delete({
        headers: authHeaders(),
        params: { connectionId: account.id },
        body: { target: { kind: "builtin", connectorSlug } },
      }),
      [200],
    );
  }
}

describe("GET /api/connectors", () => {
  const seededFixtures: AuthenticatedFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteConnector(fixture, "gitlab");
        await deleteConnector(fixture, "openai");
        await deleteConnector(fixture, "manual-mcp");
      }
    }
  });

  it("returns an empty connectors list", async () => {
    const fixture = seedAuthenticatedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsMainContract,
    );
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.connectors).toStrictEqual([]);
    expect(Array.isArray(response.body.connectorProvidedBindings)).toBeTruthy();
  });

  it("returns connectors created through the connector API", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectGitlab(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsMainContract,
    );
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.connectors).toContainEqual(
      expect.objectContaining({
        slug: "gitlab",
        authMethod: "api-token",
        connectionStatus: "connected",
      }),
    );
    expect(response.body.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "gitlab",
        namespace: "secrets",
        name: "GITLAB_TOKEN",
      }),
    );
  });

  it("lists HTTP and MCP accounts but exposes sandbox bindings only for HTTP connectors", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectGitlab(fixture);
    await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorManualGrantContract,
      ).connect({
        headers: authHeaders(),
        params: { connectorSlug: "manual-mcp" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { apiKey: "test-mcp-token" },
        },
      }),
      [200],
    );
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsMainContract,
    );
    const listed = await accept(client.list({ headers: authHeaders() }), [200]);
    expect(
      listed.body.connectors.map((connector) => {
        return connector.slug;
      }),
    ).toStrictEqual(expect.arrayContaining(["gitlab", "manual-mcp"]));
    expect(listed.body.connectorProvidedBindings).toStrictEqual([
      expect.objectContaining({
        connectorSlug: "gitlab",
        namespace: "vars",
        name: "GITLAB_HOST",
      }),
      expect.objectContaining({
        connectorSlug: "gitlab",
        namespace: "secrets",
        name: "GITLAB_TOKEN",
      }),
    ]);
  });

  it("projects only the default account for each connector target", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectGitlab(fixture);
    const state = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "gitlab",
    });
    const connectorId = state.connector?.id;
    if (!connectorId) {
      throw new Error("Expected a stored GitLab connector account");
    }
    await setConnectorDefaultState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorId,
      isDefault: false,
    });

    const response = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorsMainContract,
      ).list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      connectors: [],
      connectorProvidedBindings: [],
    });

    const detail = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorsBySlugContract,
      ).get({
        params: { connectorSlug: "gitlab" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(detail.body.error.code).toBe("NOT_FOUND");
  });

  it("keeps current-entry account reads available while full-snapshot scope reads reject unavailable compatibility", async () => {
    // Only this case-owned legacy compatibility generation becomes unavailable.
    // The accepted immutable current and entries remain intact.
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `legacy-list-unavailable-${randomUUID()}`,
    );
    await installApiTestConnectorCatalog();
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectGitlab(fixture);
    const accountClient = setupApp({
      context,
      routes: connectorAccountRoutes,
    })(connectorAccountsContract);
    const target = { kind: "builtin" as const, connectorSlug: "gitlab" };
    const connected = await accept(
      accountClient.connections({ headers: authHeaders(), query: target }),
      [200],
    );
    const [account] = connected.body.connections;
    if (!account) {
      throw new Error("Expected the connected GitLab account");
    }
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsMainContract,
    );
    const available = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(available.body.connectors).toStrictEqual([
      expect.objectContaining({
        id: account.id,
        slug: "gitlab",
        authMethod: "api-token",
        connectionStatus: "connected",
      }),
    ]);
    expect(available.body.connectorProvidedBindings).toStrictEqual([
      expect.objectContaining({
        connectorSlug: "gitlab",
        namespace: "vars",
        name: "GITLAB_HOST",
      }),
      expect.objectContaining({
        connectorSlug: "gitlab",
        namespace: "secrets",
        name: "GITLAB_TOKEN",
      }),
    ]);
    mockOptionalEnv("BOX_OAUTH_CLIENT_ID", undefined);
    await installApiTestConnectorCatalog();
    await invalidateApiTestConnectorCatalogCompatibility();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    expect(response.body).toStrictEqual(available.body);

    // Current-entry account readers retain the exact account and its status.
    const connections = await accept(
      accountClient.connections({ headers: authHeaders(), query: target }),
      [200],
    );
    expect(connections.body).toStrictEqual(connected.body);
    const connection = await accept(
      accountClient.connection({
        headers: authHeaders(),
        query: target,
        params: { connectionId: account.id },
      }),
      [200],
    );
    expect(connection.body).toStrictEqual(account);
    const impact = await accept(
      accountClient.deletionImpact({
        headers: authHeaders(),
        query: target,
        params: { connectionId: account.id },
      }),
      [200],
    );
    expect(impact.body).toStrictEqual({
      connectionId: account.id,
      explicitSelectionCount: 0,
      hasSibling: false,
    });

    // The nonexistent receipt and unchanged full-snapshot scope readers reject.
    const unavailableReads = await Promise.all([
      accept(
        accountClient.oauthCompletion({
          headers: authHeaders(),
          query: target,
          params: { attemptId: randomUUID() },
        }),
        [404],
      ),
      accept(
        accountClient.scopeDiff({
          headers: authHeaders(),
          query: { connectorSlug: "gitlab" },
          params: { connectionId: account.id },
        }),
        [404],
      ),
      accept(
        setupApp({ context, routes: builtinConnectorsRoutes })(
          builtinConnectorScopeDiffContract,
        ).getScopeDiff({
          headers: authHeaders(),
          params: { connectorSlug: "gitlab" },
        }),
        [404],
      ),
    ]);
    for (const result of unavailableReads) {
      expect(result.body.error.code).toBe("NOT_FOUND");
    }
    const selection = { target, connectionId: account.id };
    const inspected = await accept(
      accountClient.inspect({
        headers: authHeaders(),
        body: { selections: [selection] },
      }),
      [200],
    );
    expect(inspected.body.results).toStrictEqual([
      {
        kind: "available",
        ...selection,
        authMethod: account.authMethod,
        displayName: account.displayName,
        externalId: account.externalId,
        externalUsername: account.externalUsername,
        externalEmail: account.externalEmail,
        connectionStatus: account.connectionStatus,
        reconnectReason: account.reconnectReason,
      },
    ]);
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsMainContract,
    );
    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsMainContract,
    );
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
