import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorByIdContract,
  customConnectorProposalContract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorOverviewRoutes } from "../connector-overview";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorProposalRoutes } from "../custom-connectors-proposal";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";

const context = testContext({ connectorCatalog: true });
const trackCleanup = createFixtureTracker<() => Promise<void>>(
  async (action) => {
    await action();
  },
);

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
  const client = setupApp({ context, routes: connectorOverviewRoutes })(
    connectorOverviewContract,
  );
  const overview = await accept(client.overview({ headers }), [200]);
  expect(overview.body.builtinConnectors).toStrictEqual([]);
  expect(overview.body.customConnectors).toStrictEqual([]);
  expect(overview.body.accountSummaries).toStrictEqual([]);
  expect(overview.body.computerUseHosts).toStrictEqual([]);
  expect(typeof overview.body.cloudBrowserEnabledByDefault).toBe("boolean");

  const grants = await accept(
    client.agent({ headers, params: { id: created.body.agentId } }),
    [200],
  );
  expect(grants.body).toStrictEqual({
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

test("overview projects connected connector briefs and default accounts for one user", async () => {
  const mocks = createRouteMocks(context);
  const headers = { authorization: "Bearer clerk-session" };
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  const routes = [
    ...connectorOverviewRoutes,
    ...builtinConnectorsRoutes,
    ...customConnectorsRoutes,
    ...customConnectorsValuesSetRoutes,
    ...customConnectorsDeleteRoutes,
    ...connectorAccountRoutes,
  ];
  const client = setupApp({ context, routes });
  const builtin = await accept(
    client(builtinConnectorManualGrantContract).connect({
      headers,
      params: { connectorSlug: "gitlab" },
      body: {
        authMethod: "api-token",
        account: { intent: "add" },
        values: {
          accessToken: "gl-test-token",
          host: "gitlab.example.com",
        },
      },
    }),
    [200],
  );
  await trackCleanup(
    Promise.resolve(async () => {
      mocks.clerk.session(userId, orgId);
      await accept(
        client(connectorAccountsContract).delete({
          headers,
          params: { connectionId: builtin.body.id },
          body: { target: { kind: "builtin", connectorSlug: "gitlab" } },
        }),
        [200],
      );
    }),
  );
  const definition = await accept(
    client(customConnectorsContract).create({
      headers,
      body: {
        displayName: "Composer test connector",
        prefixTemplates: ["https://example.com/"],
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "none",
      },
    }),
    [201],
  );
  await trackCleanup(
    Promise.resolve(async () => {
      mocks.clerk.session(userId, orgId);
      await accept(
        client(customConnectorByIdContract).delete({
          headers,
          params: { id: definition.body.id },
        }),
        [204],
      );
    }),
  );
  const connected = await accept(
    client(customConnectorValuesContract).set({
      headers,
      params: { id: definition.body.id },
      body: { values: [], account: { intent: "add" } },
    }),
    [200],
  );
  const customAccountId = connected.body.connectedAccountId;
  if (!customAccountId) {
    throw new Error("Expected a connected custom account");
  }
  await trackCleanup(
    Promise.resolve(async () => {
      mocks.clerk.session(userId, orgId);
      await accept(
        client(connectorAccountsContract).delete({
          headers,
          params: { connectionId: customAccountId },
          body: {
            target: { kind: "custom", customConnectorId: definition.body.id },
          },
        }),
        [200],
      );
    }),
  );

  const overview = await accept(
    client(connectorOverviewContract).overview({ headers }),
    [200],
  );
  expect(overview.body.builtinConnectors).toContainEqual(
    expect.objectContaining({
      slug: "gitlab",
      label: expect.any(String),
      icon: expect.objectContaining({ url: expect.any(String) }),
      hasPermissions: expect.any(Boolean),
    }),
  );
  expect(overview.body.customConnectors).toContainEqual(
    expect.objectContaining({
      id: definition.body.id,
      slug: definition.body.slug,
      displayName: "Composer test connector",
      integrationManaged: false,
    }),
  );
  expect(overview.body.accountSummaries).toContainEqual(
    expect.objectContaining({
      target: { kind: "builtin", connectorSlug: "gitlab" },
      accountCount: 1,
      defaultConnection: expect.objectContaining({
        id: builtin.body.id,
        connectionStatus: "connected",
      }),
    }),
  );
  expect(overview.body.accountSummaries).toContainEqual(
    expect.objectContaining({
      target: { kind: "custom", customConnectorId: definition.body.id },
      accountCount: 1,
      defaultConnection: expect.objectContaining({ id: customAccountId }),
    }),
  );

  mocks.clerk.session(`user_${randomUUID()}`, orgId);
  const otherUser = await accept(
    client(connectorOverviewContract).overview({ headers }),
    [200],
  );
  expect(otherUser.body.builtinConnectors).toStrictEqual([]);
  expect(otherUser.body.customConnectors).toStrictEqual([]);
  expect(otherUser.body.accountSummaries).toStrictEqual([]);
});

test("a saved custom connector proposal invalidates the Agent access snapshot", async () => {
  const mocks = createRouteMocks(context);
  const headers = { authorization: "Bearer clerk-session" };
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  context.mocks.s3.send.mockResolvedValue({});
  const routes = [
    ...agentsRoutes,
    ...customConnectorProposalRoutes,
    ...connectorOverviewRoutes,
    ...connectorAccountRoutes,
    ...customConnectorsDeleteRoutes,
  ];
  const client = setupApp({ context, routes });
  const agent = await accept(
    client(agentsMainContract).create({
      headers,
      body: { visibility: "private" },
    }),
    [201],
  );
  context.mocks.ably.publish.mockClear();
  const saved = await accept(
    client(customConnectorProposalContract).save({
      headers,
      body: {
        proposal: {
          operation: "create",
          displayName: "Proposal connector",
          prefixTemplates: ["https://proposal.example.com/"],
          fields: [],
          headerInjections: [],
          queryInjections: [],
        },
        values: [],
        agentId: agent.body.agentId,
      },
    }),
    [200],
  );
  const connectorId = saved.body.connector.id;
  await trackCleanup(
    Promise.resolve(async () => {
      mocks.clerk.session(userId, orgId);
      const accounts = client(connectorAccountsContract);
      const listed = await accept(
        accounts.connections({
          headers,
          query: { kind: "custom", customConnectorId: connectorId },
        }),
        [200],
      );
      for (const account of listed.body.connections) {
        await accept(
          accounts.delete({
            headers,
            params: { connectionId: account.id },
            body: {
              target: { kind: "custom", customConnectorId: connectorId },
            },
          }),
          [200],
        );
      }
      await accept(
        client(customConnectorByIdContract).delete({
          headers,
          params: { id: connectorId },
        }),
        [204],
      );
    }),
  );

  expect(saved.body.authorizedAgentId).toBe(agent.body.agentId);
  const access = await accept(
    client(connectorOverviewContract).agent({
      headers,
      params: { id: agent.body.agentId },
    }),
    [200],
  );
  expect(access.body.customConnectorIds).toContain(connectorId);
  expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(`user:${userId}`);
  expect(context.mocks.ably.publish).toHaveBeenCalledWith(
    "composerAgentConnectorsChanged",
    { agentId: agent.body.agentId },
  );
});
