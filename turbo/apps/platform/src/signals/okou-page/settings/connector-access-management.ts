import { command, computed, state } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { agents$ } from "../../agent.ts";
import { connectorAgentAccess$ } from "./connector-agent-access.ts";
import { createConnectorPermissionsSignals } from "./connector-permissions.ts";

import { pageSignal$ } from "../../page-signal.ts";
interface ConnectorAgentAuthorizationRow {
  readonly agent: AgentResponse;
  readonly enabledConnectorSlugs: readonly ConnectorSlug[];
}

const managedConnectorAccessSlugState$ = state<ConnectorSlug | null>(null);

export const managedConnectorAccessSlug$ = computed((get) => {
  return get(managedConnectorAccessSlugState$);
});

export const setManagedConnectorAccessSlug$ = command(
  async (
    { get, set },
    connectorSlug: ConnectorSlug | null,
    signal: AbortSignal,
  ) => {
    const enabled =
      connectorSlug !== null &&
      (await get(featureSwitches$))[
        FeatureSwitchKey.ConnectorChatAccountAccess
      ];
    signal.throwIfAborted();
    const current = get(managedConnectorAccessSignals$);
    if (current) {
      set(current.close$);
    }
    set(managedConnectorAccessSlugState$, connectorSlug);
    const next = get(managedConnectorAccessSignals$);
    if (next) {
      set(next.open$, get(pageSignal$));
    }
  },
);

export const closeConnectorAccessManagement$ = command(({ get, set }) => {
  const current = get(managedConnectorAccessSignals$);
  if (current) {
    set(current.memberPermissions.close$);
  }
  set(managedConnectorAccessSlugState$, null);
});

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

export const managedConnectorAccessSignals$ = computed((get) => {
  const connectorSlug = get(managedConnectorAccessSlug$);
  return connectorSlug
    ? createConnectorPermissionsSignals(
        { target: { kind: "builtin", connectorSlug }, label: connectorSlug },
        closeConnectorAccessManagement$,
      )
    : null;
});
