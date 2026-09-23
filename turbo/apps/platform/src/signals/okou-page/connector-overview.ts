import { command, computed, state } from "ccstate";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  customConnectorsContract,
  isIntegrationManagedCustomConnector,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { userPreferenceChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$, setAblyPayloadLoop$ } from "../realtime.ts";

const reloadVersion$ = state(0);
export const invalidateConnectorOverview$ = command(({ set }) => {
  set(reloadVersion$, (version) => {
    return version + 1;
  });
});
const reloadFromRealtime$ = command(({ set }): boolean => {
  set(invalidateConnectorOverview$);
  return false;
});
const reloadAfterPreferenceChange$ = command(
  ({ set }, payload: unknown): boolean => {
    const parsed = userPreferenceChangedPayloadSchema.safeParse(payload);
    if (
      parsed.success &&
      parsed.data.kinds.includes("cloudBrowserEnabledByDefault")
    ) {
      set(invalidateConnectorOverview$);
    }
    return false;
  },
);

export const connectorOverview$ = computed(async (get) => {
  get(reloadVersion$);
  const createClient = get(apiClient$);
  const result = await accept(
    createClient(connectorOverviewContract).overview(),
    [200, 404],
  );
  if (result.status === 200) {
    return result.body;
  }

  // A newly promoted App may reach an older API during rollout or rollback.
  // Remove this bridge after those API versions leave serving and rollback.
  const [catalog, custom, summaries, hosts, preferences] = await Promise.all([
    accept(createClient(connectorCatalogContract).status(), [200]),
    accept(createClient(customConnectorsContract).list(), [200]),
    accept(createClient(connectorAccountsContract).summaries(), [200]),
    accept(createClient(computerUseHostsContract).list({}), [200, 403]),
    accept(createClient(userPreferencesContract).get(), [200]),
  ]);
  const connectedBuiltin = catalog.body.connectors.filter((connector) => {
    return connector.connected;
  });
  const connectedCustom = custom.body.connectors.filter((connector) => {
    return connector.connected;
  });
  const builtinSlugs = new Set(
    connectedBuiltin.map((connector) => {
      return connector.slug;
    }),
  );
  const customIds = new Set(
    connectedCustom.map((connector) => {
      return connector.id;
    }),
  );
  return {
    builtinConnectors: connectedBuiltin.map((connector) => {
      return {
        slug: connector.slug,
        label: connector.label,
        icon: connector.icon,
        hasPermissions: connector.permissionSummary.hasPermissions,
      };
    }),
    customConnectors: connectedCustom.map((connector) => {
      return {
        id: connector.id,
        slug: connector.slug,
        displayName: connector.displayName,
        permissionBundleRef: connector.permissionBundleRef ?? null,
        integrationManaged: isIntegrationManagedCustomConnector(connector),
      };
    }),
    accountSummaries: summaries.body.summaries
      .filter((summary) => {
        return summary.target.kind === "builtin"
          ? builtinSlugs.has(summary.target.connectorSlug)
          : customIds.has(summary.target.customConnectorId);
      })
      .map((summary) => {
        return {
          target: summary.target,
          accountCount: summary.accountCount,
          attentionCount: summary.attentionCount,
          defaultConnection: summary.defaultConnection
            ? {
                id: summary.defaultConnection.id,
                authMethod: summary.defaultConnection.authMethod,
                displayName: summary.defaultConnection.displayName,
                externalId: summary.defaultConnection.externalId,
                externalUsername: summary.defaultConnection.externalUsername,
                externalEmail: summary.defaultConnection.externalEmail,
                connectionStatus: summary.defaultConnection.connectionStatus,
              }
            : null,
        };
      }),
    computerUseHosts:
      hosts.status === 200
        ? hosts.body.hosts.map((host) => {
            return {
              id: host.id,
              hostName: host.hostName ?? host.displayName,
              displayName: host.displayName,
              lastSeenAt: host.lastSeenAt,
              status: host.status,
            };
          })
        : [],
    cloudBrowserEnabledByDefault: preferences.body.cloudBrowserEnabledByDefault,
  };
});

export const subscribeConnectorOverview$ = command(
  ({ set }, signal: AbortSignal) => {
    for (const topic of [
      "connector:changed",
      "customConnectorListChanged",
      "computerUseHostsChanged",
    ]) {
      set(setAblyLoop$, { topic, loopCommand$: reloadFromRealtime$ }, signal);
    }
    set(
      setAblyPayloadLoop$,
      {
        topic: "userPreferenceChanged",
        loopCommand$: reloadAfterPreferenceChange$,
      },
      signal,
    );
  },
);
