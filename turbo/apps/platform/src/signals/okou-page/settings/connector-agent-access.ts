import { command, computed, state } from "ccstate";
import {
  connectorAgentAccessContract,
  type ConnectorAgentAccess,
} from "@okouai/api-contracts/contracts/connector-agent-access";

import { apiClient$ } from "../../api-client.ts";
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
      [200],
    );
    return result.body;
  },
);
