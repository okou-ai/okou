import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { toast } from "@okouai/ui/components/ui/sonner";
import { withConnectorConnectionProgress } from "../../connector-connection-progress.ts";

import { accept } from "../../../lib/accept.ts";
import { now } from "../../../lib/time.ts";
import type { ConnectorDeviceAuthStartOptions } from "@okouai/connectors/connector-config";
import { isConnectorAppOauthCallbackEnabled } from "@okouai/connectors/app-oauth-callback";
import {
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorExternalCodeSessionContract,
  connectorOauthDeviceAuthSessionContract,
  connectorOpenIdStartContract,
  connectorOauthStartContract,
  connectorManualGrantContract,
  connectorNoAuthGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import type { ConnectorOauthDeviceAuthSessionPollResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogConnectionStatus,
  PublicConnectorCatalogIcon,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectors$,
  relatedConnectorCatalog,
  reloadConnectors$,
} from "../../external/connectors.ts";
import { replaceSearchParams$, searchParams$ } from "../../route.ts";
import { connectorAgentAuthorizations$ } from "./connector-access-management.ts";
import {
  OAUTH_API_BASE,
  apiClient$,
  type ApiClientFactory,
} from "../../api-client.ts";
import {
  resetSignal,
  setLoop,
  settle,
  tapError,
  withCleanup,
} from "../../utils.ts";
import { setAblyPayloadLoop$ } from "../../realtime.ts";
import { agents$ } from "../../agent.ts";
import { reloadAgentConnectorAuthorizations$ } from "../agent-connector-authorizations.ts";
import { reloadConnectorAccountSummaries$ } from "../connector-accounts.ts";
import { sanitizeTokenInputRecord } from "./token-input.ts";
import { IN_VITEST } from "../../../env.ts";
import { connectorRedirectingPath } from "../../connectors-page/connector-redirecting.ts";
import { isConnectorChangedPayloadFor } from "../../connector-change.ts";
import { i18n } from "../../../i18n/index.ts";
import {
  connectorDirectoryEnabled$,
  connectorDirectoryCustomScope$,
  connectorsScope$,
  openConnectorDirectoryScope$,
} from "./connector-directory-route.ts";
import type {
  PlatformConnector,
  PlatformConnectorAccountMutationIntent,
  PlatformConnectorCatalogStatusItem,
} from "../../connector-domain.ts";
import {
  readConnectorAccountCount,
  readConnectorOAuthCompletion,
} from "./connector-accounts.ts";
import { syncGoogleAdsConversionMilestones$ } from "../../bootstrap/google-ads-conversion-milestones.ts";

type PostConnectOptions = {
  readonly authorizeVisibleAgents?: boolean;
  readonly connectorLabel?: string;
  readonly agentId?: string;
  readonly account: PlatformConnectorAccountMutationIntent;
  readonly useDefaultConnectorProjection?: boolean;
};
type BrowserAuthPostConnectOptions = PostConnectOptions & {
  readonly connectorIcon: PublicConnectorCatalogIcon;
};

export interface ConnectorConnectionResult {
  readonly connectionId: string | null;
}

function shouldAuthorizeAgent(options: PostConnectOptions): boolean {
  return Boolean(options.authorizeVisibleAgents || options.agentId);
}

const resolveConnectorPostConnectOptions$ = command(
  async (
    { get },
    connectorSlug: ConnectorSlug,
    options: PostConnectOptions,
    signal: AbortSignal,
  ): Promise<PostConnectOptions> => {
    if (!options.authorizeVisibleAgents) {
      return options;
    }
    const authorizeVisibleAgents =
      options.account.intent === "add" &&
      (await readConnectorAccountCount(
        get(apiClient$),
        { kind: "builtin", connectorSlug },
        signal,
      )) === 0;
    return { ...options, authorizeVisibleAgents };
  },
);

const reloadConnectorConnectionState$ = command(({ set }) => {
  set(reloadConnectors$);
  set(reloadConnectorAccountSummaries$);
});
// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type ConnectorConnectLaunchMode = "browser-auth" | "no-auth" | "modal";
type BrowserAuthGrantKind = "auth-code" | "openid-auth";

type ConnectorCatalogBrowserAuthMethodDetail =
  PublicConnectorCatalogAuthMethodDetail & {
    readonly grantKind: BrowserAuthGrantKind;
  };

type ConnectorStatusDirectConnectMethod =
  | {
      readonly kind: "browser-auth";
      readonly authMethod: PublicConnectorCatalogAuthMethodDetail;
    }
  | {
      readonly kind: "no-auth";
      readonly authMethod: ConnectorAuthMethodId;
    };

export function manualGrantInputValuesForMethod(
  method: Pick<PublicConnectorCatalogAuthMethodDetail, "manualFields">,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    method.manualFields.flatMap((field) => {
      const value = values[field.id];
      return value === undefined ? [] : ([[field.id, value]] as const);
    }),
  );
}

type ConnectorStatusGrantKind =
  PublicConnectorCatalogAuthMethodDetail["grantKind"];

function isBrowserAuthGrantKind(
  grantKind: ConnectorStatusGrantKind,
): grantKind is BrowserAuthGrantKind {
  return grantKind === "auth-code" || grantKind === "openid-auth";
}

function isCatalogBrowserAuthMethodDetail(
  method: PublicConnectorCatalogAuthMethodDetail,
): method is ConnectorCatalogBrowserAuthMethodDetail {
  return isBrowserAuthGrantKind(method.grantKind);
}

export function getOnlyAvailableCatalogBrowserAuthMethodDetail(connector: {
  readonly authMethods: readonly PublicConnectorCatalogAuthMethodDetail[];
  readonly singleAuthCodeAuthMethodId: ConnectorAuthMethodId | null;
}): ConnectorCatalogBrowserAuthMethodDetail | null {
  const [method] = connector.authMethods;
  if (
    connector.authMethods.length !== 1 ||
    !method ||
    !isCatalogBrowserAuthMethodDetail(method)
  ) {
    return null;
  }
  if (
    method.grantKind === "auth-code" &&
    connector.singleAuthCodeAuthMethodId !== method.id
  ) {
    return null;
  }
  return method;
}

function isNoAuthGrantKind(grantKind: ConnectorStatusGrantKind): boolean {
  return grantKind === "none";
}

function getConnectorStatusAuthMethod(
  connector: PlatformConnectorCatalogStatusItem,
  authMethod: ConnectorAuthMethodId,
): PublicConnectorCatalogAuthMethodDetail | null {
  return (
    connector.authMethods.find((method) => {
      return method.id === authMethod;
    }) ?? null
  );
}

function getConnectorStatusAuthMethodsByGrantKind(
  connector: PlatformConnectorCatalogStatusItem,
  grantKind: ConnectorStatusGrantKind,
): PublicConnectorCatalogAuthMethodDetail[] {
  return connector.authMethods.filter((method) => {
    return method.grantKind === grantKind;
  });
}

export function getOnlyManualConnectorStatusAuthMethod(
  connector: PlatformConnectorCatalogStatusItem,
): PublicConnectorCatalogAuthMethodDetail | null {
  const methods = getConnectorStatusAuthMethodsByGrantKind(connector, "manual");
  return methods.length === 1 ? (methods[0] ?? null) : null;
}

export function hasConnectorStatusProviderDrivenConnectMethod(
  connector: PlatformConnectorCatalogStatusItem,
): boolean {
  return connector.authMethods.some((method) => {
    return (
      method.grantKind === "auth-code" ||
      method.grantKind === "openid-auth" ||
      method.grantKind === "device-auth" ||
      method.grantKind === "external-code" ||
      method.grantKind === "managed"
    );
  });
}
export function getConnectorStatusConnectLaunchMode(
  connector: PlatformConnectorCatalogStatusItem,
): ConnectorConnectLaunchMode {
  return getConnectorStatusDirectConnectMethod(connector)?.kind ?? "modal";
}

function getAvailableStatusAuthCodeAuthMethod(
  connector: PlatformConnectorCatalogStatusItem,
  authMethod: string,
): ConnectorAuthMethodId | null {
  const parsed = connectorAuthMethodIdSchema.safeParse(authMethod);
  if (!parsed.success) {
    return null;
  }
  const method = getConnectorStatusAuthMethod(connector, parsed.data);
  if (method?.grantKind !== "auth-code") {
    return null;
  }
  return parsed.data;
}

function getOnlyAvailableStatusAuthCodeAuthMethod(
  connector: PlatformConnectorCatalogStatusItem,
): ConnectorAuthMethodId | null {
  const authMethod = connector.singleAuthCodeAuthMethodId;
  const [method] = connector.authMethods;
  if (
    connector.authMethods.length !== 1 ||
    !authMethod ||
    method?.id !== authMethod
  ) {
    return null;
  }
  return getAvailableStatusAuthCodeAuthMethod(connector, authMethod);
}
function getOnlyAvailableStatusBrowserAuthMethod(
  connector: PlatformConnectorCatalogStatusItem,
): ConnectorAuthMethodId | null {
  const [method] = connector.authMethods;
  if (connector.authMethods.length !== 1 || !method) {
    return null;
  }
  if (method?.grantKind === "auth-code") {
    return getOnlyAvailableStatusAuthCodeAuthMethod(connector);
  }
  return method.grantKind === "openid-auth" ? method.id : null;
}

export function getOnlyAvailableStatusBrowserAuthMethodDetail(
  connector: PlatformConnectorCatalogStatusItem,
): PublicConnectorCatalogAuthMethodDetail | null {
  const authMethod = getOnlyAvailableStatusBrowserAuthMethod(connector);
  return authMethod
    ? getConnectorStatusAuthMethod(connector, authMethod)
    : null;
}

function getAvailableStatusNoAuthMethod(
  connector: PlatformConnectorCatalogStatusItem,
  authMethod: string,
): ConnectorAuthMethodId | null {
  const parsed = connectorAuthMethodIdSchema.safeParse(authMethod);
  if (!parsed.success) {
    return null;
  }
  const method = getConnectorStatusAuthMethod(connector, parsed.data);
  if (!method || !isNoAuthGrantKind(method.grantKind)) {
    return null;
  }
  return parsed.data;
}

export function getOnlyAvailableStatusNoAuthMethod(
  connector: PlatformConnectorCatalogStatusItem,
): ConnectorAuthMethodId | null {
  const [method] = connector.authMethods;
  if (connector.authMethods.length !== 1 || !method) {
    return null;
  }
  return getAvailableStatusNoAuthMethod(connector, method.id);
}

export function getConnectorStatusDirectConnectMethod(
  connector: PlatformConnectorCatalogStatusItem,
): ConnectorStatusDirectConnectMethod | null {
  const browserAuthMethod =
    getOnlyAvailableStatusBrowserAuthMethodDetail(connector);
  if (browserAuthMethod) {
    return { kind: "browser-auth", authMethod: browserAuthMethod };
  }
  const noAuthMethod = getOnlyAvailableStatusNoAuthMethod(connector);
  return noAuthMethod ? { kind: "no-auth", authMethod: noAuthMethod } : null;
}

function connectorTokenExpiresAtMs(
  connector: PlatformConnectorCatalogStatusItem,
): number | null {
  if (!connector.tokenExpiresAt) {
    return null;
  }
  const value = Date.parse(connector.tokenExpiresAt);
  return Number.isFinite(value) ? value : null;
}

export function connectorCurrentConnectionStatus(
  connector: PlatformConnectorCatalogStatusItem,
  nowMs = now(),
): PublicConnectorCatalogConnectionStatus {
  if (connector.connectionStatus === "not-connected") {
    return "not-connected";
  }
  if (!connector.authMethodSupportsRefresh) {
    const tokenExpiresAtMs = connectorTokenExpiresAtMs(connector);
    if (tokenExpiresAtMs !== null && tokenExpiresAtMs <= nowMs) {
      return "reconnect-required";
    }
  }
  return connector.connectionStatus;
}

export function connectorExpiryCountdownText(
  connector: PlatformConnectorCatalogStatusItem,
  nowMs = now(),
): string | null {
  if (
    connectorCurrentConnectionStatus(connector, nowMs) !== "connected" ||
    connector.authMethodSupportsRefresh
  ) {
    return null;
  }
  const tokenExpiresAtMs = connectorTokenExpiresAtMs(connector);
  if (tokenExpiresAtMs === null) {
    return null;
  }
  const remainingMs = tokenExpiresAtMs - nowMs;
  if (remainingMs >= DAY_MS) {
    return i18n.t(
      ($) => {
        return $.connectors.expiration.inDays;
      },
      { count: Math.ceil(remainingMs / DAY_MS) },
    );
  }
  if (remainingMs < HOUR_MS) {
    return i18n.t(($) => {
      return $.connectors.expiration.lessThanHour;
    });
  }
  return i18n.t(
    ($) => {
      return $.connectors.expiration.inHours;
    },
    { count: Math.ceil(remainingMs / HOUR_MS) },
  );
}

/**
 * Case-insensitive substring match across label and slug.
 * Returns true when `search` is empty, so callers can use it directly as a filter.
 */
export function matchesConnectorSearch(
  search: string,
  connector: Pick<PlatformConnectorCatalogStatusItem, "slug" | "label">,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  if (connector.label.toLowerCase().includes(needle)) {
    return true;
  }
  if (connector.slug.toLowerCase().includes(needle)) {
    return true;
  }
  return false;
}

/**
 * Directory search. Widens `matchesConnectorSearch` to the description and the
 * catalog tags, so intent words ("email", "chat", "crm") reach the connectors
 * that serve them even when the product name shares no letters with the query.
 */
export function matchesConnectorDirectorySearch(
  search: string,
  connector: Pick<
    PlatformConnectorCatalogStatusItem,
    "slug" | "label" | "description" | "tags"
  >,
): boolean {
  if (matchesConnectorSearch(search, connector)) {
    return true;
  }
  const needle = search.trim().toLowerCase();
  if (connector.description.toLowerCase().includes(needle)) {
    return true;
  }
  return connector.tags.some((tag) => {
    return tag.toLowerCase().includes(needle);
  });
}

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

const CONNECTORS_SEARCH_PARAM = "keywords";
const CONNECTORS_CONNECTION_FILTER_PARAM = "connection";
const CONNECTORS_CATEGORY_PARAM = "category";
const CONNECTORS_AGENT_FILTER_PREFIX = "agent:";

// A single, mutually-exclusive connector filter: all connectors, a connection
// status, or the connectors a given agent is authorized to use.
export type ConnectorsConnectionFilter =
  | { readonly kind: "all" }
  | { readonly kind: "connected" }
  | { readonly kind: "not-connected" }
  | { readonly kind: "unshared" }
  | { readonly kind: "agent"; readonly agentId: string };

export const connectorsConnectionFilter$ = computed(
  (get): ConnectorsConnectionFilter => {
    // The directory browses a catalog, and category is the only dimension that
    // organises it. The scope you already own is organised by who uses those
    // connectors instead, so that is the one place this control still applies.
    if (get(connectorDirectoryEnabled$) && get(connectorsScope$) !== "mine") {
      return { kind: "all" };
    }
    const raw = get(searchParams$).get(CONNECTORS_CONNECTION_FILTER_PARAM);
    if (raw === "connected") {
      return { kind: "connected" };
    }
    if (raw === "not-connected") {
      return { kind: "not-connected" };
    }
    if (raw === "unshared") {
      return { kind: "unshared" };
    }
    if (raw?.startsWith(CONNECTORS_AGENT_FILTER_PREFIX)) {
      const agentId = raw.slice(CONNECTORS_AGENT_FILTER_PREFIX.length);
      if (agentId) {
        return { kind: "agent", agentId };
      }
    }
    return { kind: "all" };
  },
);

export const connectorsSearch$ = computed((get) => {
  return get(searchParams$).get(CONNECTORS_SEARCH_PARAM) ?? "";
});

/**
 * The category being browsed, or null for the shelf view. Category is the only
 * dimension that organises four thousand connectors, so it lives in the URL
 * next to the search keyword rather than in component state.
 */
export const connectorsCategoryFilter$ = computed((get): string | null => {
  if (get(connectorDirectoryCustomScope$)) {
    return null;
  }
  return get(searchParams$).get(CONNECTORS_CATEGORY_PARAM) ?? null;
});

export const setConnectorsCategoryFilter$ = command(
  ({ get, set }, value: string | null) => {
    if (get(connectorDirectoryEnabled$)) {
      set(
        openConnectorDirectoryScope$,
        value ? { kind: "category", category: value } : { kind: "all" },
      );
      return;
    }
    const params = new URLSearchParams(get(searchParams$));
    if (value) {
      params.set(CONNECTORS_CATEGORY_PARAM, value);
    } else {
      params.delete(CONNECTORS_CATEGORY_PARAM);
    }
    set(replaceSearchParams$, params);
  },
);

export const connectorCatalogDiscovery$ = relatedConnectorCatalog(
  connectorsSearch$,
  connectorsCategoryFilter$,
);

export const relatedCatalogItems$ = computed(async (get) => {
  const { connectors } = await get(connectorCatalogDiscovery$);
  const items = [...connectors];

  // Sort connected connectors to the top of the list
  items.sort((a, b) => {
    if (a.connected === b.connected) {
      return 0;
    }
    return a.connected ? -1 : 1;
  });

  return items;
});

export const filteredConnectorCatalogItems$ = computed(async (get) => {
  const keyword = get(connectorsSearch$);
  const effectiveFilter = get(connectorsConnectionFilter$);
  const category = get(connectorsCategoryFilter$);
  const scope = get(connectorsScope$);

  const agentEnabledSlugs =
    effectiveFilter.kind === "agent"
      ? new Set(
          (await get(connectorAgentAuthorizations$)).find((row) => {
            return row.agent.agentId === effectiveFilter.agentId;
          })?.enabledConnectorSlugs ?? [],
        )
      : null;
  const sharedSlugs =
    effectiveFilter.kind === "unshared"
      ? new Set(
          (await get(connectorAgentAuthorizations$)).flatMap((row) => {
            return [...row.enabledConnectorSlugs];
          }),
        )
      : null;

  const relatedCatalogItems = await get(relatedCatalogItems$);
  return relatedCatalogItems.filter((connector) => {
    if (!matchesConnectorSearch(keyword, connector)) {
      return false;
    }
    if (category !== null && connector.category !== category) {
      return false;
    }
    // The "yours" scope is membership, not a filter: whatever else is chosen,
    // it only ever shows what this workspace has already connected.
    if (scope === "mine" && !connector.connected) {
      return false;
    }
    if (effectiveFilter.kind === "connected") {
      return connector.connected;
    }
    if (effectiveFilter.kind === "not-connected") {
      return !connector.connected;
    }
    if (effectiveFilter.kind === "unshared") {
      return !sharedSlugs?.has(connector.slug);
    }
    if (effectiveFilter.kind === "agent") {
      return agentEnabledSlugs?.has(connector.slug) ?? false;
    }
    return true;
  });
});

export const setConnectorsSearch$ = command(({ get, set }, value: string) => {
  const params = new URLSearchParams(get(searchParams$));
  if (value.trim()) {
    params.set(CONNECTORS_SEARCH_PARAM, value);
  } else {
    params.delete(CONNECTORS_SEARCH_PARAM);
  }
  set(replaceSearchParams$, params);
});

export const setConnectorsConnectionFilter$ = command(
  ({ get, set }, value: ConnectorsConnectionFilter) => {
    const params = new URLSearchParams(get(searchParams$));
    if (value.kind === "all") {
      params.delete(CONNECTORS_CONNECTION_FILTER_PARAM);
    } else if (value.kind === "agent") {
      params.set(
        CONNECTORS_CONNECTION_FILTER_PARAM,
        `${CONNECTORS_AGENT_FILTER_PREFIX}${value.agentId}`,
      );
    } else {
      params.set(CONNECTORS_CONNECTION_FILTER_PARAM, value.kind);
    }
    set(replaceSearchParams$, params);
  },
);

// ---------------------------------------------------------------------------
// Selected connector for connect modal
// ---------------------------------------------------------------------------

const internalSelectedConnectorSlug$ = state<ConnectorSlug | null>(null);

type ActiveConnectorOAuthDeviceAuthState = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly requestId: string;
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAtMs: number;
  readonly pollIntervalMs: number;
  readonly approvalOpened: boolean;
  readonly errorMessage: string | null;
};

type ActiveConnectorExternalCodeState = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly requestId: string;
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly authorizationUrl: string;
  readonly expiresAtMs: number;
  readonly code: string;
  readonly errorMessage: string | null;
  readonly authorizeVisibleAgents: boolean;
};

export type ConnectorOAuthDeviceAuthState =
  | {
      readonly status: "idle";
      readonly connectorSlug: ConnectorSlug | null;
    }
  | {
      readonly status: "starting";
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly requestId: string;
    }
  | (ActiveConnectorOAuthDeviceAuthState & {
      readonly status: "pending" | "polling";
    })
  | {
      readonly status: "denied" | "expired" | "error";
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly message: string;
    };

export type ConnectorExternalCodeState =
  | {
      readonly status: "idle";
      readonly connectorSlug: ConnectorSlug | null;
    }
  | {
      readonly status: "starting";
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly requestId: string;
    }
  | (ActiveConnectorExternalCodeState & {
      readonly status: "pending";
    })
  | {
      readonly status: "expired" | "error";
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly message: string;
    };

type ConnectorConnectFlowState = {
  readonly connectorSlug: ConnectorSlug;
  readonly id: string;
};

function createIdleConnectorOAuthDeviceAuthState(
  connectorSlug: ConnectorSlug | null = null,
): ConnectorOAuthDeviceAuthState {
  return { status: "idle", connectorSlug };
}

const internalConnectorOAuthDeviceAuthState$ =
  state<ConnectorOAuthDeviceAuthState>(
    createIdleConnectorOAuthDeviceAuthState(),
  );

function createIdleConnectorExternalCodeState(
  connectorSlug: ConnectorSlug | null = null,
): ConnectorExternalCodeState {
  return { status: "idle", connectorSlug };
}

const internalConnectorExternalCodeState$ = state<ConnectorExternalCodeState>(
  createIdleConnectorExternalCodeState(),
);
const resetConnectorOAuthDeviceAuthFlowSignal$ = resetSignal();
const resetConnectorExternalCodeFlowSignal$ = resetSignal();
const connectorOAuthDeviceAuthStartOptionValues$ = state<
  Record<string, Record<string, string>>
>({});

export const selectedConnectorSlug$ = computed((get) => {
  return get(internalSelectedConnectorSlug$);
});
export const setSelectedConnectorSlug$ = command(
  ({ get, set }, connectorSlug: ConnectorSlug | null) => {
    if (connectorSlug) {
      set(resetManualGrantForm$, connectorSlug);
    }
    set(internalSelectedConnectorSlug$, connectorSlug);
    const deviceAuthCurrent = get(internalConnectorOAuthDeviceAuthState$);
    if (connectorSlug !== deviceAuthCurrent.connectorSlug) {
      set(resetConnectorOAuthDeviceAuthFlowSignal$);
      set(
        internalConnectorOAuthDeviceAuthState$,
        createIdleConnectorOAuthDeviceAuthState(connectorSlug),
      );
    }
    const externalCodeCurrent = get(internalConnectorExternalCodeState$);
    if (connectorSlug !== externalCodeCurrent.connectorSlug) {
      set(resetConnectorExternalCodeFlowSignal$);
      set(
        internalConnectorExternalCodeState$,
        createIdleConnectorExternalCodeState(connectorSlug),
      );
    }
  },
);

export const connectorOAuthDeviceAuthState$ = computed((get) => {
  return get(internalConnectorOAuthDeviceAuthState$);
});

export const connectorExternalCodeState$ = computed((get) => {
  return get(internalConnectorExternalCodeState$);
});

function connectorOAuthDeviceAuthStateIsActive(
  state: ConnectorOAuthDeviceAuthState,
): boolean {
  return (
    state.status === "starting" ||
    state.status === "pending" ||
    state.status === "polling"
  );
}

function connectorExternalCodeStateIsActive(
  state: ConnectorExternalCodeState,
): boolean {
  return state.status === "starting" || state.status === "pending";
}

function connectorConnectOperationIsActive({
  authCodeConnectorSlug,
  connectFlow,
  deviceAuthState,
  externalCodeState,
}: {
  readonly authCodeConnectorSlug: ConnectorSlug | null;
  readonly connectFlow: ConnectorConnectFlowState | null;
  readonly deviceAuthState: ConnectorOAuthDeviceAuthState;
  readonly externalCodeState: ConnectorExternalCodeState;
}): boolean {
  return (
    authCodeConnectorSlug !== null ||
    connectFlow !== null ||
    connectorOAuthDeviceAuthStateIsActive(deviceAuthState) ||
    connectorExternalCodeStateIsActive(externalCodeState)
  );
}

function connectorOAuthDeviceAuthStartOptionsKey(
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
): string {
  return `${connectorSlug}:${authMethod}`;
}

export const connectorOAuthDeviceAuthStartOptionValuesFor$ = computed((get) => {
  const values = get(connectorOAuthDeviceAuthStartOptionValues$);
  return (connectorSlug: ConnectorSlug, authMethod: ConnectorAuthMethodId) => {
    return (
      values[
        connectorOAuthDeviceAuthStartOptionsKey(connectorSlug, authMethod)
      ] ?? {}
    );
  };
});

export const setConnectorOAuthDeviceAuthStartOptionValue$ = command(
  (
    { get, set },
    args: {
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly name: string;
      readonly value: string;
    },
  ) => {
    const key = connectorOAuthDeviceAuthStartOptionsKey(
      args.connectorSlug,
      args.authMethod,
    );
    const current = get(connectorOAuthDeviceAuthStartOptionValues$);
    set(connectorOAuthDeviceAuthStartOptionValues$, {
      ...current,
      [key]: {
        ...current[key],
        [args.name]: args.value,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Scope review modal state
// ---------------------------------------------------------------------------

export interface ConnectorScopeReviewSelection {
  readonly connectorSlug: ConnectorSlug;
  readonly connectionId: string;
  readonly authMethod: ConnectorAuthMethodId;
}

const internalScopeReviewSelection$ =
  state<ConnectorScopeReviewSelection | null>(null);
export const scopeReviewSelection$ = computed((get) => {
  return get(internalScopeReviewSelection$);
});

export const scopeDiff$ = computed(async (get) => {
  const selection = get(internalScopeReviewSelection$);
  if (!selection) {
    return null;
  }
  const createClient = get(apiClient$);
  const client = createClient(connectorAccountsContract);
  const result = await accept(
    client.scopeDiff({
      params: { connectionId: selection.connectionId },
      query: { connectorSlug: selection.connectorSlug },
    }),
    [200],
  );
  return result.body;
});

export const setScopeReviewSelection$ = command(
  ({ set }, selection: ConnectorScopeReviewSelection | null) => {
    set(internalScopeReviewSelection$, selection);
  },
);

// ---------------------------------------------------------------------------
// Manual grant form state (used by connector connection dialogs)
// ---------------------------------------------------------------------------

const manualGrantFormValues$ = state<Record<string, Record<string, string>>>(
  {},
);
export const manualGrantFormSubmitting$ = computed((get) => {
  return get(internalManualGrantFormSubmitting$);
});
const internalManualGrantFormSubmitting$ = state<string | null>(null);

export const setManualGrantFormValue$ = command(
  ({ get, set }, connectorSlug: ConnectorSlug, name: string, value: string) => {
    const current = get(manualGrantFormValues$);
    set(manualGrantFormValues$, {
      ...current,
      [connectorSlug]: { ...current[connectorSlug], [name]: value },
    });
  },
);

export const resetManualGrantForm$ = command(
  ({ get, set }, connectorSlug: ConnectorSlug) => {
    const current = get(manualGrantFormValues$);
    const updated = { ...current };
    delete updated[connectorSlug];
    set(manualGrantFormValues$, updated);
  },
);

export const manualGrantFormValuesFor$ = computed((get) => {
  const values = get(manualGrantFormValues$);
  return (connectorSlug: ConnectorSlug) => {
    return values[connectorSlug] ?? {};
  };
});

export const setManualGrantFormSubmitting$ = command(
  ({ set }, value: string | null) => {
    set(internalManualGrantFormSubmitting$, value);
  },
);

type FinishConnectorConnectionOptions = PostConnectOptions & {
  readonly clearSelectedConnector?: boolean;
  readonly reloadConnectors?: boolean;
  readonly toastMessage?: string | null;
};

const authorizeConnectorForVisibleAgents$ = command(
  async (
    { get, set },
    connectorSlug: ConnectorSlug,
    signal: AbortSignal,
  ): Promise<void> => {
    const visibleAgents = await get(agents$);
    signal.throwIfAborted();
    const client = get(apiClient$)(userConnectorsContract);
    await withCleanup(
      Promise.all(
        visibleAgents.map(async (agent) => {
          await accept(
            client.update({
              params: { id: agent.agentId },
              body: {
                enabledConnectorSlugs: [connectorSlug],
                operation: "add",
              },
              fetchOptions: { signal },
            }),
            [200, 404],
          );
        }),
      ),
      () => {
        set(reloadAgentConnectorAuthorizations$);
      },
    );
    signal.throwIfAborted();
  },
);

const finishConnectorConnection$ = command(
  async (
    { set },
    connectorSlug: ConnectorSlug,
    options: FinishConnectorConnectionOptions,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (options.authorizeVisibleAgents) {
      await set(authorizeConnectorForVisibleAgents$, connectorSlug, signal);
    }
    set(internalJustConnectedSlugs$, (prev) => {
      return new Set([...prev, connectorSlug]);
    });
    if (options.reloadConnectors !== false) {
      set(reloadConnectors$);
    }
    if (options.agentId) {
      set(reloadAgentConnectorAuthorizations$);
    }

    if (options.toastMessage !== null) {
      toast.success(
        options.toastMessage ??
          i18n.t(
            ($) => {
              return $.connectors.toasts.connected;
            },
            { connector: options.connectorLabel ?? connectorSlug },
          ),
        {
          id: `connector-connected-${connectorSlug}`,
        },
      );
    }
    if (options.clearSelectedConnector) {
      set(internalSelectedConnectorSlug$, null);
    }
    await settle(set(syncGoogleAdsConversionMilestones$, signal), signal);
    return true;
  },
);

// ---------------------------------------------------------------------------
// Submit manual connector grant command
// ---------------------------------------------------------------------------

type SubmitManualGrantParams = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly inputValues: Record<string, string>;
  readonly options: PostConnectOptions;
};

export const submitManualGrant$ = command(
  async (
    { get, set },
    {
      connectorSlug,
      authMethod,
      inputValues,
      options: requestedOptions,
    }: SubmitManualGrantParams,
    signal: AbortSignal,
  ): Promise<ConnectorConnectionResult | false> => {
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorSlug: get(internalPollingOAuthAuthCodeConnectorSlug$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorSlug);
    set(internalConnectFlowState$, flow);
    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const options = await set(
          resolveConnectorPostConnectOptions$,
          connectorSlug,
          requestedOptions,
          signal,
        );
        const createClient = get(apiClient$);
        const connectorClient = createClient(connectorManualGrantContract);
        const result = await accept(
          connectorClient.connect({
            params: { connectorSlug },
            body: {
              account: options.account,
              authMethod,
              ...(shouldAuthorizeAgent(options)
                ? { authorizeAgent: true as const }
                : {}),
              ...(options.agentId ? { agentId: options.agentId } : {}),
              values: sanitizeTokenInputRecord(inputValues),
            },
            fetchOptions: { signal },
          }),
          [200],
        );
        connectorStateChanged = true;
        signal.throwIfAborted();
        await set(
          finishConnectorConnection$,
          connectorSlug,
          {
            ...options,
            reloadConnectors: false,
            toastMessage: `${options.connectorLabel ?? connectorSlug} connected successfully`,
          },
          signal,
        );
        return { connectionId: result.body.id };
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
        if (connectorStateChanged) {
          set(reloadConnectorConnectionState$);
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Enable no-auth connector grant command
// ---------------------------------------------------------------------------

type ConnectNoAuthParams = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly options: PostConnectOptions;
};

export const connectConnectorNoAuth$ = command(
  async (
    { get, set },
    {
      connectorSlug,
      authMethod,
      options: requestedOptions,
    }: ConnectNoAuthParams,
    signal: AbortSignal,
  ): Promise<ConnectorConnectionResult | false> => {
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorSlug: get(internalPollingOAuthAuthCodeConnectorSlug$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorSlug);
    set(internalConnectFlowState$, flow);
    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const options = await set(
          resolveConnectorPostConnectOptions$,
          connectorSlug,
          requestedOptions,
          signal,
        );
        const createClient = get(apiClient$);
        const connectorClient = createClient(connectorNoAuthGrantContract);
        const result = await accept(
          connectorClient.connect({
            params: { connectorSlug },
            body: {
              account: options.account,
              authMethod,
              ...(shouldAuthorizeAgent(options)
                ? { authorizeAgent: true as const }
                : {}),
              ...(options.agentId ? { agentId: options.agentId } : {}),
            },
            fetchOptions: { signal },
          }),
          [200],
        );
        connectorStateChanged = true;
        signal.throwIfAborted();
        await set(
          finishConnectorConnection$,
          connectorSlug,
          {
            ...options,
            reloadConnectors: false,
            toastMessage: `${options.connectorLabel ?? connectorSlug} enabled successfully`,
          },
          signal,
        );
        return { connectionId: result.body.id };
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
        if (connectorStateChanged) {
          set(reloadConnectorConnectionState$);
        }
      },
    );
  },
);

export const connectConnectorNoAuthAndSettle$ = command(
  async (
    { set },
    args: ConnectNoAuthParams & {
      readonly onSuccess: (connectionId: string | null) => void | Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(connectConnectorNoAuth$, args, signal);
    if (connected) {
      signal.throwIfAborted();
      await args.onSuccess(connected.connectionId);
    }
  },
);

// ---------------------------------------------------------------------------
// Polling state (for connect flow)
// ---------------------------------------------------------------------------

const internalPollingOAuthAuthCodeConnectorSlug$ = state<ConnectorSlug | null>(
  null,
);
const internalConnectFlowState$ = state<ConnectorConnectFlowState | null>(null);

export const pollingOAuthAuthCodeConnectorSlug$ = computed((get) => {
  return get(internalPollingOAuthAuthCodeConnectorSlug$);
});

export const pollingOAuthDeviceAuthConnectorSlug$ = computed((get) => {
  const current = get(internalConnectorOAuthDeviceAuthState$);
  return current.status === "pending" || current.status === "polling"
    ? current.connectorSlug
    : null;
});

export const connectFlowConnectorSlug$ = computed((get) => {
  return get(internalConnectFlowState$)?.connectorSlug ?? null;
});

export const runConnectorConnectSuccess$ = command(
  async (
    { set },
    connectorSlug: ConnectorSlug,
    onSuccess: (connectionId: string | null) => void | Promise<void>,
    connectionId: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const flow = createConnectorConnectFlowState(connectorSlug);
    set(internalConnectFlowState$, flow);
    return await withCleanup(
      (async () => {
        signal.throwIfAborted();
        await onSuccess(connectionId);
        signal.throwIfAborted();
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Optimistic connected state — bridges the gap between connect success and
// relatedCatalogItems$ recomputation so the UI doesn't flash.
// ---------------------------------------------------------------------------

const internalJustConnectedSlugs$ = state<Set<ConnectorSlug>>(new Set());

/** Slugs that were just connected but may not yet be reflected in relatedCatalogItems$. */
export const justConnectedSlugs$ = computed((get) => {
  return get(internalJustConnectedSlugs$);
});

function createConnectorConnectFlowState(
  connectorSlug: ConnectorSlug,
): ConnectorConnectFlowState {
  return {
    connectorSlug,
    id: `${connectorSlug}-connect-${now()}-${Math.random().toString(36).slice(2)}`,
  };
}

function secondsToMilliseconds(value: number): number {
  return Math.max(0, value * 1000);
}

// ---------------------------------------------------------------------------
// OAuth device authorization flow state
// ---------------------------------------------------------------------------

const OAUTH_DEVICE_AUTH_MIN_POLL_INTERVAL_MS = IN_VITEST ? 10 : 1000;

type PollConnectorOAuthDeviceAuthArgs = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly requestId: string;
  readonly createClient: ApiClientFactory;
  readonly options: PostConnectOptions;
};

type ConnectConnectorOAuthDeviceAuthParams = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly options: PostConnectOptions;
  readonly startOptions?: ConnectorDeviceAuthStartOptions;
};

function connectorOAuthDeviceAuthStartBody(
  args: ConnectConnectorOAuthDeviceAuthParams,
) {
  const optionEntries = Object.entries(args.startOptions ?? {});
  return {
    account: args.options.account,
    authMethod: args.authMethod,
    ...(shouldAuthorizeAgent(args.options)
      ? { authorizeAgent: true as const }
      : {}),
    ...(args.options.agentId ? { agentId: args.options.agentId } : {}),
    ...(optionEntries.length > 0
      ? { options: Object.fromEntries(optionEntries) }
      : {}),
  };
}

type ConnectorOAuthDeviceAuthSessionClient = InitClientReturn<
  typeof connectorOauthDeviceAuthSessionContract,
  InitClientArgs
>;

type PollConnectorOAuthDeviceAuthIterationArgs = Omit<
  PollConnectorOAuthDeviceAuthArgs,
  "createClient"
> & {
  readonly client: ConnectorOAuthDeviceAuthSessionClient;
};

type PollConnectorOAuthDeviceAuthIterationOutcome = {
  readonly stop: boolean;
  readonly connectionId?: string;
  readonly expired?: true;
};

function createConnectorOAuthDeviceAuthRequestId(
  connectorSlug: ConnectorSlug,
): string {
  return `${connectorSlug}-oauth-device-${now()}-${Math.random().toString(36).slice(2)}`;
}

function getOAuthDeviceAuthTerminalMessage(
  result: Extract<
    ConnectorOauthDeviceAuthSessionPollResponse,
    { readonly status: "denied" | "expired" | "error" }
  >,
): string {
  if (result.errorMessage) {
    return result.errorMessage;
  }
  switch (result.status) {
    case "denied": {
      return i18n.t(($) => {
        return $.connectors.connectDialog.errors.denied;
      });
    }
    case "expired": {
      return i18n.t(($) => {
        return $.connectors.connectDialog.errors.expired;
      });
    }
    case "error": {
      return i18n.t(($) => {
        return $.connectors.connectDialog.errors.failed;
      });
    }
  }
}

function isCurrentConnectorOAuthDeviceAuthRequest(
  state: ConnectorOAuthDeviceAuthState,
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
  requestId: string,
): state is ActiveConnectorOAuthDeviceAuthState & {
  readonly status: "pending" | "polling";
} {
  return (
    (state.status === "pending" || state.status === "polling") &&
    state.connectorSlug === connectorSlug &&
    state.authMethod === authMethod &&
    state.requestId === requestId
  );
}

export const clearConnectorOAuthDeviceAuth$ = command(({ set }) => {
  set(resetConnectorOAuthDeviceAuthFlowSignal$);
  set(
    internalConnectorOAuthDeviceAuthState$,
    createIdleConnectorOAuthDeviceAuthState(),
  );
});

export const openConnectorOAuthDeviceAuthVerificationPage$ = command(
  (
    { get, set },
    connectorSlug: ConnectorSlug,
    authMethod: ConnectorAuthMethodId,
  ): boolean => {
    const current = get(internalConnectorOAuthDeviceAuthState$);
    if (
      (current.status !== "pending" && current.status !== "polling") ||
      current.connectorSlug !== connectorSlug ||
      current.authMethod !== authMethod
    ) {
      return false;
    }

    const verificationUrl =
      current.verificationUriComplete ?? current.verificationUri;
    const verificationWindow = window.open(verificationUrl, "_blank");
    if (!verificationWindow) {
      set(internalConnectorOAuthDeviceAuthState$, {
        ...current,
        errorMessage: i18n.t(($) => {
          return $.connectors.connectDialog.errors.verificationOpen;
        }),
      });
      return false;
    }

    verificationWindow.opener = null;
    set(internalConnectorOAuthDeviceAuthState$, {
      ...current,
      status: "pending",
      approvalOpened: true,
      errorMessage: null,
    });
    return true;
  },
);

const pollConnectorOAuthDeviceAuthOnce$ = command(
  async (
    { get, set },
    {
      client,
      connectorSlug,
      authMethod,
      requestId,
      options,
    }: PollConnectorOAuthDeviceAuthIterationArgs,
    signal: AbortSignal,
  ): Promise<PollConnectorOAuthDeviceAuthIterationOutcome> => {
    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const current = get(internalConnectorOAuthDeviceAuthState$);
        if (
          !isCurrentConnectorOAuthDeviceAuthRequest(
            current,
            connectorSlug,
            authMethod,
            requestId,
          )
        ) {
          return { stop: true };
        }

        const remainingMs = current.expiresAtMs - now();
        if (remainingMs <= 0) {
          return { stop: true, expired: true };
        }

        if (!current.approvalOpened) {
          await delay(
            Math.min(OAUTH_DEVICE_AUTH_MIN_POLL_INTERVAL_MS, remainingMs),
            { signal },
          );
          signal.throwIfAborted();
          return { stop: false };
        }

        set(internalConnectorOAuthDeviceAuthState$, {
          ...current,
          status: "polling",
        });

        const pollResponse = await accept(
          client.poll({
            params: { connectorSlug, sessionId: current.sessionId },
            body: { sessionToken: current.sessionToken },
            fetchOptions: { signal },
          }),
          [200],
        );
        const pollResult = pollResponse.body;
        if (pollResult.status === "complete") {
          connectorStateChanged = true;
        }

        const latest = get(internalConnectorOAuthDeviceAuthState$);
        if (
          !isCurrentConnectorOAuthDeviceAuthRequest(
            latest,
            connectorSlug,
            authMethod,
            requestId,
          )
        ) {
          return { stop: true };
        }

        if (pollResult.status === "complete") {
          signal.throwIfAborted();
          await set(
            finishConnectorConnection$,
            connectorSlug,
            {
              ...options,
              clearSelectedConnector: true,
              reloadConnectors: false,
            },
            signal,
          );
          set(
            internalConnectorOAuthDeviceAuthState$,
            createIdleConnectorOAuthDeviceAuthState(),
          );
          return {
            stop: true,
            connectionId: pollResult.connector.id,
          };
        }

        signal.throwIfAborted();

        if (pollResult.status !== "pending") {
          set(internalConnectorOAuthDeviceAuthState$, {
            status: pollResult.status,
            connectorSlug,
            authMethod,
            message: getOAuthDeviceAuthTerminalMessage(pollResult),
          });
          return { stop: true };
        }

        const pollIntervalMs = Math.max(
          secondsToMilliseconds(pollResult.interval),
          OAUTH_DEVICE_AUTH_MIN_POLL_INTERVAL_MS,
        );
        set(internalConnectorOAuthDeviceAuthState$, {
          ...latest,
          status: "pending",
          pollIntervalMs,
          errorMessage: null,
        });

        const nextRemainingMs = latest.expiresAtMs - now();
        if (nextRemainingMs <= 0) {
          return { stop: true, expired: true };
        }
        await delay(Math.min(pollIntervalMs, nextRemainingMs), { signal });
        signal.throwIfAborted();
        return { stop: false };
      })(),
      () => {
        if (connectorStateChanged) {
          set(reloadConnectorConnectionState$);
        }
      },
    );
  },
);

const pollConnectorOAuthDeviceAuth$ = command(
  async (
    { get, set },
    {
      connectorSlug,
      authMethod,
      requestId,
      createClient,
      options,
    }: PollConnectorOAuthDeviceAuthArgs,
    signal: AbortSignal,
  ): Promise<ConnectorConnectionResult | false> => {
    const client = createClient(connectorOauthDeviceAuthSessionContract, {
      apiBase: OAUTH_API_BASE,
    });
    const isCurrentRequest = (state: ConnectorOAuthDeviceAuthState) => {
      return isCurrentConnectorOAuthDeviceAuthRequest(
        state,
        connectorSlug,
        authMethod,
        requestId,
      );
    };
    let connectionId: string | null = null;
    let expired = false;

    await setLoop(
      async (sig) => {
        const outcome = await set(
          pollConnectorOAuthDeviceAuthOnce$,
          {
            client,
            connectorSlug,
            authMethod,
            requestId,
            options,
          },
          sig,
        );
        sig.throwIfAborted();
        if (outcome.connectionId) {
          connectionId = outcome.connectionId;
        }
        if (outcome.expired) {
          expired = true;
        }
        return outcome.stop;
      },
      0,
      signal,
      { retryTransientErrors: false },
    );
    signal.throwIfAborted();

    const latest = get(internalConnectorOAuthDeviceAuthState$);
    if (expired && isCurrentRequest(latest)) {
      set(internalConnectorOAuthDeviceAuthState$, {
        status: "expired",
        connectorSlug,
        authMethod,
        message: i18n.t(($) => {
          return $.connectors.connectDialog.errors.expired;
        }),
      });
    }
    return connectionId ? { connectionId } : false;
  },
);

const connectConnectorOAuthDeviceAuth$ = command(
  async (
    { get, set },
    args: ConnectConnectorOAuthDeviceAuthParams,
    signal: AbortSignal,
  ): Promise<ConnectorConnectionResult | false> => {
    const { connectorSlug, authMethod } = args;
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorSlug: get(internalPollingOAuthAuthCodeConnectorSlug$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorSlug);
    set(internalConnectFlowState$, flow);
    let requestId: string | null = null;
    return await withCleanup(
      (async () => {
        requestId = createConnectorOAuthDeviceAuthRequestId(connectorSlug);
        const flowSignal = set(
          resetConnectorOAuthDeviceAuthFlowSignal$,
          signal,
        );
        set(internalConnectorOAuthDeviceAuthState$, {
          status: "starting",
          connectorSlug,
          authMethod,
          requestId,
        });

        const createClient = get(apiClient$);
        const client = createClient(connectorOauthDeviceAuthSessionContract, {
          apiBase: OAUTH_API_BASE,
        });
        const options = await set(
          resolveConnectorPostConnectOptions$,
          connectorSlug,
          args.options,
          flowSignal,
        );
        const startResponse = await tapError(
          accept(
            client.create({
              params: { connectorSlug },
              body: connectorOAuthDeviceAuthStartBody({ ...args, options }),
              fetchOptions: { signal: flowSignal },
            }),
            [200],
          ),
        );
        flowSignal.throwIfAborted();
        const startResult = startResponse?.body ?? null;
        if (!startResponse) {
          if (flowSignal.aborted) {
            return false;
          }
          set(internalConnectorOAuthDeviceAuthState$, {
            status: "error",
            connectorSlug,
            authMethod,
            message: i18n.t(($) => {
              return $.connectors.connectDialog.errors.failed;
            }),
          });
        }
        flowSignal.throwIfAborted();
        if (!startResult) {
          return false;
        }

        set(internalConnectorOAuthDeviceAuthState$, {
          status: "pending",
          connectorSlug,
          authMethod,
          requestId,
          sessionId: startResult.sessionId,
          sessionToken: startResult.sessionToken,
          userCode: startResult.userCode,
          verificationUri: startResult.verificationUri,
          verificationUriComplete: startResult.verificationUriComplete,
          expiresAtMs: now() + secondsToMilliseconds(startResult.expiresIn),
          pollIntervalMs: Math.max(
            secondsToMilliseconds(startResult.interval),
            OAUTH_DEVICE_AUTH_MIN_POLL_INTERVAL_MS,
          ),
          approvalOpened: false,
          errorMessage: null,
        });

        return await set(
          pollConnectorOAuthDeviceAuth$,
          {
            connectorSlug,
            authMethod,
            requestId,
            createClient,
            options,
          },
          flowSignal,
        );
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
        set(internalConnectorOAuthDeviceAuthState$, (current) => {
          if (
            requestId === null ||
            current.connectorSlug !== connectorSlug ||
            (current.status !== "starting" &&
              current.status !== "pending" &&
              current.status !== "polling") ||
            current.authMethod !== authMethod ||
            current.requestId !== requestId
          ) {
            return current;
          }
          return createIdleConnectorOAuthDeviceAuthState(connectorSlug);
        });
      },
    );
  },
);

const connectConnectorOAuthDeviceAuthAndSettleCommand$ = command(
  async (
    { set },
    args: {
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly onSuccess: (connectionId: string | null) => void | Promise<void>;
      readonly options: PostConnectOptions;
      readonly startOptions?: ConnectorDeviceAuthStartOptions;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      connectConnectorOAuthDeviceAuth$,
      {
        connectorSlug: args.connectorSlug,
        authMethod: args.authMethod,
        options: args.options,
        startOptions: args.startOptions,
      },
      signal,
    );
    if (connected) {
      signal.throwIfAborted();
      await args.onSuccess(connected.connectionId);
    }
  },
);

export const connectConnectorOAuthDeviceAuthAndSettle$ =
  withConnectorConnectionProgress(
    connectConnectorOAuthDeviceAuthAndSettleCommand$,
  );

// ---------------------------------------------------------------------------
// External-code authorization flow state
// ---------------------------------------------------------------------------

type ConnectConnectorExternalCodeParams = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly agentId?: string;
  readonly account: PlatformConnectorAccountMutationIntent;
  readonly authorizeVisibleAgents?: boolean;
};

type CompleteConnectorExternalCodeParams = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly options: PostConnectOptions;
};

function createConnectorExternalCodeRequestId(
  connectorSlug: ConnectorSlug,
): string {
  return `${connectorSlug}-external-code-${now()}-${Math.random().toString(36).slice(2)}`;
}

function isCurrentConnectorExternalCodeRequest(
  state: ConnectorExternalCodeState,
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
  requestId: string,
): state is ActiveConnectorExternalCodeState & {
  readonly status: "pending";
} {
  return (
    state.status === "pending" &&
    state.connectorSlug === connectorSlug &&
    state.authMethod === authMethod &&
    state.requestId === requestId
  );
}

export const clearConnectorExternalCode$ = command(({ set }) => {
  set(resetConnectorExternalCodeFlowSignal$);
  set(
    internalConnectorExternalCodeState$,
    createIdleConnectorExternalCodeState(),
  );
});

export const setConnectorExternalCodeAuthorizationCode$ = command(
  (
    { get, set },
    args: {
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly code: string;
    },
  ) => {
    const current = get(internalConnectorExternalCodeState$);
    if (
      current.status !== "pending" ||
      current.connectorSlug !== args.connectorSlug ||
      current.authMethod !== args.authMethod
    ) {
      return false;
    }
    set(internalConnectorExternalCodeState$, {
      ...current,
      code: args.code,
      errorMessage: null,
    });
    return true;
  },
);

export const openConnectorExternalCodeAuthorizationPage$ = command(
  (
    { get, set },
    connectorSlug: ConnectorSlug,
    authMethod: ConnectorAuthMethodId,
  ): boolean => {
    const current = get(internalConnectorExternalCodeState$);
    if (
      current.status !== "pending" ||
      current.connectorSlug !== connectorSlug ||
      current.authMethod !== authMethod
    ) {
      return false;
    }

    const authWindow = window.open(
      current.authorizationUrl,
      "_blank",
      "noopener,noreferrer",
    );
    if (authWindow) {
      authWindow.opener = null;
    }

    set(internalConnectorExternalCodeState$, {
      ...current,
      errorMessage: null,
    });
    return true;
  },
);

const connectConnectorExternalCodeCommand$ = command(
  async (
    { get, set },
    args: ConnectConnectorExternalCodeParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { connectorSlug, authMethod } = args;
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorSlug: get(internalPollingOAuthAuthCodeConnectorSlug$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorSlug);
    set(internalConnectFlowState$, flow);
    let requestId: string | null = null;
    return await withCleanup(
      (async () => {
        requestId = createConnectorExternalCodeRequestId(connectorSlug);
        const flowSignal = set(resetConnectorExternalCodeFlowSignal$, signal);
        set(internalConnectorExternalCodeState$, {
          status: "starting",
          connectorSlug,
          authMethod,
          requestId,
        });

        const createClient = get(apiClient$);
        const client = createClient(connectorExternalCodeSessionContract, {
          apiBase: OAUTH_API_BASE,
        });
        const options = await set(
          resolveConnectorPostConnectOptions$,
          connectorSlug,
          args,
          flowSignal,
        );
        const startResponse = await tapError(
          accept(
            client.create({
              params: { connectorSlug },
              body: {
                account: args.account,
                authMethod,
                ...(shouldAuthorizeAgent(options)
                  ? { authorizeAgent: true as const }
                  : {}),
                ...(args.agentId ? { agentId: args.agentId } : {}),
              },
              fetchOptions: { signal: flowSignal },
            }),
            [200],
          ),
        );
        flowSignal.throwIfAborted();
        const startResult = startResponse?.body ?? null;
        if (!startResponse) {
          if (flowSignal.aborted) {
            return false;
          }
          set(internalConnectorExternalCodeState$, {
            status: "error",
            connectorSlug,
            authMethod,
            message: i18n.t(($) => {
              return $.connectors.connectDialog.errors.failed;
            }),
          });
        }
        flowSignal.throwIfAborted();
        if (!startResult) {
          return false;
        }

        set(internalConnectorExternalCodeState$, {
          status: "pending",
          connectorSlug,
          authMethod,
          requestId,
          sessionId: startResult.sessionId,
          sessionToken: startResult.sessionToken,
          authorizationUrl: startResult.authorizationUrl,
          expiresAtMs: now() + secondsToMilliseconds(startResult.expiresIn),
          code: "",
          errorMessage: null,
          authorizeVisibleAgents: options.authorizeVisibleAgents ?? false,
        });
        return true;
      })(),
      () => {
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
        set(internalConnectorExternalCodeState$, (current) => {
          if (
            (!signal.aborted && current.status !== "starting") ||
            requestId === null ||
            current.connectorSlug !== connectorSlug ||
            (current.status !== "starting" && current.status !== "pending") ||
            current.authMethod !== authMethod ||
            current.requestId !== requestId
          ) {
            return current;
          }
          return createIdleConnectorExternalCodeState(connectorSlug);
        });
      },
    );
  },
);

export const connectConnectorExternalCode$ = withConnectorConnectionProgress(
  connectConnectorExternalCodeCommand$,
);

const completeConnectorExternalCode$ = command(
  async (
    { get, set },
    args: CompleteConnectorExternalCodeParams,
    signal: AbortSignal,
  ): Promise<ConnectorConnectionResult | false> => {
    const { connectorSlug, authMethod, options } = args;
    const current = get(internalConnectorExternalCodeState$);
    if (
      current.status !== "pending" ||
      current.connectorSlug !== connectorSlug ||
      current.authMethod !== authMethod
    ) {
      return false;
    }
    if (now() > current.expiresAtMs) {
      set(internalConnectorExternalCodeState$, {
        status: "expired",
        connectorSlug,
        authMethod,
        message: i18n.t(($) => {
          return $.connectors.connectDialog.errors.expired;
        }),
      });
      return false;
    }

    const code = current.code.trim();
    if (!code) {
      set(internalConnectorExternalCodeState$, {
        ...current,
        errorMessage: i18n.t(
          ($) => {
            return $.connectors.connectDialog.errors.codeRequired;
          },
          { connector: options.connectorLabel ?? connectorSlug },
        ),
      });
      return false;
    }

    set(internalConnectorExternalCodeState$, {
      ...current,
      code,
      errorMessage: null,
    });

    let connectorStateChanged = false;
    return await withCleanup(
      (async () => {
        const flowSignal = set(resetConnectorExternalCodeFlowSignal$, signal);
        const createClient = get(apiClient$);
        const client = createClient(connectorExternalCodeSessionContract, {
          apiBase: OAUTH_API_BASE,
        });
        const completeResult = await accept(
          client.complete({
            params: { connectorSlug, sessionId: current.sessionId },
            body: {
              sessionToken: current.sessionToken,
              code,
            },
            fetchOptions: { signal: flowSignal },
          }),
          [200, 400],
        );
        if (completeResult.status === 200) {
          connectorStateChanged = true;
        }
        signal.throwIfAborted();
        flowSignal.throwIfAborted();
        const latest = get(internalConnectorExternalCodeState$);
        if (
          !isCurrentConnectorExternalCodeRequest(
            latest,
            connectorSlug,
            authMethod,
            current.requestId,
          )
        ) {
          return false;
        }

        if (completeResult.status === 400) {
          set(internalConnectorExternalCodeState$, {
            ...latest,
            errorMessage: completeResult.body.error.message,
          });
          return false;
        }

        await set(
          finishConnectorConnection$,
          connectorSlug,
          {
            ...options,
            authorizeVisibleAgents: current.authorizeVisibleAgents,
            clearSelectedConnector: true,
            reloadConnectors: false,
          },
          flowSignal,
        );
        set(
          internalConnectorExternalCodeState$,
          createIdleConnectorExternalCodeState(),
        );
        return { connectionId: completeResult.body.connector.id };
      })(),
      () => {
        if (connectorStateChanged) {
          set(reloadConnectorConnectionState$);
        }
      },
    );
  },
);

const completeConnectorExternalCodeAndSettleCommand$ = command(
  async (
    { set },
    args: CompleteConnectorExternalCodeParams & {
      readonly onSuccess: (connectionId: string | null) => void | Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      completeConnectorExternalCode$,
      {
        connectorSlug: args.connectorSlug,
        authMethod: args.authMethod,
        options: args.options,
      },
      signal,
    );
    if (connected) {
      signal.throwIfAborted();
      await args.onSuccess(connected.connectionId);
    }
  },
);

export const completeConnectorExternalCodeAndSettle$ =
  withConnectorConnectionProgress(
    completeConnectorExternalCodeAndSettleCommand$,
  );

// ---------------------------------------------------------------------------
// Standalone mode detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the app is running as an installed PWA (standalone display mode).
 * In standalone mode, window.open() with popup features is blocked by iOS Safari.
 */
export function isStandaloneMode(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches;
}

const OAUTH_AUTH_CODE_POPUP_CLOSED_POLL_MS = IN_VITEST ? 10 : 250;

async function waitForOAuthAuthCodePopupClosed(
  authWindow: Pick<Window, "closed">,
  signal: AbortSignal,
): Promise<"popupClosed"> {
  signal.throwIfAborted();

  let closed = false;
  await setLoop(
    () => {
      if (authWindow.closed) {
        closed = true;
        return true;
      }
      return false;
    },
    OAUTH_AUTH_CODE_POPUP_CLOSED_POLL_MS,
    signal,
  );

  signal.throwIfAborted();
  if (!closed) {
    throw new Error("OAuth auth code popup wait ended before popup closed");
  }
  return "popupClosed";
}

const resetOAuthAuthCodeWaitSignal$ = resetSignal();

type ActiveConnectorOAuthAuthCodeWaitState = {
  readonly flowId: string;
  readonly connectorSlug: ConnectorSlug;
  readonly account: PlatformConnectorAccountMutationIntent;
  readonly oauthAttemptId: string;
};

type ConnectorOAuthAuthCodeWaitState =
  | (ActiveConnectorOAuthAuthCodeWaitState & {
      readonly status: "waiting";
    })
  | (ActiveConnectorOAuthAuthCodeWaitState & {
      readonly status: "completed";
      readonly connectionId: string;
    });

const internalConnectorOAuthAuthCodeWaitState$ =
  state<ConnectorOAuthAuthCodeWaitState | null>(null);

function connectorOAuthAuthCodeWaitIsCurrent(
  waitState: ConnectorOAuthAuthCodeWaitState | null,
  flowId: string,
  oauthAttemptId: string,
): waitState is ConnectorOAuthAuthCodeWaitState {
  return (
    waitState?.flowId === flowId && waitState.oauthAttemptId === oauthAttemptId
  );
}

const refreshConnectorOAuthAuthCodeCompletion$ = command(
  async (
    { get, set },
    flowId: string,
    oauthAttemptId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const current = get(internalConnectorOAuthAuthCodeWaitState$);
    if (!connectorOAuthAuthCodeWaitIsCurrent(current, flowId, oauthAttemptId)) {
      return false;
    }
    if (current.status === "completed") {
      return true;
    }

    const connectionId = await readConnectorOAuthCompletion(
      get(apiClient$),
      { kind: "builtin", connectorSlug: current.connectorSlug },
      current.account,
      current.oauthAttemptId,
      signal,
    );
    signal.throwIfAborted();

    const latest = get(internalConnectorOAuthAuthCodeWaitState$);
    if (!connectorOAuthAuthCodeWaitIsCurrent(latest, flowId, oauthAttemptId)) {
      return false;
    }
    if (latest.status === "completed") {
      return true;
    }
    if (connectionId === null) {
      return false;
    }

    set(internalConnectorOAuthAuthCodeWaitState$, {
      ...latest,
      status: "completed",
      connectionId,
    });
    return true;
  },
);

const refreshActiveConnectorOAuthAuthCodeCompletion$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const current = get(internalConnectorOAuthAuthCodeWaitState$);
    return current
      ? await set(
          refreshConnectorOAuthAuthCodeCompletion$,
          current.flowId,
          current.oauthAttemptId,
          signal,
        )
      : false;
  },
);

const onActiveConnectorChanged$ = command(
  async (
    { get, set },
    payload: unknown,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const current = get(internalConnectorOAuthAuthCodeWaitState$);
    if (
      !current ||
      !isConnectorChangedPayloadFor(payload, current.connectorSlug)
    ) {
      return false;
    }
    return await set(
      refreshConnectorOAuthAuthCodeCompletion$,
      current.flowId,
      current.oauthAttemptId,
      signal,
    );
  },
);

// ---------------------------------------------------------------------------
// Connect command
// ---------------------------------------------------------------------------

function connectorMatchesAuthMethod(
  connector: PlatformConnector,
  connectorSlug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
): boolean {
  return (
    connector.slug === connectorSlug && connector.authMethod === authMethod
  );
}

const defaultConnectorProjectionMatchesAuthMethod$ = command(
  async (
    { get },
    connectorSlug: ConnectorSlug,
    authMethod: ConnectorAuthMethodId,
    connectionId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { connectors } = await get(connectors$);
    signal.throwIfAborted();
    return connectors.some((connector) => {
      return (
        connectorMatchesAuthMethod(connector, connectorSlug, authMethod) &&
        connector.id === connectionId
      );
    });
  },
);

const openConnectorOAuthAuthCodeWindow$ = command(
  async (
    { get },
    args: {
      readonly connectorSlug: ConnectorSlug;
      readonly method: PublicConnectorCatalogAuthMethodDetail;
      readonly connectorLabel: string;
      readonly connectorIcon: PublicConnectorCatalogIcon;
      readonly agentId: string | undefined;
      readonly account: PlatformConnectorAccountMutationIntent;
      readonly beforeStart: (
        signal: AbortSignal,
      ) => Promise<PostConnectOptions>;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly authWindow: Window | null;
    readonly oauthAttemptId: string;
    readonly options: PostConnectOptions;
  }> => {
    const standalone = isStandaloneMode();
    // In standalone (PWA) mode, omit popup features so iOS Safari opens the
    // URL in the external browser instead of blocking it as a popup.
    const popupFeatures = standalone ? undefined : "width=600,height=700";
    const redirectingPath = connectorRedirectingPath({
      connectorSlug: args.connectorSlug,
      label: args.connectorLabel,
      icon: args.connectorIcon,
    });
    const authWindow = window.open(redirectingPath, "_blank", popupFeatures);

    if (!authWindow && !standalone) {
      throw new Error(
        i18n.t(($) => {
          return $.connectors.connectDialog.errors.authorizationWindow;
        }),
      );
    }
    if (authWindow) {
      authWindow.opener = null;
    }

    let navigated = false;
    const { options, oauthAttemptId } = await withCleanup(
      (async () => {
        if (!isBrowserAuthGrantKind(args.method.grantKind)) {
          throw new Error(
            `${args.connectorSlug}/${args.method.id} does not support browser authorization`,
          );
        }

        const options = await args.beforeStart(signal);
        signal.throwIfAborted();

        const startResult =
          args.method.grantKind === "openid-auth"
            ? await accept(
                get(apiClient$)(connectorOpenIdStartContract, {
                  apiBase: "api",
                }).start({
                  params: { connectorSlug: args.connectorSlug },
                  body: {
                    account: args.account,
                    authMethod: args.method.id,
                    ...(shouldAuthorizeAgent(options)
                      ? { authorizeAgent: true as const }
                      : {}),
                    ...(args.agentId ? { agentId: args.agentId } : {}),
                  },
                  fetchOptions: { signal },
                }),
                [200],
              )
            : await accept(
                get(apiClient$)(connectorOauthStartContract, {
                  apiBase: OAUTH_API_BASE,
                }).start({
                  params: { connectorSlug: args.connectorSlug },
                  body: {
                    account: args.account,
                    authMethod: args.method.id,
                    ...(shouldAuthorizeAgent(options)
                      ? { authorizeAgent: true as const }
                      : {}),
                    ...(isConnectorAppOauthCallbackEnabled(args.connectorSlug)
                      ? { callbackTarget: "app" as const }
                      : {}),
                    ...(args.agentId ? { agentId: args.agentId } : {}),
                  },
                  fetchOptions: { signal },
                }),
                [200],
              );
        signal.throwIfAborted();

        if (authWindow) {
          authWindow.location.href = startResult.body.authorizationUrl;
          navigated = true;
        } else if (standalone) {
          window.location.href = startResult.body.authorizationUrl;
        }
        return { options, oauthAttemptId: startResult.body.oauthAttemptId };
      })(),
      () => {
        if (authWindow && !navigated) {
          if (signal.aborted) {
            authWindow.close();
          } else {
            authWindow.location.href = connectorRedirectingPath({
              connectorSlug: args.connectorSlug,
              label: args.connectorLabel,
              icon: args.connectorIcon,
              status: "error",
            });
          }
        }
      },
    );
    signal.throwIfAborted();

    return { authWindow, oauthAttemptId, options };
  },
);

const completeConnectorOAuthAuthCodeFlow$ = command(
  async (
    { get, set },
    args: {
      readonly flowId: string;
      readonly connectorSlug: ConnectorSlug;
      readonly method: PublicConnectorCatalogAuthMethodDetail;
      readonly options: PostConnectOptions;
      readonly account: PlatformConnectorAccountMutationIntent;
      readonly oauthStart: {
        readonly authWindow: Window | null;
        readonly oauthAttemptId: string;
      };
    },
    signal: AbortSignal,
  ): Promise<ConnectorConnectionResult | false> => {
    const { flowId, connectorSlug, method, options, account, oauthStart } =
      args;
    set(internalConnectorOAuthAuthCodeWaitState$, {
      status: "waiting",
      flowId,
      connectorSlug,
      account,
      oauthAttemptId: oauthStart.oauthAttemptId,
    });

    const waitSignal = set(resetOAuthAuthCodeWaitSignal$, signal);
    const changedPromise = (async () => {
      await set(
        setAblyPayloadLoop$,
        {
          topic: "connector:changed",
          loopCommand$: onActiveConnectorChanged$,
          initializeCommand$: refreshActiveConnectorOAuthAuthCodeCompletion$,
        },
        waitSignal,
      );
      return "connectorChanged" as const;
    })();
    const waitResult = await withCleanup(
      oauthStart.authWindow === null
        ? changedPromise
        : Promise.race([
            changedPromise,
            waitForOAuthAuthCodePopupClosed(oauthStart.authWindow, waitSignal),
          ]),
      () => {
        set(resetOAuthAuthCodeWaitSignal$, signal);
      },
    );
    signal.throwIfAborted();

    if (waitResult === "popupClosed") {
      await set(
        refreshConnectorOAuthAuthCodeCompletion$,
        flowId,
        oauthStart.oauthAttemptId,
        signal,
      );
      signal.throwIfAborted();
    }
    const completed = get(internalConnectorOAuthAuthCodeWaitState$);
    if (
      !connectorOAuthAuthCodeWaitIsCurrent(
        completed,
        flowId,
        oauthStart.oauthAttemptId,
      ) ||
      completed.status !== "completed"
    ) {
      return false;
    }
    const completedConnectionId = completed.connectionId;

    set(reloadConnectorConnectionState$);
    const isConnected =
      !options.useDefaultConnectorProjection ||
      (await set(
        defaultConnectorProjectionMatchesAuthMethod$,
        connectorSlug,
        method.id,
        completedConnectionId,
        signal,
      ));
    if (isConnected) {
      await set(
        finishConnectorConnection$,
        connectorSlug,
        {
          ...options,
          clearSelectedConnector: true,
          reloadConnectors: false,
          toastMessage: null,
        },
        signal,
      );
    }
    return isConnected ? { connectionId: completedConnectionId } : false;
  },
);

const connectConnectorOAuthAuthCodeCommand$ = command(
  async (
    { get, set },
    connectorSlug: ConnectorSlug,
    method: PublicConnectorCatalogAuthMethodDetail,
    options: BrowserAuthPostConnectOptions,
    signal: AbortSignal,
  ): Promise<ConnectorConnectionResult | false> => {
    signal.throwIfAborted();
    if (
      connectorConnectOperationIsActive({
        authCodeConnectorSlug: get(internalPollingOAuthAuthCodeConnectorSlug$),
        connectFlow: get(internalConnectFlowState$),
        deviceAuthState: get(internalConnectorOAuthDeviceAuthState$),
        externalCodeState: get(internalConnectorExternalCodeState$),
      })
    ) {
      return false;
    }

    const flow = createConnectorConnectFlowState(connectorSlug);
    const account = options.account;
    set(internalConnectFlowState$, flow);
    set(internalPollingOAuthAuthCodeConnectorSlug$, connectorSlug);

    return await withCleanup(
      (async () => {
        const oauthStart = await set(
          openConnectorOAuthAuthCodeWindow$,
          {
            connectorSlug,
            method,
            connectorLabel: options.connectorLabel ?? connectorSlug,
            connectorIcon: options.connectorIcon,
            agentId: options.agentId,
            account,
            beforeStart: async (sig) => {
              const resolvedOptions = await set(
                resolveConnectorPostConnectOptions$,
                connectorSlug,
                options,
                sig,
              );
              return resolvedOptions;
            },
          },
          signal,
        );
        signal.throwIfAborted();
        return await set(
          completeConnectorOAuthAuthCodeFlow$,
          {
            flowId: flow.id,
            connectorSlug,
            method,
            options: oauthStart.options,
            account,
            oauthStart,
          },
          signal,
        );
      })(),
      () => {
        set(internalPollingOAuthAuthCodeConnectorSlug$, (current) => {
          return current === connectorSlug ? null : current;
        });
        set(internalConnectorOAuthAuthCodeWaitState$, (current) => {
          return current?.flowId === flow.id ? null : current;
        });
        set(internalConnectFlowState$, (current) => {
          return current?.id === flow.id ? null : current;
        });
      },
    );
  },
);

export const connectConnectorOAuthAuthCode$ = withConnectorConnectionProgress(
  connectConnectorOAuthAuthCodeCommand$,
);

// ---------------------------------------------------------------------------
// Connect via browser authorization, then run onSuccess callback.
// ---------------------------------------------------------------------------

const connectConnectorOAuthAuthCodeAndSettleCommand$ = command(
  async (
    { set },
    args: {
      readonly connectorSlug: ConnectorSlug;
      readonly method: PublicConnectorCatalogAuthMethodDetail;
      readonly onSuccess: (connectionId: string | null) => void | Promise<void>;
      readonly options: BrowserAuthPostConnectOptions;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const connected = await set(
      connectConnectorOAuthAuthCode$,
      args.connectorSlug,
      args.method,
      args.options,
      signal,
    );
    if (connected) {
      signal.throwIfAborted();
      await args.onSuccess(connected.connectionId);
    }
  },
);

export const connectConnectorOAuthAuthCodeAndSettle$ =
  withConnectorConnectionProgress(
    connectConnectorOAuthAuthCodeAndSettleCommand$,
  );

/** Menu actions disappear on activation and need their own progress feedback. */
export const connectConnectorOAuthAuthCodeWithDialogAndSettle$ =
  withConnectorConnectionProgress(
    connectConnectorOAuthAuthCodeAndSettleCommand$,
    { showDialog: true },
  );
