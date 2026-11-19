import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  customConnectorByIdContract,
  customConnectorProposalContract,
} from "@okouai/api-contracts/contracts/custom-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";
import { connectorAccountRoutes } from "../connector-accounts";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorProposalRoutes } from "../custom-connectors-proposal";

const context = testContext();
const trackCleanup = createFixtureTracker<() => Promise<void>>(
  async (action) => {
    await action();
  },
);

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
    client(agentCustomConnectorsContract).get({
      headers,
      params: { id: agent.body.agentId },
    }),
    [200],
  );
  expect(access.body.grants).toContainEqual(
    expect.objectContaining({ customConnectorId: connectorId }),
  );
  expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(`user:${userId}`);
  expect(context.mocks.ably.publish).toHaveBeenCalledWith(
    "composerAgentConnectorsChanged",
    { agentId: agent.body.agentId },
  );
});
