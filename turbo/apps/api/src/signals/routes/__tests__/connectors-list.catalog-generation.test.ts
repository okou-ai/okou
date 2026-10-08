import { randomUUID } from "node:crypto";

import {
  builtinConnectorManualGrantContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";

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

describe("GET /api/connectors", () => {
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
    await connectors.connectManualGrant(actor, "openai", "unavailable-method", {
      apiKey: "unavailable-method-secret",
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
  });
});
