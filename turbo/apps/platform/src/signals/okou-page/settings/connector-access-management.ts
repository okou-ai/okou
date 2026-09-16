import { command, computed, state } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { apiClient$ } from "../../api-client.ts";
import { agents$ } from "../../agent.ts";
import { accept } from "../../../lib/accept.ts";
import { userPermissionGrantsByAgentIfExists } from "../../permission-allow/permission-allow-signals.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "../agent-connector-authorizations.ts";
import { withCleanup } from "../../utils.ts";
import { firewallPermissionMetadataByConnector } from "../../firewall-permission-metadata.ts";
import type { PlatformUserPermissionGrant } from "../../connector-domain.ts";

export interface ConnectorAgentAccessRow {
  readonly agent: AgentResponse;
  readonly authorized: boolean;
  readonly grants: readonly PlatformUserPermissionGrant[];
}

interface ConnectorAgentAuthorizationRow {
  readonly agent: AgentResponse;
  readonly enabledConnectorSlugs: readonly ConnectorSlug[];
}

interface SetConnectorAgentAuthorizationParams {
  readonly agentId: string;
  readonly connectorSlug: ConnectorSlug;
  readonly authorized: boolean;
}

const managedConnectorAccessSlugState$ = state<ConnectorSlug | null>(null);
const connectorAccessManagementSearchState$ = state("");
const connectorAccessManagementPermissionAgentIdState$ = state<string | null>(
  null,
);

export const managedConnectorAccessSlug$ = computed((get) => {
  return get(managedConnectorAccessSlugState$);
});

export const connectorAccessManagementSearch$ = computed((get) => {
  return get(connectorAccessManagementSearchState$);
});

export const connectorAccessManagementPermissionAgentId$ = computed((get) => {
  return get(connectorAccessManagementPermissionAgentIdState$);
});

export const setManagedConnectorAccessSlug$ = command(
  ({ set }, connectorSlug: ConnectorSlug | null) => {
    set(managedConnectorAccessSlugState$, connectorSlug);
  },
);

export const closeConnectorAccessManagement$ = command(({ set }) => {
  set(managedConnectorAccessSlugState$, null);
  set(connectorAccessManagementSearchState$, "");
  set(connectorAccessManagementPermissionAgentIdState$, null);
});

export const setConnectorAccessManagementSearch$ = command(
  ({ set }, search: string) => {
    set(connectorAccessManagementSearchState$, search);
  },
);

export const setConnectorAccessManagementPermissionAgentId$ = command(
  ({ set }, agentId: string | null) => {
    set(connectorAccessManagementPermissionAgentIdState$, agentId);
  },
);

export const connectorAgentAuthorizations$ = computed(
  async (get): Promise<readonly ConnectorAgentAuthorizationRow[]> => {
    const allAgents = await get(agents$);
    const rows = await Promise.all(
      allAgents.map(
        async (agent): Promise<ConnectorAgentAuthorizationRow | null> => {
          const authorizations = await get(
            agentConnectorAuthorizations({
              agentId: agent.agentId,
              missing: "null",
            }),
          );
          if (!authorizations) {
            return null;
          }
          return {
            agent,
            enabledConnectorSlugs: authorizations.enabledConnectorSlugs,
          };
        },
      ),
    );
    return rows.filter((row): row is ConnectorAgentAuthorizationRow => {
      return row !== null;
    });
  },
);

export const connectorAuthorizedAgentsBySlug$ = computed(
  async (
    get,
  ): Promise<ReadonlyMap<ConnectorSlug, readonly AgentResponse[]>> => {
    const authorizations = await get(connectorAgentAuthorizations$);
    const agentsBySlug = new Map<ConnectorSlug, AgentResponse[]>();
    for (const row of authorizations) {
      for (const connectorSlug of row.enabledConnectorSlugs) {
        const agents = agentsBySlug.get(connectorSlug) ?? [];
        agents.push(row.agent);
        agentsBySlug.set(connectorSlug, agents);
      }
    }
    return agentsBySlug;
  },
);

export const managedConnectorAgentAccessRows$ = computed(
  async (get): Promise<readonly ConnectorAgentAccessRow[]> => {
    const connectorSlug = get(managedConnectorAccessSlug$);
    if (!connectorSlug) {
      return [];
    }
    const authorizations = await get(connectorAgentAuthorizations$);
    const rows = await Promise.all(
      authorizations.map(
        async ({
          agent,
          enabledConnectorSlugs,
        }): Promise<ConnectorAgentAccessRow | null> => {
          const authorized = enabledConnectorSlugs.includes(connectorSlug);
          let grants: readonly PlatformUserPermissionGrant[] = [];
          if (authorized) {
            const loadedGrants = await get(
              userPermissionGrantsByAgentIfExists({ agentId: agent.agentId }),
            );
            if (loadedGrants === null) {
              return null;
            }
            grants = loadedGrants;
          }
          return {
            agent,
            authorized,
            grants,
          };
        },
      ),
    );
    return rows.filter((row): row is ConnectorAgentAccessRow => {
      return row !== null;
    });
  },
);

export const managedConnectorFirewallPermissionMetadata$ = computed(
  async (get) => {
    const connectorSlug = get(managedConnectorAccessSlug$);
    if (!connectorSlug) {
      return null;
    }
    return await get(firewallPermissionMetadataByConnector({ connectorSlug }));
  },
);

export const setConnectorAgentAuthorization$ = command(
  async (
    { get, set },
    params: SetConnectorAgentAuthorizationParams,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(apiClient$)(userConnectorsContract);
    await withCleanup(
      accept(
        client.update({
          params: { id: params.agentId },
          body: {
            enabledConnectorSlugs: [params.connectorSlug],
            operation: params.authorized ? "add" : "remove",
          },
          fetchOptions: { signal },
        }),
        [200],
      ),
      () => {
        set(reloadAgentConnectorAuthorizations$);
      },
    );
    signal.throwIfAborted();
    await get(managedConnectorAgentAccessRows$);
    signal.throwIfAborted();
  },
);
