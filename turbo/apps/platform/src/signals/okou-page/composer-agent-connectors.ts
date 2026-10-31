import { command, computed } from "ccstate";
import { agentConnectorAccessContract } from "@okouai/api-contracts/client/agent-connector-access";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import {
  connectorAuthorizationVersion$,
  reloadConnectorAgentAccess$,
} from "./settings/connector-agent-access.ts";

export const invalidateAgentConnectorAccess$ = command(
  ({ set }, _agentId: string) => {
    set(reloadConnectorAgentAccess$);
  },
);

export function composerAgentConnectors(agentId: string) {
  return computed(async (get) => {
    get(connectorAuthorizationVersion$);
    const createClient = get(apiClient$);
    const result = await accept(
      createClient(agentConnectorAccessContract).agent({
        params: { id: agentId },
      }),
      [200],
    );
    return result.body;
  });
}

export const subscribeAgentConnectorAccess$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyInvalidationLoop$,
      {
        topic: "composerAgentConnectorsChanged",
        invalidations: [reloadConnectorAgentAccess$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);
