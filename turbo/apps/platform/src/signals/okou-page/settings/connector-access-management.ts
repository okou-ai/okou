import { command, computed, state } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { apiClient$ } from "../../api-client.ts";
import { agents$ } from "../../agent.ts";
import { accept } from "../../../lib/accept.ts";
import { userPermissionGrantsByAgentIfExists } from "../../permission-allow/permission-allow-signals.ts";
import { reloadAgentConnectorAuthorizations$ } from "../agent-connector-authorizations.ts";
import { withCleanup } from "../../utils.ts";
import { firewallPermissionMetadataByConnector } from "../../firewall-permission-metadata.ts";
import type { PlatformUserPermissionGrant } from "../../connector-domain.ts";
import { connectorAgentAccess$ } from "./connector-agent-access.ts";

export interface ConnectorAgentAccessRow {
  readonly agent: AgentResponse;
  readonly authorized: boolean;
}

interface ConnectorAgentAuthorizationRow {
  readonly agent: AgentResponse;
  readonly enabledConnectorSlugs: readonly ConnectorSlug[];
}

const managedConnectorAccessSlugState$ = state<ConnectorSlug | null>(null);
const connectorAccessManagementSearchState$ = state("");

export const managedConnectorAccessSlug$ = computed((get) => {
  return get(managedConnectorAccessSlugState$);
});

export const connectorAccessManagementSearch$ = computed((get) => {
  return get(connectorAccessManagementSearchState$);
});

export const setManagedConnectorAccessSlug$ = command(
  ({ set }, connectorSlug: ConnectorSlug | null) => {
    set(managedConnectorAccessSlugState$, connectorSlug);
  },
);

export const closeConnectorAccessManagement$ = command(({ set }) => {
  set(managedConnectorAccessSlugState$, null);
});

export const setConnectorAccessManagementSearch$ = command(
  ({ set }, search: string) => {
    set(connectorAccessManagementSearchState$, search);
  },
);

export const connectorAgentAuthorizations$ = computed(
  async (get): Promise<readonly ConnectorAgentAuthorizationRow[]> => {
    const [allAgents, access] = await Promise.all([
      get(agents$),
      get(connectorAgentAccess$),
    ]);
    const slugsByAgent = new Map<string, ConnectorSlug[]>();
    const visibleAgentIds = new Set(access.visibleAgentIds);
    for (const { agentId, connectorSlug } of access.builtin) {
      const slugs = slugsByAgent.get(agentId) ?? [];
      slugs.push(connectorSlug);
      slugsByAgent.set(agentId, slugs);
    }
    return allAgents
      .filter((agent) => {
        return visibleAgentIds.has(agent.agentId);
      })
      .map((agent) => {
        return {
          agent,
          enabledConnectorSlugs: slugsByAgent.get(agent.agentId) ?? [],
        };
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

function createManagedConnectorAccessSignals(connectorSlug: ConnectorSlug) {
  const searchState$ = state("");
  const permissionAgentIdState$ = state<string | null>(null);
  const search$ = computed((get) => {
    return get(searchState$);
  });
  const permissionAgentId$ = computed((get) => {
    return get(permissionAgentIdState$);
  });
  const rows$ = computed(
    async (get): Promise<readonly ConnectorAgentAccessRow[]> => {
      const authorizations = await get(connectorAgentAuthorizations$);
      return authorizations.map(({ agent, enabledConnectorSlugs }) => {
        return {
          agent,
          authorized: enabledConnectorSlugs.includes(connectorSlug),
        };
      });
    },
  );
  const metadata$ = computed((get) => {
    return get(firewallPermissionMetadataByConnector({ connectorSlug }));
  });
  const permissionGrants$ = computed(
    async (get): Promise<readonly PlatformUserPermissionGrant[] | null> => {
      const agentId = get(permissionAgentId$);
      return agentId
        ? await get(userPermissionGrantsByAgentIfExists({ agentId }))
        : null;
    },
  );
  const setSearch$ = command(({ set }, search: string) => {
    set(searchState$, search);
  });
  const setPermissionAgentId$ = command(({ set }, agentId: string | null) => {
    set(permissionAgentIdState$, agentId);
  });
  const setAuthorization$ = command(
    async (
      { get, set },
      params: { readonly agentId: string; readonly authorized: boolean },
      signal: AbortSignal,
    ): Promise<void> => {
      const client = get(apiClient$)(userBuiltinConnectorsContract);
      await withCleanup(
        accept(
          client.update({
            params: { id: params.agentId },
            body: {
              enabledConnectorSlugs: [connectorSlug],
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
      await get(rows$);
      signal.throwIfAborted();
    },
  );
  return {
    rows$,
    metadata$,
    permissionGrants$,
    search$,
    permissionAgentId$,
    setSearch$,
    setPermissionAgentId$,
    setAuthorization$,
  };
}

export type ManagedConnectorAccessSignals = ReturnType<
  typeof createManagedConnectorAccessSignals
>;

export const managedConnectorAccessSignals$ = computed((get) => {
  const connectorSlug = get(managedConnectorAccessSlug$);
  return connectorSlug
    ? createManagedConnectorAccessSignals(connectorSlug)
    : null;
});
