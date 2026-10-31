import { command, computed } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { isIntegrationManagedCustomConnector } from "@okouai/api-contracts/validators/custom-connectors";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";

import { agentCustomConnectorsContract } from "@okouai/api-contracts/client/agent-custom-connectors";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { apiClient$ } from "../../api-client.ts";
import { i18n } from "../../../i18n/index.ts";
import { withCleanup } from "../../utils.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$ } from "./detail.ts";
import {
  customConnectorAuthorizationReloadVersion$,
  reloadCustomConnectorAuthorizedAgents$,
} from "../settings/custom-connectors.ts";
import { requireCustomConnectorAccountReady } from "../settings/connector-accounts.ts";

const prepareJobCustomConnectorAccess$ = command(
  async (
    { get },
    connector: CustomConnectorResponse,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!isIntegrationManagedCustomConnector(connector)) {
      await requireCustomConnectorAccountReady(
        get(apiClient$),
        connector.id,
        signal,
      );
    }
  },
);

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
    connector: CustomConnectorResponse,
    checked: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    if (checked) {
      await set(prepareJobCustomConnectorAccess$, connector, signal);
      signal.throwIfAborted();
    }
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }
    const client = get(apiClient$)(agentCustomConnectorsContract);
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(
      accept(
        client.update({
          params: { id: detail.agentId },
          body: {
            grants: [{ customConnectorId: connector.id, permissionNames: [] }],
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
    toast.success(
      i18n.t(
        ($) => {
          return $.authorization.customConnectors.saved;
        },
        { ns: "agents" },
      ),
    );
  },
);
