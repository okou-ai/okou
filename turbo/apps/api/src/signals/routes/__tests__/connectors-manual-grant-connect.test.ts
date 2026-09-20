import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  CLIENT_TYPE_APP,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorsBySlugContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import {
  readConnectorCredentialStorageState,
  requestSetConnectorVariableOwner,
  seedConnectorStorageRow,
  seedOwnedConnectorSecret,
} from "./helpers/connector-credential-storage-state";
import { createRouteMocks } from "./helpers/route-test";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { featureSwitchesRoutes } from "../feature-switches";

const TEST_APP_ROUTES = Object.freeze([
  ...builtinConnectorsRoutes,
  ...featureSwitchesRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

const CONNECTOR_SLUGS_TO_CLEAN_UP = [
  "openai",
  "zendesk",
  "insforge",
  "lark",
  "test-oauth",
  "gitlab",
  "bentoml",
  "github",
] as const;

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function cliAuthHeaders() {
  return {
    ...authHeaders(),
    [CLIENT_TYPE_HEADER]: CLIENT_TYPE_CLI,
  };
}

function appAuthHeaders() {
  return {
    ...authHeaders(),
    [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
  };
}

function featureSwitchesClient() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

function seedAuthenticatedFixture(): AuthenticatedFixture {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function updateFeatureSwitches(
  fixture: AuthenticatedFixture,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    featureSwitchesClient().update({
      headers: authHeaders(),
      body: { switches },
    }),
    [200],
  );
}

async function deleteFeatureSwitches(
  fixture: AuthenticatedFixture,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    featureSwitchesClient().delete({ headers: authHeaders() }),
    [200],
  );
}

async function deleteConnector(
  fixture: AuthenticatedFixture,
  connectorSlug: (typeof CONNECTOR_SLUGS_TO_CLEAN_UP)[number],
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const client = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  while (true) {
    const listed = await accept(
      client.connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug, limit: 50 },
      }),
      [200],
    );
    if (listed.body.connections.length === 0) {
      return;
    }
    for (const connection of listed.body.connections) {
      await accept(
        client.delete({
          headers: authHeaders(),
          params: { connectionId: connection.id },
          body: { target: { kind: "builtin", connectorSlug } },
        }),
        [200, 404],
      );
    }
  }
}

async function cleanupFixture(fixture: AuthenticatedFixture): Promise<void> {
  await deleteFeatureSwitches(fixture);
  for (const connectorSlug of CONNECTOR_SLUGS_TO_CLEAN_UP) {
    await deleteConnector(fixture, connectorSlug);
  }
}

async function readConnector(
  fixture: AuthenticatedFixture,
  connectorSlug: (typeof CONNECTOR_SLUGS_TO_CLEAN_UP)[number],
) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return await accept(
    setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsBySlugContract,
    ).get({
      params: { connectorSlug },
      headers: authHeaders(),
    }),
    [200],
  );
}

describe("POST /api/connectors/:connectorSlug/manual-grant", () => {
  const fixtures: AuthenticatedFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await cleanupFixture(fixture);
      }
    }
  });

  function seedFixture(): AuthenticatedFixture {
    const fixture = seedAuthenticatedFixture();
    fixtures.push(fixture);
    return fixture;
  }

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );
    const response = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { apiKey: "sk-test" },
        },
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );
    const response = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { apiKey: "sk-test" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects requests without a selected auth method", async () => {
    await seedFixture();
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });

    const response = await app.request("/api/connectors/openai/manual-grant", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ values: { apiKey: "sk-test" } }),
    });

    expect(response.status).toBe(400);
  });

  it("accepts server-authored identity syntax before catalog rejection", async () => {
    await seedFixture();
    const connectorSlug = "server-authored-connector";
    const authMethod = "server-authored-method";
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug },
        body: {
          authMethod,
          account: { intent: "add" },
          values: { apiKey: "secret" },
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message: `${connectorSlug} connector is not supported`,
      code: "BAD_REQUEST",
    });
    const list = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorsMainContract,
      ).list({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(list.body.connectors).not.toContainEqual(
      expect.objectContaining({ slug: connectorSlug }),
    );
  });

  it("rejects invalid server-authored identity syntax at the contract", async () => {
    await seedFixture();
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });

    const response = await app.request(
      "/api/connectors/invalid_ref/manual-grant",
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ authMethod: "api-token", values: {} }),
      },
    );

    expect(response.status).toBe(400);
  });

  it("allows unlabeled additions before optional post-connect naming", async () => {
    await seedFixture();
    const manualClient = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );
    const noAuthClient = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorNoAuthGrantContract,
    );

    const manual = await accept(
      manualClient.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { apiKey: "sk-unlabeled" },
        },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(manual.body).toMatchObject({
      slug: "openai",
      connectionStatus: "connected",
    });

    const noAuth = await accept(
      noAuthClient.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
        },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(noAuth.body.error.message).toContain(
      "openai api-token auth method does not use a no-auth grant",
    );

    const list = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorsMainContract,
      ).list({ headers: authHeaders() }),
      [200],
    );
    expect(list.body.connectors).toContainEqual(
      expect.objectContaining({
        slug: "openai",
        connectionStatus: "connected",
      }),
    );
  });

  it("stores App manual grants in connector-owned state", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { apiKey: " sk-test\n" },
        },
        headers: appAuthHeaders(),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      slug: "openai",
      authMethod: "api-token",
    });
    expect(typeof response.body.id).toBe("string");
    expect(response.body.createdAt).not.toBe("1970-01-01T00:00:00.000Z");
    expect(response.body.updatedAt).not.toBe("1970-01-01T00:00:00.000Z");
    const stored = await readConnector(fixture, "openai");
    expect(stored.body).toMatchObject({
      slug: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("accepts CLI add and reconnect while preserving sibling accounts", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const added = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Work" },
          values: { apiKey: "sk-first" },
        },
        headers: cliAuthHeaders(),
      }),
      [200],
    );

    const reconnected = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "reconnect", connectionId: added.body.id },
          values: { apiKey: "sk-reconnected" },
        },
        headers: cliAuthHeaders(),
      }),
      [200],
    );
    expect(reconnected.body.id).toBe(added.body.id);

    const sibling = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Personal" },
          values: { apiKey: "sk-sibling" },
        },
        headers: cliAuthHeaders(),
      }),
      [200],
    );
    expect(sibling.body.id).not.toBe(added.body.id);
    const accounts = await accept(
      setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      ).connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [200],
    );
    expect(
      accounts.body.connections.map(({ id }) => {
        return id;
      }),
    ).toStrictEqual(expect.arrayContaining([added.body.id, sibling.body.id]));
    expect(accounts.body.connections).toHaveLength(2);

    const missing = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "reconnect", connectionId: randomUUID() },
          values: { apiKey: "sk-missing" },
        },
        headers: cliAuthHeaders(),
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("Connector account not found");

    seedFixture();
    const wrongOwner = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "reconnect", connectionId: added.body.id },
          values: { apiKey: "sk-wrong-owner" },
        },
        headers: cliAuthHeaders(),
      }),
      [404],
    );
    expect(wrongOwner.body.error.message).toBe("Connector account not found");

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const wrongTarget = await accept(
      client.connect({
        params: { connectorSlug: "zendesk" },
        body: {
          authMethod: "api-token",
          account: { intent: "reconnect", connectionId: added.body.id },
          values: {
            apiToken: "zendesk-token",
            email: "support@example.com",
            subdomain: "example",
          },
        },
        headers: cliAuthHeaders(),
      }),
      [404],
    );
    expect(wrongTarget.body.error.message).toBe("Connector account not found");

    const stored = await readConnector(fixture, "openai");
    expect(stored.body.id).toBe(added.body.id);
  });

  it("allows concurrent first-account adds", async () => {
    await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );
    const requests = ["First", "Second"].map((displayName) => {
      return client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add", displayName },
          values: { apiKey: `sk-${displayName.toLowerCase()}` },
        },
        headers: authHeaders(),
      });
    });

    const responses = await Promise.all(requests);
    expect(
      responses
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([200, 200]);
  });

  it("connects Zendesk manual grant fields through the API", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "zendesk" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiToken: " zendesk\n-token ",
            email: " support@example.com ",
            subdomain: " example ",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      slug: "zendesk",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
    const stored = await readConnector(fixture, "zendesk");
    expect(stored.body.authMethod).toBe("api-token");

    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "zendesk",
      secretNames: ["ZENDESK_API_TOKEN"],
      variableNames: ["ZENDESK_EMAIL", "ZENDESK_SUBDOMAIN"],
    });
    expect(storageState.connector).toStrictEqual({
      id: response.body.id,
      storage_version: 1,
    });
    expect(storageState.secrets).toStrictEqual([
      expect.objectContaining({
        name: "ZENDESK_API_TOKEN",
        connector_id: response.body.id,
      }),
    ]);
    expect(storageState.variables).toStrictEqual(
      expect.arrayContaining([
        { name: "ZENDESK_EMAIL", connector_id: response.body.id },
        { name: "ZENDESK_SUBDOMAIN", connector_id: response.body.id },
      ]),
    );
  });

  it("rejects connector variable owners from another organization or user", async () => {
    const fixture = await seedFixture();
    const response = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorManualGrantContract,
      ).connect({
        params: { connectorSlug: "zendesk" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiToken: "zendesk-token",
            email: "support@example.com",
            subdomain: "example",
          },
        },
        headers: authHeaders(),
      }),
      [200],
    );
    const foreignOwners = [
      {
        orgId: `org_${randomUUID()}`,
        userId: fixture.userId,
      },
      {
        orgId: fixture.orgId,
        userId: `user_${randomUUID()}`,
      },
    ];

    for (const owner of foreignOwners) {
      const foreignConnectorId = await seedConnectorStorageRow(context, {
        ...owner,
        connectorSlug: "github",
        authMethod: "oauth",
        storageVersion: 1,
      });
      const ownerUpdate = await requestSetConnectorVariableOwner(context, {
        connectorId: foreignConnectorId,
        name: "ZENDESK_EMAIL",
        orgId: fixture.orgId,
        userId: fixture.userId,
      });
      expect(ownerUpdate.status).toBe(500);
    }

    await expect(
      readConnectorCredentialStorageState(context, {
        orgId: fixture.orgId,
        userId: fixture.userId,
        connectorSlug: "zendesk",
        variableNames: ["ZENDESK_EMAIL"],
      }),
    ).resolves.toMatchObject({
      variables: [{ name: "ZENDESK_EMAIL", connector_id: response.body.id }],
    });
  });

  it("deletes connector-owned secret and variable state on disconnect", async () => {
    const fixture = await seedFixture();
    await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorManualGrantContract,
      ).connect({
        params: { connectorSlug: "zendesk" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiToken: "zendesk-token",
            email: "support@example.com",
            subdomain: "example",
          },
        },
        headers: authHeaders(),
      }),
      [200],
    );

    await deleteConnector(fixture, "zendesk");

    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "zendesk",
      secretNames: ["ZENDESK_API_TOKEN"],
      variableNames: ["ZENDESK_EMAIL", "ZENDESK_SUBDOMAIN"],
    });
    expect(storageState.connector).toBeNull();
    expect(storageState.secrets).toStrictEqual([]);
    expect(storageState.variables).toStrictEqual([]);
  });

  it("stores colliding secret names under their owning connectors", async () => {
    const fixture = await seedFixture();
    const ownerId = await seedOwnedConnectorSecret(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "github",
      authMethod: "oauth",
      storageVersion: 1,
      name: "OPENAI_TOKEN",
      encryptedValue: "owner-value",
      description: "owner description",
    });
    const existingConnectionId = await seedConnectorStorageRow(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "openai",
      authMethod: "api-token",
      storageVersion: 1,
    });

    const response = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorManualGrantContract,
      ).connect({
        params: { connectorSlug: "openai" },
        headers: authHeaders(),
        body: {
          authMethod: "api-token",
          account: {
            intent: "reconnect",
            connectionId: existingConnectionId,
          },
          values: { apiKey: "replacement" },
        },
      }),
      [200],
    );

    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "openai",
      secretNames: ["OPENAI_TOKEN"],
    });
    expect(storageState.connector).toStrictEqual({
      id: response.body.id,
      storage_version: 1,
    });
    expect(storageState.secrets).toHaveLength(2);
    expect(storageState.secrets).toStrictEqual(
      expect.arrayContaining([
        {
          name: "OPENAI_TOKEN",
          connector_id: ownerId,
          encrypted_value: "owner-value",
          description: "owner description",
        },
        expect.objectContaining({
          name: "OPENAI_TOKEN",
          connector_id: response.body.id,
        }),
      ]),
    );

    await deleteConnector(fixture, "openai");
    const stateAfterDelete = await readConnectorCredentialStorageState(
      context,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        connectorSlug: "github",
        secretNames: ["OPENAI_TOKEN"],
      },
    );
    expect(stateAfterDelete.secrets?.[0]).toStrictEqual({
      name: "OPENAI_TOKEN",
      connector_id: ownerId,
      encrypted_value: "owner-value",
      description: "owner description",
    });
  });

  it("normalizes a full URL host field for manual grant connectors", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "insforge" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiKey: "ik_test-key",
            domain: "https://9ksx253h.us-west.insforge.app/api/",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      slug: "insforge",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
    const stored = await readConnector(fixture, "insforge");
    expect(stored.body.authMethod).toBe("api-token");
  });

  it("connects Lark app credentials through the API", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "lark" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            appId: " cli_a123 ",
            appSecret: " lark-app-secret\n",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      slug: "lark",
      authMethod: "api-token",
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
    });
    const stored = await readConnector(fixture, "lark");
    expect(stored.body.connectionStatus).toBe("connected");
  });

  it("reconnects Lark manual grant state through the API", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );
    await accept(
      client.connect({
        params: { connectorSlug: "lark" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            appId: "cli_old",
            appSecret: "old-lark-app-secret",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await accept(
      client.connect({
        params: { connectorSlug: "lark" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            appId: "cli_new",
            appSecret: "new-lark-app-secret",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const stored = await readConnector(fixture, "lark");
    expect(stored.body).toMatchObject({
      authMethod: "api-token",
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
    });
  });

  it("replaces stored manual grant state with new manual grant state", async () => {
    const fixture = await seedFixture();
    await updateFeatureSwitches(fixture, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );
    await accept(
      client.connect({
        params: { connectorSlug: "test-oauth" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiToken: "old-manual-test-oauth-token",
            inputVariable: "old-input-variable",
            tenantId: "old-tenant",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await accept(
      client.connect({
        params: { connectorSlug: "test-oauth" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiToken: "manual-test-oauth-token",
            inputVariable: "manual-input-variable",
            tenantId: "manual-tenant",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const getResponse = await readConnector(fixture, "test-oauth");
    expect(getResponse.body.authMethod).toBe("api-token");
  });

  it("replaces GitLab manual grant when optional fields are omitted", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );
    await accept(
      client.connect({
        params: { connectorSlug: "gitlab" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            accessToken: "old-token",
            host: "gitlab.example.com",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await accept(
      client.connect({
        params: { connectorSlug: "gitlab" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { accessToken: "new-token" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const stored = await readConnector(fixture, "gitlab");
    expect(stored.body).toMatchObject({
      slug: "gitlab",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("rejects private field names and identifies the public field id", async () => {
    await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { OPENAI_TOKEN: "sk-private" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("OPENAI_TOKEN");
    expect(response.body.error.message).not.toContain("sk-private");
  });

  it("rejects unknown public fields without echoing submitted values", async () => {
    await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiKey: "sk-test",
            unknownField: "secret-value-should-not-echo",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("unknownField");
    expect(response.body.error.message).not.toContain(
      "secret-value-should-not-echo",
    );
  });

  it("rejects missing required fields", async () => {
    await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {},
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("OPENAI_TOKEN");
  });

  it("rejects required fields that sanitize to empty without private field names", async () => {
    await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { apiKey: " \n\t " },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("OPENAI_TOKEN");
  });

  it("rejects connectors that do not support manual grant auth", async () => {
    await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "github" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {},
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "github connector does not have api-token auth method",
    );
  });

  it("rejects selected auth methods without manual grants", async () => {
    await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "stripe" },
        body: {
          authMethod: "oauth",
          account: { intent: "add" },
          values: { apiKey: "sk_test_key" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "stripe oauth auth method does not use a manual grant",
    );
  });

  it("allows feature-gated manual grant auth outside discovery", async () => {
    await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "bentoml" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiToken: "bento-token",
            endpoint: "https://example.bentoml.test",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      slug: "bentoml",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("rejects authored-hidden manual grant auth", async () => {
    await seedFixture();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "cloudflare" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {},
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "cloudflare connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("publishes one connector change event on successful replacement", async () => {
    const fixture = seedFixture();
    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    await accept(
      client.connect({
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { apiKey: "sk-test" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(context.mocks.ably.channelGet).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `user:${fixture.userId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "connector:changed",
      { connectorSlug: "openai" },
    );
  });

  it("allows feature-gated manual grant auth when enabled", async () => {
    const fixture = await seedFixture();
    await updateFeatureSwitches(fixture, {
      [FeatureSwitchKey.BentomlConnector]: true,
    });
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    );

    const response = await accept(
      client.connect({
        params: { connectorSlug: "bentoml" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: {
            apiToken: "bento-token",
            endpoint: "https://example.bentoml.test",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      slug: "bentoml",
      authMethod: "api-token",
    });
  });
});
