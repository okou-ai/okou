import { command, computed, state, type Computed } from "ccstate";
import { builtinConnectorsMainContract } from "@okouai/api-contracts/contracts/connectors";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogDiscoveryResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { apiClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "./feature-switch.ts";
import type {
  PlatformConnectorCatalogConnectItem,
  PlatformConnectorCatalogStatusItem,
} from "../connector-domain.ts";

/**
 * Reload trigger for connector signals.
 * Increment to force recomputation of connectors$.
 */
const internalReloadBuiltinConnectors$ = state(0);

export const builtinConnectorsReloadVersion$ = computed((get) => {
  return get(internalReloadBuiltinConnectors$);
});

/**
 * Current user's connectors.
 */
export const builtinConnectors$ = computed(async (get) => {
  get(builtinConnectorsReloadVersion$);
  get(featureSwitch$);

  const createClient = get(apiClient$);
  const client = createClient(builtinConnectorsMainContract);
  const result = await accept(client.list(), [200]);
  return result.body;
});

/**
 * Public connector catalog metadata joined with the current user's connector status.
 */
export const connectorCatalogStatus$ = computed(async (get) => {
  get(builtinConnectorsReloadVersion$);
  get(featureSwitch$);

  const createClient = get(apiClient$);
  const client = createClient(connectorCatalogContract);
  const result = await accept(client.status(), [200]);
  return result.body;
});

/**
 * Every connector that connects in one browser step, each with what its card
 * draws and what starting the connection from one click needs.
 */
export const oneClickConnectorCatalog$ = computed(
  async (get): Promise<readonly PlatformConnectorCatalogConnectItem[]> => {
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);

    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(client.oneClick(), [200]);
    return result.body.connectors;
  },
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
    return result.status === 200 ? result.body.connector : null;
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
    return result.status === 200 ? result.body.connector : null;
  },
);

/**
 * Trigger a reload of connectors data.
 */
export const reloadBuiltinConnectors$ = command(({ set }) => {
  set(internalReloadBuiltinConnectors$, (x) => {
    return x + 1;
  });
});
