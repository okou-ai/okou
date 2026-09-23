import { command, computed, state, type Computed } from "ccstate";
import { builtinConnectorsMainContract } from "@okouai/api-contracts/contracts/connectors";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogBrief,
  type PublicConnectorCatalogDiscoveryResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { apiClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "./feature-switch.ts";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";

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
 * The catalog item for whichever connector `connectorSlug$` currently names,
 * or `null` when it names none or the catalog does not offer it.
 */
export function connectorCatalogItemForSlug(
  connectorSlug$: Computed<ConnectorSlug | null>,
): Computed<Promise<PlatformConnectorCatalogStatusItem | null>> {
  return computed(async (get) => {
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);
    const connectorSlug = get(connectorSlug$);
    if (connectorSlug === null) {
      return null;
    }
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
 * Catalog items for a small, known set of connectors, one request per slug.
 * Slugs the catalog does not offer are absent from the map.
 */
export function connectorCatalogItemsForSlugs(
  connectorSlugs$: Computed<readonly ConnectorSlug[]>,
): Computed<
  Promise<ReadonlyMap<ConnectorSlug, PlatformConnectorCatalogStatusItem>>
> {
  return computed(async (get) => {
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);
    const connectorSlugs = [...new Set(get(connectorSlugs$))];
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const results = await Promise.all(
      connectorSlugs.map((connectorSlug) => {
        return accept(client.get({ params: { connectorSlug } }), [200, 404]);
      }),
    );
    return new Map(
      results.flatMap((result) => {
        return result.status === 200
          ? [[result.body.connector.slug, result.body.connector] as const]
          : [];
      }),
    );
  });
}

/**
 * Slug, label, and icon for a known set of connectors in one request. Slugs the
 * current user cannot see are absent from the map.
 */
export function connectorCatalogBriefs(
  connectorSlugs: readonly ConnectorSlug[],
): Computed<Promise<ReadonlyMap<ConnectorSlug, PublicConnectorCatalogBrief>>> {
  const requested = [...new Set(connectorSlugs)].sort();
  return computed(async (get) => {
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(
      client.list({
        query: { view: "brief", slugs: requested.join(",") },
      }),
      [200],
    );
    // An API that predates `view=brief` returns the full list; both shapes
    // carry the brief fields, so keep only the requested slugs.
    const wanted = new Set<string>(requested);
    return new Map(
      result.body.connectors.flatMap((connector) => {
        return wanted.has(connector.slug)
          ? [
              [
                connector.slug,
                {
                  slug: connector.slug,
                  label: connector.label,
                  icon: connector.icon,
                  category: connector.category,
                  generation: connector.generation,
                },
              ] as const,
            ]
          : [];
      }),
    );
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
