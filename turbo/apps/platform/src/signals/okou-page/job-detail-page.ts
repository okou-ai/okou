import { command, computed, state } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { onRef, withCleanup } from "../utils.ts";
import { toggleAgentConnector$ } from "./job-detail/connectors.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { pageVersion$ } from "../page-signal.ts";

// ---------------------------------------------------------------------------
// JobPermissionsTab UI state
// ---------------------------------------------------------------------------

const internalConnectorSlug$ = state<ConnectorSlug | null>(null);
export const permConnectorSlug$ = computed((get) => {
  return get(internalConnectorSlug$);
});
export const setPermConnectorSlug$ = command(
  ({ set }, connectorSlug: ConnectorSlug | null) => {
    set(internalConnectorSlug$, connectorSlug);
  },
);

export const agentPermissionMetadata$ = computed(async (get) => {
  const connectorSlug = get(permConnectorSlug$);
  if (!connectorSlug) {
    return null;
  }
  return await get(firewallPermissionMetadataByConnector({ connectorSlug }));
});

const internalPermSearch$ = state("");
export const permSearch$ = computed((get) => {
  return get(internalPermSearch$);
});
export const setPermSearch$ = command(({ set }, value: string) => {
  set(internalPermSearch$, value);
});

export const focusPermSearchRef$ = onRef(
  command((_context, input: HTMLInputElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    input.focus();
  }),
);

const internalPermSearchActive$ = state(false);
export const permSearchActive$ = computed((get) => {
  return get(internalPermSearchActive$);
});
export const setPermSearchActive$ = command(({ set }, active: boolean) => {
  set(internalPermSearchActive$, active);
});

function createConnectorAuthorizationSignals() {
  const running$ = state<Promise<void> | null>(null);
  const operation$ = state<Promise<void> | undefined>(undefined);
  const toggle$ = command(
    (
      { get, set },
      connectorSlug: ConnectorSlug,
      enabled: boolean,
      signal: AbortSignal,
    ) => {
      const existing = get(running$);
      if (existing) {
        return existing;
      }
      const operation = withCleanup(
        (async () => {
          await set(toggleAgentConnector$, connectorSlug, enabled, signal);
          signal.throwIfAborted();
          toast.success(
            i18n.t(
              ($) => {
                return $.authorization.connectorsSaved;
              },
              { ns: "agents" },
            ),
          );
        })(),
        () => {
          set(running$, null);
        },
      );
      set(running$, operation);
      set(operation$, operation);
      return operation;
    },
  );
  return { operation$, toggle$ };
}

// Filtering may unmount a row, but its result still belongs to this page.
// A new route gets a new operation owner rather than the previous agent's error.
const connectorAuthorizationSignals$ = computed((get) => {
  get(pageVersion$);
  return createConnectorAuthorizationSignals();
});
export const jobPermissionConnectorOperation$ = computed((get) => {
  return get(get(connectorAuthorizationSignals$).operation$);
});
export const toggleJobPermissionConnector$ = command(
  (
    { get, set },
    connectorSlug: ConnectorSlug,
    enabled: boolean,
    signal: AbortSignal,
  ) => {
    return set(
      get(connectorAuthorizationSignals$).toggle$,
      connectorSlug,
      enabled,
      signal,
    );
  },
);
