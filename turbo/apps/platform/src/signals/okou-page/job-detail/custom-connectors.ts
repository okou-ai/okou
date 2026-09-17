import { command, computed } from "ccstate";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { apiClient$ } from "../../api-client.ts";
import { withCleanup } from "../../utils.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$ } from "./detail.ts";
import {
  customConnectorAuthorizationReloadVersion$,
  reloadCustomConnectorAuthorizedAgents$,
} from "../settings/custom-connectors.ts";

// ---------------------------------------------------------------------------
// Per-agent custom connector authorization — mirrors connectors.ts but keyed
// on UUIDs from the org_custom_connectors table (not the built-in enum).
// ---------------------------------------------------------------------------

export const agentCustomConnectorGrants$ = computed(
  async (get): Promise<readonly AgentCustomConnectorGrant[]> => {
    get(customConnectorAuthorizationReloadVersion$);
    const detail = await get(agentDetail$);
    if (!detail?.agentId) {
      return [];
    }
    const client = get(apiClient$)(agentCustomConnectorsContract);
    const result = await accept(
      client.get({ params: { id: detail.agentId } }),
      [200],
    );
    return result.body.grants;
  },
);

export const agentAddedCustomConnectors$ = computed(
  async (get): Promise<string[]> => {
    return (await get(agentCustomConnectorGrants$)).map((grant) => {
      return grant.customConnectorId;
    });
  },
);

export const toggleAgentCustomConnector$ = command(
  async (
    { get, set },
    id: string,
    checked: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }
    const client = get(apiClient$)(agentCustomConnectorsContract);
    await withCleanup(
      accept(
        client.update({
          params: { id: detail.agentId },
          body: {
            grants: [{ customConnectorId: id, permissionNames: [] }],
            operation: checked ? "add" : "remove",
          },
          fetchOptions: { signal },
        }),
        [200],
      ),
      () => {
        set(reloadCustomConnectorAuthorizedAgents$);
      },
    );
    signal.throwIfAborted();
    await get(agentCustomConnectorGrants$);
    signal.throwIfAborted();
  },
);
