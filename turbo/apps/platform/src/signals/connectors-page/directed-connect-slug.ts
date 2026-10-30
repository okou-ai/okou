import { command, computed, state } from "ccstate";
import { connectorAccountsContract } from "@okouai/api-contracts/client/connector-accounts";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  customConnectorSlugSchema,
  isIntegrationManagedCustomConnector,
  customConnectorManagedStatusSchema,
} from "@okouai/api-contracts/validators/custom-connectors";
import type { CustomConnectorSlug } from "@okouai/api-contracts/contracts/custom-connectors";
import { uuid } from "zod";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { agents$ } from "../agent.ts";
import {
  resetBuiltinManualGrantForm$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  connectBuiltinConnectorNoAuthAndSettle$,
  getBuiltinConnectorStatusConnectLaunchMode,
  getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail,
  getOnlyAvailableBuiltinConnectorStatusNoAuthMethod,
  getOnlyManualBuiltinConnectorStatusAuthMethod,
  hasBuiltinConnectorStatusProviderDrivenConnectMethod,
} from "../okou-page/settings/connectors.ts";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";
import type { ConnectorAccountMutationOptions } from "../okou-page/settings/connector-account-dialogs.ts";
import { completeDirectedConnectorAction$ } from "./directed-connector-callback.ts";
import { routeChatActionCallback$ } from "../chat-page/action-callback.ts";
import {
  connectorCatalogItemForSlug,
  builtinConnectorsReloadVersion$,
} from "../external/connectors.ts";
import { customConnectors$ } from "../okou-page/settings/custom-connectors.ts";
import { createConnectorAccountListSignals } from "../okou-page/connector-accounts.ts";

const directedConnectAccounts = createConnectorAccountListSignals({
  includeBuiltinScopeMismatch: true,
  refreshVersion$: builtinConnectorsReloadVersion$,
});
export const directedConnectAccounts$ = directedConnectAccounts.accounts$;
export const reloadDirectedConnectAccounts$ = directedConnectAccounts.reload$;

/** The standalone connect route owns only the account target it displays. */
export const initializeDirectedConnectAccounts$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(directedConnectAccounts.clearTarget$);
    signal.addEventListener("abort", () => {
      set(directedConnectAccounts.clearTarget$);
    });
    if (get(directedConnectAccountTarget$).kind !== "default") {
      return;
    }
    const builtinSlug = get(directedConnectSlug$);
    if (builtinSlug) {
      set(
        directedConnectAccounts.setTarget$,
        { kind: "builtin", connectorSlug: builtinSlug },
        signal,
      );
      return;
    }
    const customSlug = get(directedConnectCustomSlug$);
    if (!customSlug) {
      return;
    }
    const connectors = await get(customConnectors$);
    signal.throwIfAborted();
    const connector = connectors.find((candidate) => {
      return candidate.slug === customSlug;
    });
    if (connector && !isIntegrationManagedCustomConnector(connector)) {
      set(
        directedConnectAccounts.setTarget$,
        { kind: "custom", customConnectorId: connector.id },
        signal,
      );
    }
  },
);

/**
 * Connector slug extracted from `/connectors/:connectorSlug/connect` route params.
 */
export const directedConnectSlug$ = computed((get): ConnectorSlug | null => {
  const params = get(pathParams$);
  const connectorSlug = params?.connectorSlug;
  const parsed = connectorSlugSchema.safeParse(
    typeof connectorSlug === "string" ? connectorSlug.toLowerCase() : null,
  );
  return parsed.success ? parsed.data : null;
});

/** The catalog entry of the connector the page is directed at. */
export const directedConnectCatalogItem$ =
  connectorCatalogItemForSlug(directedConnectSlug$);

export const directedConnectCustomSlug$ = computed(
  (get): CustomConnectorSlug | null => {
    const params = get(pathParams$);
    const connectorSlug = params?.connectorSlug;
    const parsed = customConnectorSlugSchema.safeParse(
      typeof connectorSlug === "string" ? connectorSlug.toLowerCase() : null,
    );
    return parsed.success ? parsed.data : null;
  },
);

export const directedConnectCustomConnected$ = computed(async (get) => {
  const slug = get(directedConnectCustomSlug$);
  if (!slug) {
    return false;
  }
  const connector = (await get(customConnectors$)).find((candidate) => {
    return candidate.slug === slug;
  });
  if (!connector) {
    return false;
  }
  if (isIntegrationManagedCustomConnector(connector)) {
    return customConnectorManagedStatusSchema.parse(connector).connected;
  }
  const account = (await get(directedConnectAccounts$)).defaultConnection;
  return account?.connectionStatus === "connected";
});

type DirectedConnectAccountTarget =
  | { readonly kind: "default" }
  | { readonly kind: "invalid" }
  | { readonly kind: "exact"; readonly connectionId: string };

export const directedConnectAccountTarget$ = computed(
  (get): DirectedConnectAccountTarget => {
    const connectionId = get(pathParams$)?.connectionId;
    if (connectionId === undefined) {
      return { kind: "default" };
    }
    const parsed = uuid().safeParse(connectionId);
    return parsed.success
      ? { kind: "exact", connectionId: parsed.data }
      : { kind: "invalid" };
  },
);

export const directedConnectExactAccount$ = computed(
  async (get): Promise<ConnectorAccountConnection | null> => {
    const target = get(directedConnectAccountTarget$);
    const connectorSlug = get(directedConnectSlug$);
    if (target.kind !== "exact" || !connectorSlug) {
      return null;
    }
    get(builtinConnectorsReloadVersion$);
    const result = await accept(
      get(apiClient$)(connectorAccountsContract).connection({
        params: { connectionId: target.connectionId },
        query: { kind: "builtin", connectorSlug },
      }),
      [200, 404],
    );
    return result.status === 200 ? result.body : null;
  },
);

/**
 * Agent ID extracted from `?agentId=` query parameter on the connect page.
 * When present, the connect page will auto-authorize the agent after connecting.
 */
export const directedConnectAgentId$ = computed((get): string | null => {
  return get(searchParams$).get("agentId");
});

/** Agent display name resolved from agentId query param on connect page. */
export const directedConnectAgentName$ = computed(async (get) => {
  const agentId = get(directedConnectAgentId$);
  if (!agentId) {
    return { agentId: null, displayName: null };
  }
  const agents = await get(agents$);
  const agent = agents.find((a) => {
    return a.agentId === agentId;
  });
  return { agentId, displayName: agent?.displayName ?? null };
});

interface DirectedConnectTarget {
  readonly connectorSlug: ConnectorSlug;
  readonly agentId: string | null;
}

interface DirectedConnectCustomTarget {
  readonly connectorSlug: CustomConnectorSlug;
  readonly agentId: string | null;
}

type DirectedConnectManualGrantDialogKey = DirectedConnectTarget & {
  readonly signal: AbortSignal;
};

type DirectedConnectModalKey = DirectedConnectTarget & {
  readonly signal: AbortSignal;
};

type DirectedConnectCustomDialogKey = DirectedConnectCustomTarget & {
  readonly signal: AbortSignal;
};

const internalManualGrantDialogKey$ =
  state<DirectedConnectManualGrantDialogKey | null>(null);
const internalDirectedConnectModalKey$ = state<DirectedConnectModalKey | null>(
  null,
);
const internalDirectedConnectCustomDialogKey$ =
  state<DirectedConnectCustomDialogKey | null>(null);
export const manualGrantDialogKey$ = computed((get) => {
  return get(internalManualGrantDialogKey$);
});
export const directedConnectModalKey$ = computed((get) => {
  return get(internalDirectedConnectModalKey$);
});
export const directedConnectCustomDialogKey$ = computed((get) => {
  return get(internalDirectedConnectCustomDialogKey$);
});
export const setManualGrantDialogKey$ = command(
  ({ set }, key: DirectedConnectTarget | null, signal: AbortSignal) => {
    if (key) {
      set(resetBuiltinManualGrantForm$, key.connectorSlug);
    }
    set(internalManualGrantDialogKey$, key ? { ...key, signal } : null);
  },
);
export const setDirectedConnectModalKey$ = command(
  ({ set }, key: DirectedConnectTarget | null, signal: AbortSignal) => {
    if (key) {
      set(resetBuiltinManualGrantForm$, key.connectorSlug);
    }
    set(internalDirectedConnectModalKey$, key ? { ...key, signal } : null);
  },
);
export const setDirectedConnectCustomDialogKey$ = command(
  ({ set }, key: DirectedConnectCustomTarget | null, signal: AbortSignal) => {
    set(
      internalDirectedConnectCustomDialogKey$,
      key ? { ...key, signal } : null,
    );
  },
);

/** Launch the selected account's connection and await its chat continuation. */
export const connectDirectedConnector$ = command(
  async (
    { get, set },
    item: PlatformConnectorCatalogStatusItem,
    agentId: string | null,
    accountOptions: ConnectorAccountMutationOptions,
    signal: AbortSignal,
  ): Promise<void> => {
    const callback = get(routeChatActionCallback$);
    const launchMode = getBuiltinConnectorStatusConnectLaunchMode(item);
    const key = { connectorSlug: item.slug, agentId };
    if (launchMode === "modal") {
      const manualMethod = getOnlyManualBuiltinConnectorStatusAuthMethod(item);
      if (
        !hasBuiltinConnectorStatusProviderDrivenConnectMethod(item) &&
        manualMethod &&
        item.authMethods.length === 1
      ) {
        set(setManualGrantDialogKey$, key, signal);
      } else {
        set(setDirectedConnectModalKey$, key, signal);
      }
      return;
    }
    const options = {
      connectorLabel: item.label,
      ...(agentId ? { agentId } : { authorizeVisibleAgents: true }),
      ...accountOptions,
    };
    const onSuccess = (_connectionId: string, attemptSignal: AbortSignal) => {
      return set(
        completeDirectedConnectorAction$,
        agentId,
        callback,
        attemptSignal,
      );
    };
    if (launchMode === "browser-auth") {
      const method =
        getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail(item);
      if (!method) {
        set(setDirectedConnectModalKey$, key, signal);
        return;
      }
      await set(
        connectBuiltinConnectorOAuthAuthCodeAndSettle$,
        {
          connectorSlug: item.slug,
          method,
          options: { ...options, connectorIcon: item.icon },
          onSuccess,
        },
        signal,
      );
    } else {
      const authMethod =
        getOnlyAvailableBuiltinConnectorStatusNoAuthMethod(item);
      if (!authMethod) {
        set(setDirectedConnectModalKey$, key, signal);
        return;
      }
      await set(
        connectBuiltinConnectorNoAuthAndSettle$,
        { connectorSlug: item.slug, authMethod, options, onSuccess },
        signal,
      );
    }
  },
);
