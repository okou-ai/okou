import { command, computed, state } from "ccstate";
import {
  connectorAgentAccessContract,
  type ConnectorAgentAccess,
} from "@okouai/api-contracts/contracts/connector-agent-access";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";

import { apiClient$ } from "../../api-client.ts";
import { agents$ } from "../../agent.ts";
import { accept } from "../../../lib/accept.ts";

const reloadVersion$ = state(0);

export const reloadConnectorAgentAccess$ = command(({ set }) => {
  set(reloadVersion$, (version) => {
    return version + 1;
  });
});

export const connectorAgentAccess$ = computed(
  async (get): Promise<ConnectorAgentAccess> => {
    get(reloadVersion$);
    const createClient = get(apiClient$);
    const result = await accept(
      createClient(connectorAgentAccessContract).get({ query: {} }),
      [200, 404],
    );
    if (result.status === 200) {
      return result.body;
    }

    // New App -> old API: remove this 404 bridge after older APIs are no longer
    // serving or retained as rollback targets (tracked by #36330).
    const visibleAgents = await get(agents$);
    const builtinClient = createClient(userBuiltinConnectorsContract);
    const customClient = createClient(agentCustomConnectorsContract);
    const rows = await Promise.all(
      visibleAgents.map(async (agent) => {
        const [builtin, custom] = await Promise.all([
          accept(
            builtinClient.get({ params: { id: agent.agentId } }),
            [200, 404],
          ),
          accept(
            customClient.get({ params: { id: agent.agentId } }),
            [200, 404],
          ),
        ]);
        return { agentId: agent.agentId, builtin, custom };
      }),
    );
    return {
      visibleAgentIds: rows
        .filter(({ builtin }) => {
          return builtin.status === 200;
        })
        .map(({ agentId }) => {
          return agentId;
        }),
      builtin: rows.flatMap(({ agentId, builtin }) => {
        return builtin.status === 200
          ? builtin.body.enabledConnectorSlugs.map((connectorSlug) => {
              return {
                connectorSlug,
                agentId,
              };
            })
          : [];
      }),
      custom: rows.flatMap(({ agentId, custom }) => {
        return custom.status === 200
          ? custom.body.grants.map((grant) => {
              return {
                connectorId: grant.customConnectorId,
                agentId,
                permissionNames: grant.permissionNames,
              };
            })
          : [];
      }),
    };
  },
);
