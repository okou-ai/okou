import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { agentConnectorAccessContract } from "@okouai/api-contracts/contracts/agent-connector-access";
import {
  customConnectorByIdContract,
  customConnectorProposalContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";
import { connectorAccountRoutes } from "../connector-accounts";
import { agentConnectorAccessRoutes } from "../agent-connector-access";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorProposalRoutes } from "../custom-connectors-proposal";

const context = testContext();
const trackCleanup = createFixtureTracker<() => Promise<void>>(
  async (action) => {
    await action();
  },
);

test("agent connector grants stay scoped to the signed-in user", async () => {
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
  const client = setupApp({ context, routes: agentConnectorAccessRoutes })(
    agentConnectorAccessContract,
  );
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
    ...agentConnectorAccessRoutes,
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
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: false,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
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
    client(agentConnectorAccessContract).agent({
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
