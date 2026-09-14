import { command, computed, state, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { connectorsMainContract } from "@okouai/api-contracts/contracts/connectors";
import {
  connectorCatalogContract,
  type ConnectorCatalogProtocolScope,
  type PublicConnectorCatalogDiscoveryResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { apiClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { featureSwitch$ } from "./feature-switch.ts";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";

export const builtinConnectorMcpEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.BuiltinConnectorMcp] === true;
});

/** Display-only qualification; identity and permissions always use the slug. */
function presentConnectorCatalogItem(
  connector: PlatformConnectorCatalogStatusItem,
  distinguishProtocols: boolean,
): PlatformConnectorCatalogStatusItem {
  if (!distinguishProtocols) {
    return connector;
  }
  const protocol = connector.protocol === "mcp" ? "MCP" : "HTTP API";
  return { ...connector, label: `${connector.label} · ${protocol}` };
}

/**
 * Reload trigger for connector signals.
 * Increment to force recomputation of connectors$.
 */
const internalReloadConnectors$ = state(0);

export const connectorsReloadVersion$ = computed((get) => {
  return get(internalReloadConnectors$);
});

/**
 * Current user's connectors.
 */
export const connectors$ = computed(async (get) => {
  get(connectorsReloadVersion$);
  get(featureSwitch$);

  const createClient = get(apiClient$);
  const client = createClient(connectorsMainContract);
  const result = await accept(client.list(), [200]);
  return result.body;
});

/**
 * Public connector catalog metadata joined with the current user's connector status.
 */
export const connectorCatalogStatus$ = computed(async (get) => {
  get(connectorsReloadVersion$);
  const distinguishProtocols = get(builtinConnectorMcpEnabled$);
  get(featureSwitch$);

  const createClient = get(apiClient$);
  const client = createClient(connectorCatalogContract);
  const result = await accept(
    client.status({ query: { protocol: "all" } }),
    [200],
  );
  return {
    ...result.body,
    connectors: result.body.connectors.map((connector) => {
      return presentConnectorCatalogItem(connector, distinguishProtocols);
    }),
  };
});

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
  protocol$?: Computed<ConnectorCatalogProtocolScope>,
): Computed<Promise<PublicConnectorCatalogDiscoveryResponse>> {
  return computed(async (get) => {
    get(connectorsReloadVersion$);
    get(featureSwitch$);
    const keyword = get(keyword$).trim();
    const category = category$ ? get(category$) : null;
    const protocol = protocol$ ? get(protocol$) : "all";
    const distinguishProtocols = get(builtinConnectorMcpEnabled$);
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(
      client.discovery({
        query: {
          protocol,
          ...(keyword ? { keyword } : {}),
          ...(!keyword && category ? { category } : {}),
        },
      }),
      [200],
    );
    return {
      ...result.body,
      connectors: result.body.connectors
        .filter((connector) => {
          return (
            protocol === "all" || (connector.protocol ?? "http") === protocol
          );
        })
        .map((connector) => {
          return presentConnectorCatalogItem(connector, distinguishProtocols);
        }),
    };
  });
}

export function connectorCatalogItemBySlug(
  connectorSlug: ConnectorSlug,
): Computed<Promise<PlatformConnectorCatalogStatusItem | null>> {
  return computed(async (get) => {
    get(connectorsReloadVersion$);
    get(featureSwitch$);
    const distinguishProtocols = get(builtinConnectorMcpEnabled$);
    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(
      client.get({ params: { connectorSlug } }),
      [200, 404],
    );
    return result.status === 200
      ? presentConnectorCatalogItem(result.body.connector, distinguishProtocols)
      : null;
  });
}

export const loadConnectorCatalogItem$ = command(
  async (
    { get },
    connectorSlug: ConnectorSlug,
    signal: AbortSignal,
  ): Promise<PlatformConnectorCatalogStatusItem | null> => {
    const distinguishProtocols = get(builtinConnectorMcpEnabled$);
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
    return result.status === 200
      ? presentConnectorCatalogItem(result.body.connector, distinguishProtocols)
      : null;
  },
);

/**
 * Trigger a reload of connectors data.
 */
export const reloadConnectors$ = command(({ set }) => {
  set(internalReloadConnectors$, (x) => {
    return x + 1;
  });
});
