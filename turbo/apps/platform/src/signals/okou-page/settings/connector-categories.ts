import type { PublicConnectorCatalogCategoryMetadata } from "@okouai/api-contracts/contracts/connector-catalog";

export interface ConnectorCategorySection<T> {
  category: string;
  label: string;
  menuLabel: string;
  groupId: string | null;
  connectors: T[];
}

export interface ConnectorCategoryGroup<T> {
  id: string;
  kind: "category" | "group";
  label: string;
  menuLabel: string;
  sections: [ConnectorCategorySection<T>, ...ConnectorCategorySection<T>[]];
}

function fallbackCategoryLabel(category: string): string {
  const label = category
    .split(/[-_\s]+/)
    .filter((part) => {
      return part.length > 0;
    })
    .map((part) => {
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
  return label;
}

/**
 * Connected first, then discovery rank, then label. Ordering a 1 184-connector
 * category alphabetically means it opens on "123FormBuilder, 1Password,
 * 1SaaS", so the rank the catalog carries decides the head of every category
 * and the alphabet only breaks ties in the unranked tail.
 */
function sortedCategoryConnectors<
  T extends {
    connected: boolean;
    label: string;
    popularityRank?: number;
  },
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.connected !== b.connected) {
      return a.connected ? -1 : 1;
    }
    const rankDelta =
      (a.popularityRank ?? Number.MAX_SAFE_INTEGER) -
      (b.popularityRank ?? Number.MAX_SAFE_INTEGER);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return a.label.localeCompare(b.label);
  });
}

export function groupConnectorsByCategory<
  T extends {
    category: string;
    connected: boolean;
    label: string;
    popularityRank?: number;
  },
>(
  connectors: readonly T[],
  categoryMetadata: PublicConnectorCatalogCategoryMetadata | undefined,
  otherCategoryLabel = "Other",
): ConnectorCategoryGroup<T>[] {
  const grouped = new Map<string, T[]>();

  for (const connector of connectors) {
    const items = grouped.get(connector.category);
    if (items) {
      items.push(connector);
    } else {
      grouped.set(connector.category, [connector]);
    }
  }

  const groupedCategoryIds = new Set<string>();
  const categorySections: ConnectorCategorySection<T>[] =
    categoryMetadata?.categories.flatMap((category) => {
      if (groupedCategoryIds.has(category.id)) {
        return [];
      }
      const items = grouped.get(category.id);
      if (!items || items.length === 0) {
        return [];
      }
      groupedCategoryIds.add(category.id);
      return [
        {
          category: category.id,
          label: category.label,
          menuLabel: category.menuLabel,
          groupId: category.groupId,
          connectors: sortedCategoryConnectors(items),
        },
      ];
    }) ?? [];

  for (const [category, items] of grouped) {
    if (groupedCategoryIds.has(category)) {
      continue;
    }
    const label = fallbackCategoryLabel(category) || otherCategoryLabel;
    categorySections.push({
      category,
      label,
      menuLabel: label,
      groupId: null,
      connectors: sortedCategoryConnectors(items),
    });
  }

  const groups: ConnectorCategoryGroup<T>[] = [];
  const groupMetadata = new Map(
    categoryMetadata?.groups.map((group) => {
      return [group.id, group];
    }) ?? [],
  );
  const categorySectionIds = new Set(
    categorySections.map((section) => {
      return section.category;
    }),
  );

  for (const section of categorySections) {
    if (!section.groupId || categorySectionIds.has(section.groupId)) {
      groups.push({
        id: section.category,
        kind: "category",
        label: section.label,
        menuLabel: section.menuLabel,
        sections: [section],
      });
      continue;
    }

    const existingGroup = groups.find((group) => {
      return group.kind === "group" && group.id === section.groupId;
    });
    if (existingGroup) {
      existingGroup.sections.push(section);
      continue;
    }

    const metadata = groupMetadata.get(section.groupId);
    const fallbackGroupLabel =
      fallbackCategoryLabel(section.groupId) || otherCategoryLabel;
    const label = metadata?.label ?? fallbackGroupLabel;
    const menuLabel = metadata?.menuLabel ?? fallbackGroupLabel;
    groups.push({
      id: section.groupId,
      kind: "group",
      label,
      menuLabel,
      sections: [section],
    });
  }

  return groups;
}
