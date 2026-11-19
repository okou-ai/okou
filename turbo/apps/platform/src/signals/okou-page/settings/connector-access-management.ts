import { command, computed, state } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { createConnectorPermissionsSignals } from "./connector-permissions.ts";

import { pageSignal$ } from "../../page-signal.ts";
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

export const managedConnectorAccessSignals$ = computed((get) => {
  const connectorSlug = get(managedConnectorAccessSlug$);
  return connectorSlug
    ? createConnectorPermissionsSignals(
        { target: { kind: "builtin", connectorSlug }, label: connectorSlug },
        closeConnectorAccessManagement$,
      )
    : null;
});
