import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import { afterEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import {
  API_TEST_CONNECTOR_CATALOG,
  catalogWithAuthMethod,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
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

  it("skips stored connectors whose runtime method is unavailable", async () => {
    const fixture = seedAuthenticatedFixture();
    const actor = createBddApi(context).user(fixture);
    const connectors = createConnectorBddApi(context);
    const catalog = createPublicConnectorCatalog(context, { isolatePg: true });
    const available = catalogWithAuthMethod(
      { connectorSlug: "openai", authMethodId: "api-token" },
      (method) => {
        return { ...method, id: "unavailable-method" };
      },
    );
    await catalog.publish(available);
    await connectGitlab(fixture);
    catalog.onCleanup(async () => {
      await connectors.deleteDefaultBuiltinConnectorAccount(actor, "gitlab");
    });
    await connectors.connectManualGrant(actor, "openai", "unavailable-method", {
      apiKey: "unavailable-method-secret",
    });
    catalog.onCleanup(async () => {
      await catalog.publish(available);
      await connectors.deleteDefaultBuiltinConnectorAccount(actor, "openai");
    });
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsMainContract,
    );
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.connectors).toHaveLength(1);
    expect(response.body.connectors[0]).toMatchObject({ slug: "gitlab" });
    expect(response.body.connectorProvidedBindings).not.toContainEqual(
      expect.objectContaining({ connectorSlug: "openai" }),
    );
    await catalog.cleanup();
  });
});
