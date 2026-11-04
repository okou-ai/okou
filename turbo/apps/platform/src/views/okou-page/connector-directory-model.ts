import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { isIntegrationManagedCustomConnector } from "@okouai/api-contracts/validators/custom-connectors";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";

import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import {
  groupConnectorsByCategory,
  type ConnectorCategorySection,
} from "../../signals/okou-page/settings/connector-categories.ts";
import {
  buildConnectorShelves,
  type ConnectorShelfLayout,
} from "../../signals/okou-page/settings/connector-shelves.ts";
import { matchesConnectorDirectorySearch } from "../../signals/okou-page/settings/connectors.ts";
import { customConnectorTarget } from "./components/settings/custom-connector-display.ts";
import { connectorCategoryLabels } from "./components/settings/connector-category-labels.ts";

export interface ConnectorDirectoryModel {
  /**
   * Connected connectors matching the current search. Discovery only offers
   * what can be added, so without these a search for something already
   * connected would answer "no match".
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
 * dialog stays a view: saved membership and discovery for the current search
 * and category. Account readiness belongs to the opened target.
 */
export function buildConnectorDirectoryModel({
  connectors,
  customConnectors,
  connectedTargets,
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
  readonly connectedTargets: ReadonlySet<string> | undefined;
  /** Every connector the browse response carried, for the chip row. */
  readonly chipCatalog: readonly PlatformConnectorCatalogStatusItem[];
  readonly search: string;
  readonly category: string | null;
  readonly otherCategoryLabel: string;
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly headShelfLabel: string;
}): ConnectorDirectoryModel {
  const connected = connectors.filter((connector) => {
    return connectedTargets?.has(`builtin:${connector.slug}`) === true;
  });
  const unconnected = connectors.filter((connector) => {
    return (
      connectedTargets !== undefined &&
      !connectedTargets.has(`builtin:${connector.slug}`)
    );
  });
  const connectedCustom = customConnectors.filter((connector) => {
    return isIntegrationManagedCustomConnector(connector)
      ? connector.connected
      : connectedTargets?.has(`custom:${connector.id}`) === true;
  });
  const unconnectedCustom = customConnectors.filter((connector) => {
    return (
      !isIntegrationManagedCustomConnector(connector) &&
      connectedTargets !== undefined &&
      !connectedTargets.has(`custom:${connector.id}`)
    );
  });
  const matchedConnected = connected.filter((connector) => {
    return matchesConnectorDirectorySearch(search, connector);
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
    matchedConnected: search.trim() ? matchedConnected : [],
    discover,
    custom: matchedCustom,
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
