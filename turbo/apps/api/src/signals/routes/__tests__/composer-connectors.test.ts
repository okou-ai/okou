import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { composerConnectorsContract } from "@okouai/api-contracts/contracts/composer-connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";
import { composerConnectorsRoutes } from "../composer-connectors";

const context = testContext({ connectorCatalog: true });

test("composer overview and Agent grants stay scoped to the signed-in user", async () => {
  const mocks = createRouteMocks(context);
  const headers = { authorization: "Bearer clerk-session" };
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  context.mocks.s3.send.mockResolvedValue({});

  const created = await accept(
    setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
      headers,
      body: { visibility: "private" },
    }),
    [201],
  );
  const client = setupApp({ context, routes: composerConnectorsRoutes })(
    composerConnectorsContract,
  );
  const overview = await accept(client.overview({ headers }), [200]);
  expect(overview.body.builtinConnectors).toEqual([]);
  expect(overview.body.customConnectors).toEqual([]);
  expect(overview.body.accountSummaries).toEqual([]);
  expect(overview.body.computerUseHosts).toEqual([]);
  expect(typeof overview.body.cloudBrowserEnabledByDefault).toBe("boolean");

  const grants = await accept(
    client.agent({ headers, params: { id: created.body.agentId } }),
    [200],
  );
  expect(grants.body).toEqual({
    enabledConnectorSlugs: [],
    customConnectorIds: [],
  });

  await accept(
    setupApp({ context, routes: agentsRoutes })(
      userBuiltinConnectorsContract,
    ).update({
      headers,
      params: { id: created.body.agentId },
      body: { enabledConnectorSlugs: ["github"] },
    }),
    [200],
  );
  const authorized = await accept(
    client.agent({ headers, params: { id: created.body.agentId } }),
    [200],
  );
  expect(authorized.body.enabledConnectorSlugs).toContain("github");

  const missing = await client.agent({
    headers,
    params: { id: randomUUID() },
  });
  expect(missing.status).toBe(404);

  mocks.clerk.session(`user_${randomUUID()}`, orgId);
  const anotherUser = await client.agent({
    headers,
    params: { id: created.body.agentId },
  });
  expect(anotherUser.status).toBe(404);
});
