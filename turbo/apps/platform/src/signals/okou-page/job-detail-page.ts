import { command, computed, state } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { onRef } from "../utils.ts";
import { toggleAgentConnector$ } from "./job-detail/connectors.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";

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

export const toggleAgentPermissionConnector$ = command(
  async (
    { set },
    connectorSlug: ConnectorSlug,
    enabled: boolean,
    signal: AbortSignal,
  ) => {
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
  },
);
