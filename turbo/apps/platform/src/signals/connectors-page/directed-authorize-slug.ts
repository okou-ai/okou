import { command, computed, state } from "ccstate";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/client/user-connectors";
import { accept } from "../../lib/accept.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { apiClient$ } from "../api-client.ts";
import { agents$ } from "../agent.ts";
import { agentConnectorAuthorizations } from "../okou-page/agent-connector-authorizations.ts";
import {
  resetBuiltinManualGrantForm$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  connectBuiltinConnectorNoAuthAndSettle$,
  getBuiltinConnectorStatusConnectLaunchMode,
  getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail,
  getOnlyAvailableBuiltinConnectorStatusNoAuthMethod,
} from "../okou-page/settings/connectors.ts";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";
import { defaultBuiltinConnectorAccountOptions } from "../okou-page/settings/connector-account-dialogs.ts";
import { completeDirectedConnectorAction$ } from "./directed-connector-callback.ts";
import {
  routeChatActionCallback$,
  type ChatActionCallback,
} from "../chat-page/action-callback.ts";
import {
  connectorCatalogItemForSlug,
  withMemberAccount,
  builtinConnectorsReloadVersion$,
} from "../external/connectors.ts";
import { createConnectorAccountListSignals } from "../okou-page/connector-accounts.ts";

/**
 * Connector slug extracted from `/connectors/:connectorSlug/authorize` route params.
 */
export const directedAuthorizeSlug$ = computed((get): ConnectorSlug | null => {
  const params = get(pathParams$);
  const connectorSlug = params?.connectorSlug;
  const parsed = connectorSlugSchema.safeParse(
    typeof connectorSlug === "string" ? connectorSlug.toLowerCase() : null,
  );
  return parsed.success ? parsed.data : null;
});

const directedAuthorizeDefinition$ = connectorCatalogItemForSlug(
  directedAuthorizeSlug$,
);
const directedAuthorizeAccounts = createConnectorAccountListSignals({
  includeBuiltinScopeMismatch: true,
  refreshVersion$: builtinConnectorsReloadVersion$,
});

export const initializeDirectedAuthorizeAccounts$ = command(
  ({ get, set }, signal: AbortSignal) => {
    set(directedAuthorizeAccounts.clearTarget$);
    signal.addEventListener("abort", () => {
      set(directedAuthorizeAccounts.clearTarget$);
    });
    const connectorSlug = get(directedAuthorizeSlug$);
    if (connectorSlug) {
      set(
        directedAuthorizeAccounts.setTarget$,
        { kind: "builtin", connectorSlug },
        signal,
      );
    }
  },
);

/** Authorization uses the current canonical default, separate from catalog metadata. */
export const directedAuthorizeCatalogItem$ = computed(async (get) => {
  const definition = await get(directedAuthorizeDefinition$);
  if (!definition) {
    return null;
  }
  const accounts = await get(directedAuthorizeAccounts.accounts$);
  if (!accounts.available) {
    throw new Error("Connector account information is unavailable");
  }
  return withMemberAccount(definition, accounts.defaultConnection);
});

/**
 * Agent ID extracted from `?agentId=` query parameter.
 */
export const directedAuthorizeAgentId$ = computed((get): string | null => {
  return get(searchParams$).get("agentId");
});

/** Agent display name resolved from agentId query param. */
export const directedAuthorizeAgentName$ = computed(async (get) => {
  const agentId = get(directedAuthorizeAgentId$);
  if (!agentId) {
    return { agentId: null, displayName: null };
  }
  const agents = await get(agents$);
  const agent = agents.find((a) => {
    return a.agentId === agentId;
  });
  return { agentId, displayName: agent?.displayName ?? null };
});

/** Fetch enabled connector slugs for the agent from the API. */
export const agentEnabledConnectorSlugs$ = computed(async (get) => {
  const agentId = get(directedAuthorizeAgentId$);
  if (!agentId) {
    return { agentId: null, enabledConnectorSlugs: [], agentMissing: false };
  }
  const authorizations = await get(
    agentConnectorAuthorizations({ agentId, missing: "null" }),
  );
  return {
    agentId,
    enabledConnectorSlugs: [...(authorizations?.enabledConnectorSlugs ?? [])],
    agentMissing: authorizations === null,
  };
});

interface DirectedAuthorizeConnectTarget {
  readonly connectorSlug: ConnectorSlug;
  readonly agentId: string;
}

type DirectedAuthorizeConnectModalKey = DirectedAuthorizeConnectTarget & {
  readonly signal: AbortSignal;
};

const internalDirectedAuthorizeConnectModalKey$ =
  state<DirectedAuthorizeConnectModalKey | null>(null);
export const directedAuthorizeConnectModalKey$ = computed((get) => {
  return get(internalDirectedAuthorizeConnectModalKey$);
});
export const setDirectedAuthorizeConnectModalKey$ = command(
  (
    { set },
    key: DirectedAuthorizeConnectTarget | null,
    signal: AbortSignal,
  ) => {
    if (key) {
      set(resetBuiltinManualGrantForm$, key.connectorSlug);
    }
    set(
      internalDirectedAuthorizeConnectModalKey$,
      key ? { ...key, signal } : null,
    );
  },
);

export const completeDirectedConnectorAuthorization$ = command(
  async (
    { set },
    agentId: string,
    callback: ChatActionCallback,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(completeDirectedConnectorAction$, agentId, callback, signal);
  },
);

/** Connect if needed, authorize the requested agent, then continue its chat. */
export const authorizeDirectedConnector$ = command(
  async (
    { get, set },
    args: {
      readonly connectorSlug: ConnectorSlug;
      readonly agentId: string;
      readonly item: PlatformConnectorCatalogStatusItem | undefined;
      readonly isConnected: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { connectorSlug, agentId, item, isConnected } = args;
    const callback = get(routeChatActionCallback$);
    if (isConnected) {
      await set(authorizeConnector$, connectorSlug, agentId, signal);
      await set(completeDirectedConnectorAction$, agentId, callback, signal);
      return;
    }
    if (!item) {
      return;
    }
    const accountOptions = defaultBuiltinConnectorAccountOptions(item);
    if (!accountOptions) {
      return;
    }
    const options = { connectorLabel: item.label, agentId, ...accountOptions };
    const launchMode = getBuiltinConnectorStatusConnectLaunchMode(item);
    const onSuccess = (_connectionId: string, attemptSignal: AbortSignal) => {
      return set(
        completeDirectedConnectorAuthorization$,
        agentId,
        callback,
        attemptSignal,
      );
    };
    const method =
      launchMode === "browser-auth"
        ? getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail(item)
        : null;
    if (method) {
      await set(
        connectBuiltinConnectorOAuthAuthCodeAndSettle$,
        {
          connectorSlug,
          method,
          options: { ...options, connectorIcon: item.icon },
          onSuccess,
        },
        signal,
      );
      return;
    }
    const authMethod =
      launchMode === "no-auth"
        ? getOnlyAvailableBuiltinConnectorStatusNoAuthMethod(item)
        : null;
    if (authMethod) {
      await set(
        connectBuiltinConnectorNoAuthAndSettle$,
        { connectorSlug, authMethod, options, onSuccess },
        signal,
      );
      return;
    }
    if (item.authMethods.length > 0) {
      set(
        setDirectedAuthorizeConnectModalKey$,
        { connectorSlug, agentId },
        signal,
      );
    }
  },
);

/** Authorize a connector for the given agent via user-connectors API. */
export const authorizeConnector$ = command(
  async (
    { get },
    connectorSlug: ConnectorSlug,
    agentId: string,
    signal: AbortSignal,
  ) => {
    const createClient = get(apiClient$);
    const client = createClient(userBuiltinConnectorsContract);

    await accept(
      client.update({
        params: { id: agentId },
        body: {
          enabledConnectorSlugs: [connectorSlug],
          operation: "add",
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
  },
);
