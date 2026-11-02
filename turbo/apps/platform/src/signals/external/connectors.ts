import { command, computed, state, type Computed } from "ccstate";
import { connectorCatalogContract } from "@okouai/api-contracts/client/connector-catalog";
import type {
  PublicConnectorCatalogDiscoveryResponse,
  PublicConnectorCatalogConnectItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { builtinConnectorAccountFacts } from "@okouai/api-contracts/validators/connector-accounts";
import { connectorAccountsContract } from "@okouai/api-contracts/client/connector-accounts";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  reloadUserConnectedConnectors$,
  userConnectedConnectors$,
} from "../okou-page/connector-overview.ts";
import { builtinConnectorAccountProjectionVersion$ } from "../okou-page/connector-account-projection.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { apiClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "./feature-switch.ts";
import type {
  PlatformConnectorCatalogStatusItem,
  PlatformConnectorConnectionStatus,
} from "../connector-domain.ts";

/** Catalog visibility and usable default-account completion are separate facts. */
export function withConnectorCompletion<
  T extends PublicConnectorCatalogConnectItem,
>(item: T) {
  return withMemberAccount(item, null);
}

/**
 * Reload trigger for connector signals.
 * Increment to force recomputation of connectors$.
 */
const internalReloadBuiltinConnectors$ = state(0);

function memberAccountConnectionStatus(
  account: ConnectorAccountConnection | null | undefined,
  scopeMismatch: boolean | undefined,
): PlatformConnectorConnectionStatus | undefined {
  if (!account) {
    return "not-connected";
  }
  if (account.connectionStatus === "reconnect-required") {
    return "reconnect-required";
  }
  if (scopeMismatch === undefined) {
    return undefined;
  }
  return scopeMismatch ? "scope-mismatch" : "connected";
}

/** Project a known canonical default for UI; unknown setup never claims readiness. */
export function withMemberAccount<T extends PublicConnectorCatalogConnectItem>(
  item: T,
  account: ConnectorAccountConnection | null | undefined,
) {
  const facts = account
    ? builtinConnectorAccountFacts(item, account)
    : undefined;
  const connectionStatus = memberAccountConnectionStatus(
    account,
    facts?.scopeMismatch,
  );
  return {
    ...item,
    connected:
      account?.connectionStatus === "connected" &&
      connectionStatus !== undefined &&
      (account.tokenExpiresAt === null || facts?.supportsRefresh !== undefined),
    connectionStatus,
    scopeMismatch: account ? facts?.scopeMismatch : false,
    authMethodSupportsRefresh: account ? facts?.supportsRefresh : false,
    tokenExpiresAt: account?.tokenExpiresAt ?? null,
    connection: account
      ? {
          id: account.id,
          authMethod: account.authMethod,
          externalUsername: account.externalUsername,
          externalEmail: account.externalEmail,
          reconnectReason: account.reconnectReason,
        }
      : null,
  };
}

/** Visible connect lists read defaults only for their saved member targets. */
export function withBuiltinConnectorDefaults<
  T extends PublicConnectorCatalogConnectItem,
>(items$: Computed<Promise<readonly T[]>>) {
  return computed(async (get) => {
    get(builtinConnectorsReloadVersion$);
    const accounts = get(apiClient$)(connectorAccountsContract);
    const [items, membership] = await Promise.all([
      get(items$),
      get(userConnectedConnectors$),
    ]);
    const saved = new Set(
      membership.builtinConnectors.map((connector) => {
        return connector.slug;
      }),
    );
    const projected = await Promise.all(
      items.map(async (connector) => {
        if (!saved.has(connector.slug)) {
          return withConnectorCompletion(connector);
        }
        const response = await accept(
          accounts.connections({
            query: {
              kind: "builtin",
              connectorSlug: connector.slug,
              limit: 1,
              includeScopeMismatch: "true",
            },
          }),
          [200, 404],
        );
        if (response.status === 404) {
          return null;
        }
        return withMemberAccount(connector, response.body.defaultConnection);
      }),
    );
    return projected.flatMap((connector) => {
      return connector ? [connector] : [];
    });
  });
}

export const builtinConnectorsReloadVersion$ = computed((get) => {
  return (
    get(internalReloadBuiltinConnectors$) +
    get(builtinConnectorAccountProjectionVersion$)
  );
});

/**
 * Catalog metadata initialized for UI; account readiness is loaded separately.
 */
export const connectorCatalogStatus$ = computed(async (get) => {
  get(builtinConnectorsReloadVersion$);
  get(featureSwitch$);

  const createClient = get(apiClient$);
  const client = createClient(connectorCatalogContract);
  const result = await accept(client.status(), [200]);
  return {
    ...result.body,
    connectors: result.body.connectors.map(withConnectorCompletion),
  };
});

/**
 * Every connector that connects in one browser step, each with what its card
 * draws and what starting the connection from one click needs.
 */
export const oneClickConnectorCatalog$ = withBuiltinConnectorDefaults(
  computed(async (get) => {
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);

    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(client.oneClick(), [200]);
    return result.body.connectors;
  }),
);

export const connectorCatalogStatusBySlug$ = computed(async (get) => {
  const { connectors } = await get(connectorCatalogStatus$);
  return new Map(
    connectors.map((connector) => {
      return [connector.slug, connector];
    }),
  );
});

/**
 * Discovery for a browse surface. A category, when one is chosen, is asked for
 * by name so the response holds the whole category rather than the slice the
 * unfiltered call returns for every category.
 */
export function relatedConnectorCatalog(
  keyword$: Computed<string>,
  category$?: Computed<string | null>,
): Computed<Promise<PublicConnectorCatalogDiscoveryResponse>> {
  return computed(async (get) => {
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);
    const keyword = get(keyword$).trim();
    const category = category$ ? get(category$) : null;
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(
      client.discovery({
        query: {
          ...(keyword ? { keyword } : {}),
          ...(!keyword && category ? { category } : {}),
        },
      }),
      [200],
    );
    return result.body;
  });
}

export function connectorCatalogItemBySlug(
  connectorSlug: ConnectorSlug,
): Computed<Promise<PlatformConnectorCatalogStatusItem | null>> {
  return computed(async (get) => {
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(
      client.get({ params: { connectorSlug } }),
      [200, 404],
    );
    return result.status === 200
      ? withConnectorCompletion(result.body.connector)
      : null;
  });
}

/**
 * The catalog entry for whichever connector `connectorSlug$` currently names.
 * The per-slug lookup is rebuilt only when the slug changes, so a single-item
 * surface loads the one entry it shows instead of the full catalog status.
 */
export function connectorCatalogItemForSlug(
  connectorSlug$: Computed<ConnectorSlug | null>,
): Computed<Promise<PlatformConnectorCatalogStatusItem | null>> {
  const lookup$ = computed((get) => {
    const connectorSlug = get(connectorSlug$);
    return connectorSlug === null
      ? null
      : connectorCatalogItemBySlug(connectorSlug);
  });
  return computed(async (get) => {
    const item$ = get(lookup$);
    return item$ === null ? null : await get(item$);
  });
}

/**
 * Catalog entries for a short list of connectors, one per-slug lookup each.
 * Meant for a handful of slugs; a surface listing many belongs on an endpoint
 * of its own.
 */
export function connectorCatalogItemsForSlugs(
  connectorSlugs$: Computed<readonly ConnectorSlug[]>,
): Computed<Promise<readonly PlatformConnectorCatalogStatusItem[]>> {
  // Joined, so an equal list recomputed from its source keeps its lookups.
  const key$ = computed((get) => {
    return get(connectorSlugs$).join(",");
  });
  const lookups$ = computed((get) => {
    const key = get(key$);
    return key === ""
      ? []
      : key.split(",").map((connectorSlug) => {
          return connectorCatalogItemBySlug(connectorSlug);
        });
  });
  return computed(async (get) => {
    const pending = get(lookups$).map((lookup$) => {
      return get(lookup$);
    });
    const items = await Promise.all(pending);
    return items.flatMap((item) => {
      return item ? [item] : [];
    });
  });
}

export const loadConnectorCatalogItem$ = command(
  async (
    { get },
    connectorSlug: ConnectorSlug,
    signal: AbortSignal,
  ): Promise<PlatformConnectorCatalogStatusItem | null> => {
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(
      client.get({
        params: { connectorSlug },
        fetchOptions: { signal },
      }),
      [200, 404],
      signal,
      { showErrorToast: false },
    );
    // Callback pages need public metadata even when the user is signed out.
    return result.status === 200
      ? withConnectorCompletion(result.body.connector)
      : null;
  },
);

/**
 * Trigger a reload of connectors data.
 */
export const reloadBuiltinConnectors$ = command(({ set }) => {
  set(reloadUserConnectedConnectors$);
  set(internalReloadBuiltinConnectors$, (x) => {
    return x + 1;
  });
});

/** Visible connector surfaces own the subscription and re-read on attachment. */
export const subscribeBuiltinConnectorChanges$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyInvalidationLoop$,
      {
        topic: "connector:changed",
        invalidations: [reloadBuiltinConnectors$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);
