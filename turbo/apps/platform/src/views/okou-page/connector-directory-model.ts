import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";

import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import {
  groupConnectorsByCategory,
  type ConnectorCategorySection,
} from "../../signals/okou-page/settings/connector-categories.ts";
import {
  buildConnectorShelves,
  type ConnectorShelfLayout,
} from "../../signals/okou-page/settings/connector-shelves.ts";
import {
  builtinConnectorCurrentConnectionStatus,
  matchesConnectorDirectorySearch,
} from "../../signals/okou-page/settings/connectors.ts";
import { customConnectorTarget } from "./components/settings/custom-connector-display.ts";
import { connectorCategoryLabels } from "./components/settings/connector-category-labels.ts";

export interface ConnectorDirectoryModel {
  /** Connected connectors whose connection or permissions need a fix. */
  readonly attention: readonly PlatformConnectorCatalogStatusItem[];
  /**
   * Connected connectors matching the current search. Discovery only offers
   * what can be added, so without these a search for something already
   * connected would answer "no match".
   */
  readonly matchedConnected: readonly PlatformConnectorCatalogStatusItem[];
  readonly discover: readonly PlatformConnectorCatalogStatusItem[];
  readonly custom: readonly CustomConnectorResponse[];
  readonly customAttention: readonly CustomConnectorResponse[];
  readonly categorySections: readonly ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[];
  /**
   * The categories the chip row offers. They come from the browse response
   * rather than from what is currently shown, because a chip row that empties
   * itself when you pick a chip cannot be used to pick another one.
   */
  readonly chipSections: readonly ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[];
  /** Shelves for the default browse view: no search, no chosen category. */
  readonly shelfLayout: ConnectorShelfLayout<PlatformConnectorCatalogStatusItem>;
  readonly bySlug: ReadonlyMap<
    ConnectorSlug,
    PlatformConnectorCatalogStatusItem
  >;
  readonly categoryLabelOf: (category: string) => string | undefined;
}

export function currentDirectoryAccountSummaries(
  connectors: readonly PlatformConnectorCatalogStatusItem[],
  summaries: ReadonlyMap<string, ConnectorAccountSummary> | undefined,
): ReadonlyMap<string, ConnectorAccountSummary> | undefined {
  if (!summaries) {
    return undefined;
  }
  const current = new Map(summaries);
  for (const connector of connectors) {
    const key = `builtin:${connector.slug}`;
    const summary = summaries.get(key);
    if (!summary?.defaultConnection) {
      continue;
    }
    const account = summary.defaultConnection;
    if (
      account.connectionStatus !== "connected" ||
      account.authMethod !== connector.connection?.authMethod
    ) {
      continue;
    }
    const status = builtinConnectorCurrentConnectionStatus({
      ...connector,
      connectionStatus: account.connectionStatus,
      tokenExpiresAt: account.tokenExpiresAt,
    });
    if (status === "reconnect-required") {
      current.set(key, {
        ...summary,
        attentionCount: summary.attentionCount + 1,
        defaultConnection: { ...account, connectionStatus: status },
      });
    }
  }
  return current;
}

function needsAttention(
  connector: PlatformConnectorCatalogStatusItem,
  summary: ConnectorAccountSummary | undefined,
): boolean {
  const status = builtinConnectorCurrentConnectionStatus(connector);
  return (
    (summary?.attentionCount ?? 0) > 0 ||
    summary?.defaultConnection === null ||
    status === "scope-mismatch"
  );
}

function matchesCustomConnectorSearch(
  search: string,
  connector: CustomConnectorResponse,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    connector.displayName,
    connector.slug,
    customConnectorTarget(connector),
  ].some((value) => {
    return value.toLowerCase().includes(needle);
  });
}

function customConnectorGroups(
  connectors: readonly CustomConnectorResponse[],
  summaries: ReadonlyMap<string, ConnectorAccountSummary> | undefined,
) {
  const customAttention = connectors.filter((connector) => {
    const summary = summaries?.get(`custom:${connector.id}`);
    return (
      !isIntegrationManagedCustomConnector(connector) &&
      summary !== undefined &&
      summary.accountCount > 0 &&
      (summary.attentionCount > 0 ||
        summary.defaultConnection === null ||
        !connector.connected)
    );
  });
  const attentionIds = new Set(
    customAttention.map((connector) => {
      return connector.id;
    }),
  );
  return {
    customAttention,
    custom: connectors.filter((connector) => {
      return !attentionIds.has(connector.id);
    }),
  };
}

/**
 * Derives everything the directory renders from the raw connector lists, so the
 * dialog stays a view: which connected connectors need a fix, what discovery
 * shows for the current search and category.
 */
export function buildConnectorDirectoryModel({
  connectors,
  customConnectors,
  accountSummaries,
  chipCatalog,
  search,
  category,
  otherCategoryLabel,
  categoryCounts,
  headShelfLabel,
}: {
  readonly connectors: readonly PlatformConnectorCatalogStatusItem[];
  readonly customConnectors: readonly CustomConnectorResponse[];
  /** Undefined means account metadata is not currently available, not zero. */
  readonly accountSummaries:
    ReadonlyMap<string, ConnectorAccountSummary> | undefined;
  /** Every connector the browse response carried, for the chip row. */
  readonly chipCatalog: readonly PlatformConnectorCatalogStatusItem[];
  readonly search: string;
  readonly category: string | null;
  readonly otherCategoryLabel: string;
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly headShelfLabel: string;
}): ConnectorDirectoryModel {
  const connected = connectors.filter((connector) => {
    return (
      (accountSummaries?.get(`builtin:${connector.slug}`)?.accountCount ?? 0) >
      0
    );
  });
  const unconnected = connectors.filter((connector) => {
    return (
      accountSummaries !== undefined &&
      (accountSummaries.get(`builtin:${connector.slug}`)?.accountCount ?? 0) ===
        0
    );
  });
  const connectedCustom = customConnectors.filter((connector) => {
    return isIntegrationManagedCustomConnector(connector)
      ? connector.connected
      : (accountSummaries?.get(`custom:${connector.id}`)?.accountCount ?? 0) >
          0;
  });
  const unconnectedCustom = customConnectors.filter((connector) => {
    return (
      !isIntegrationManagedCustomConnector(connector) &&
      accountSummaries !== undefined &&
      (accountSummaries.get(`custom:${connector.id}`)?.accountCount ?? 0) === 0
    );
  });
  const requiresAttention = (connector: PlatformConnectorCatalogStatusItem) => {
    return needsAttention(
      connector,
      accountSummaries?.get(`builtin:${connector.slug}`),
    );
  };
  const matchedConnected = connected.filter((connector) => {
    return matchesConnectorDirectorySearch(search, connector);
  });
  const attention = connected.filter(requiresAttention);
  const searchedConnected = matchedConnected.filter((connector) => {
    return !requiresAttention(connector);
  });
  const discover = unconnected.filter((connector) => {
    return (
      matchesConnectorDirectorySearch(search, connector) &&
      (category === null || connector.category === category)
    );
  });
  const matchedCustom = [...connectedCustom, ...unconnectedCustom].filter(
    (connector) => {
      return matchesCustomConnectorSearch(search, connector);
    },
  );
  const { custom, customAttention } = customConnectorGroups(
    matchedCustom,
    accountSummaries,
  );
  const categoryMetadata = connectorCategoryLabels(
    [...unconnected, ...chipCatalog].map((connector) => {
      return connector.category;
    }),
  );
  const sectionsOf = (
    items: readonly PlatformConnectorCatalogStatusItem[],
  ): ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[] => {
    return groupConnectorsByCategory(
      items,
      categoryMetadata,
      otherCategoryLabel,
    ).flatMap((group) => {
      return group.sections;
    });
  };
  const categorySections = sectionsOf(unconnected);
  const chipSections = sectionsOf(chipCatalog);
  const shelfLayout = buildConnectorShelves({
    sections: categorySections,
    categoryCounts,
    headLabel: headShelfLabel,
    // The dialog's card grid is two wide, so four is two whole rows.
    previewSize: 4,
  });
  const categoryLabels = new Map(
    categorySections.map((section) => {
      return [section.category, section.label];
    }),
  );

  return {
    attention,
    matchedConnected: search.trim() ? searchedConnected : [],
    discover,
    custom,
    customAttention,
    categorySections,
    chipSections,
    shelfLayout,
    bySlug: new Map(
      [...connected, ...unconnected].map((connector) => {
        return [connector.slug, connector];
      }),
    ),
    categoryLabelOf: (value) => {
      return categoryLabels.get(value);
    },
  };
}
