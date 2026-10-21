import { command, computed, state } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { onRef, withCleanup } from "../utils.ts";
import { toggleAgentConnector$ } from "./job-detail/connectors.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { pageVersion$ } from "../page-signal.ts";
import { agentName$ } from "./job-detail/agent-name.ts";

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

function createPermissionToggleActions() {
  // Keep the last outcome separately from the synchronous single-flight guard.
  const internalRequest$ = state<Promise<void> | null>(null);
  const internalInFlight$ = state<Promise<void> | null>(null);
  const request$ = computed((get) => {
    return get(internalRequest$);
  });
  const canToggle$ = command(({ get }) => {
    return get(internalInFlight$) === null;
  });
  const toggle$ = command(
    (
      { get, set },
      connectorSlug: ConnectorSlug,
      enabled: boolean,
      signal: AbortSignal,
    ): Promise<void> | undefined => {
      if (get(internalInFlight$)) {
        return;
      }
      const request = withCleanup(
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
          set(internalInFlight$, null);
        },
      );
      set(internalInFlight$, request);
      set(internalRequest$, request);
      return request;
    },
  );
  return { request$, canToggle$, toggle$ };
}

export type PermissionToggleActions = ReturnType<
  typeof createPermissionToggleActions
>;

// Filtering may unmount a row, but its result still belongs to this page.
// Replace the graph when either the domain agent or page setup changes.
export const permissionToggleActions$ = computed((get) => {
  get(agentName$);
  get(pageVersion$);
  return createPermissionToggleActions();
});
