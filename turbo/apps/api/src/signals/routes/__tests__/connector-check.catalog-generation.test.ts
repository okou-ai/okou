import {
  type ConnectorCheckRequest,
  connectorCheckContract,
} from "@okouai/api-contracts/contracts/connector-check";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";
import {
  API_TEST_CONNECTOR_CATALOG,
  catalogWithManualConnector,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
import { connectorCheckRoutes } from "../connector-check";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";

const TEST_APP_ROUTES = Object.freeze([
  ...connectorCheckRoutes,
  ...testCronCleanupSandboxesStateRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);

function client() {
  return setupApp({ context, routes: TEST_APP_ROUTES })(connectorCheckContract);
}

async function checkWithSession(
  actor: ApiTestUser,
  body: ConnectorCheckRequest,
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return await accept(
    client().check({
      headers: { authorization: "Bearer clerk-session" },
      body,
    }),
    [200],
  );
}

beforeEach(async () => {
  await setupApp({ context, routes: TEST_APP_ROUTES, isolatePg: true });
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.axiom.query.mockResolvedValue([]);
});

describe("POST /api/connectors/diagnostics/check", () => {
  it("ignores stale stored connectors that are absent from the catalog", async () => {
    const actor = bdd.user();
    const catalog = createPublicConnectorCatalog(context);
    const available = catalogWithManualConnector({
      connectorSlug: "removed-connector",
      authMethodId: "api",
    });
    await catalog.publish(available);
    await connectorsApi.connectManualGrant(actor, "removed-connector", "api", {
      credential: "removed-connector-secret",
    });
    catalog.onCleanup(async () => {
      await catalog.publish(available);
      await connectorsApi.deleteDefaultBuiltinConnectorAccount(
        actor,
        "removed-connector",
      );
    });
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);

    const response = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/okou-ai/okou",
    });

    expect(response.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorSlug: "github" },
    });
    await catalog.cleanup();
  });
});
