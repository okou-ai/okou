import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { PublicConnectorCatalogCategoryMetadata } from "@okouai/api-contracts/contracts/connector-catalog";

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
import { localizeConnectorCategoryMetadata } from "./components/settings/connector-category-labels.ts";

export interface ConnectorDirectoryModel {
  /** Connected connectors whose connection or permissions need a fix. */
  readonly attention: readonly PlatformConnectorCatalogStatusItem[];
  /**
   * Connected connectors matching the current search, or the connector still
   * finishing its authorization. Keep that card visible after its account
   * refreshes so progress does not disappear before the flow settles.
   */
  readonly matchedConnected: readonly PlatformConnectorCatalogStatusItem[];
  readonly discover: readonly PlatformConnectorCatalogStatusItem[];
  readonly custom: readonly CustomConnectorResponse[];
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

function needsAttention(
  connector: PlatformConnectorCatalogStatusItem,
): boolean {
  const status = builtinConnectorCurrentConnectionStatus(connector);
  return status === "reconnect-required" || status === "scope-mismatch";
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

/**
 * Derives everything the directory renders from the raw connector lists, so the
 * dialog stays a view: which connected connectors need a fix, what discovery
 * shows for the current search and category.
 */
export function buildConnectorDirectoryModel({
  connected,
  unconnected,
  chipCatalog,
  connectedCustom,
  unconnectedCustom,
  connectingSlug,
  search,
  category,
  categoryMetadata,
  otherCategoryLabel,
  categoryCounts,
  headShelfLabel,
}: {
  readonly connected: readonly PlatformConnectorCatalogStatusItem[];
  readonly unconnected: readonly PlatformConnectorCatalogStatusItem[];
  /** Every connector the browse response carried, for the chip row. */
  readonly chipCatalog: readonly PlatformConnectorCatalogStatusItem[];
  readonly connectedCustom: readonly CustomConnectorResponse[];
  readonly unconnectedCustom: readonly CustomConnectorResponse[];
  readonly connectingSlug: ConnectorSlug | null;
  readonly search: string;
  readonly category: string | null;
  readonly categoryMetadata: PublicConnectorCatalogCategoryMetadata | undefined;
  readonly otherCategoryLabel: string;
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly headShelfLabel: string;
}): ConnectorDirectoryModel {
  const matchedConnected = connected.filter((connector) => {
    return matchesConnectorDirectorySearch(search, connector);
  });
  const attention = connected.filter(needsAttention);
  const searchedConnected = matchedConnected.filter((connector) => {
    return !needsAttention(connector);
  });
  const discover = unconnected.filter((connector) => {
    return (
      matchesConnectorDirectorySearch(search, connector) &&
      (category === null || connector.category === category)
    );
  });
  const custom = [...connectedCustom, ...unconnectedCustom].filter(
    (connector) => {
      return matchesCustomConnectorSearch(search, connector);
    },
  );
  const localizedMetadata = localizeConnectorCategoryMetadata(categoryMetadata);
  const sectionsOf = (
    items: readonly PlatformConnectorCatalogStatusItem[],
  ): ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[] => {
    return groupConnectorsByCategory(
      items,
      localizedMetadata,
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
    matchedConnected: search.trim()
      ? searchedConnected
      : searchedConnected.filter((connector) => {
          return connector.slug === connectingSlug;
        }),
    discover,
    custom,
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
