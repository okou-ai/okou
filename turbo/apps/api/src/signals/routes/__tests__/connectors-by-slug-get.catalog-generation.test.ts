import { randomUUID } from "node:crypto";

import { builtinConnectorsBySlugContract } from "@okouai/api-contracts/contracts/connectors";

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

describe("GET /api/connectors/:connectorSlug", () => {
  it("returns 404 when the stored connector runtime method is unavailable", async () => {
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
    await connectors.connectManualGrant(actor, "openai", "unavailable-method", {
      apiKey: "unavailable-method-secret",
    });
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsBySlugContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
