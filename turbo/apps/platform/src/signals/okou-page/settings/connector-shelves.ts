import type { ConnectorCategorySection } from "./connector-categories.ts";

/**
 * A shelf is one category shown a few cards deep, closed by a cell that names
 * what is behind it. It exists because a catalog of four thousand connectors
 * cannot be browsed by a filter: the person opening it does not know the
 * product's name, so the surface has to say "Lark, Zendesk and 321 more"
 * rather than "327".
 */
export interface ConnectorShelf<T> {
  /** The category this shelf opens, or null for the cross-category head. */
  readonly category: string | null;
  readonly label: string;
  /** What the shelf shows. */
  readonly connectors: readonly T[];
  /** Up to three marks named in the closing cell. */
  readonly tail: readonly T[];
  /** How many the closing cell stands for. */
  readonly remaining: number;
}

/** A category too thinly ranked to fill a shelf; offered as a chip instead. */
export interface ConnectorShelfChip {
  readonly category: string;
  readonly label: string;
  /** Absent when discovery did not report a total for this category. */
  readonly total: number | undefined;
}

export interface ConnectorShelfLayout<T> {
  readonly shelves: readonly ConnectorShelf<T>[];
  readonly chips: readonly ConnectorShelfChip[];
  /** Every connector the layout renders, in reading order. */
  readonly connectors: readonly T[];
}

/** The layout of a view that shelves nothing, such as a filtered one. */
export function emptyConnectorShelfLayout<T>(): ConnectorShelfLayout<T> {
  return { shelves: [], chips: [], connectors: [] };
}

interface ShelfConnector {
  readonly slug: string;
  readonly label: string;
  readonly popularityRank?: number;
}

/**
 * How many a shelf shows before it closes, when the caller does not say. Each
 * surface passes the number that fills whole rows of its own card grid, so a
 * shelf never ends on a ragged row.
 */
const CONNECTOR_SHELF_PREVIEW = 6;

/**
 * A category needs this many ranked connectors to earn a shelf. Below it the
 * shelf would fill with the alphabet — Voice and audio would open on "3Scribe,
 * AiVOOV, Amara" — which reads as a broken catalog rather than a short one.
 */
const CONNECTOR_SHELF_MIN_RANKED = 4;

const UNRANKED = Number.MAX_SAFE_INTEGER;

function rankOf(connector: ShelfConnector): number {
  return connector.popularityRank ?? UNRANKED;
}

function byRank<T extends ShelfConnector>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const delta = rankOf(left) - rankOf(right);
    return delta === 0 ? left.label.localeCompare(right.label) : delta;
  });
}

function rankedCount(items: readonly ShelfConnector[]): number {
  return items.filter((item) => {
    return rankOf(item) !== UNRANKED;
  }).length;
}

/**
 * What a shelf closes on. Discovery returns a slice per category, so only the
 * server can say how many the rest stands for; when it does not, the shelf
 * closes on nothing rather than on a number invented from the slice.
 */
function remainingOf(
  section: ConnectorCategorySection<unknown>,
  counts: Readonly<Record<string, number>> | undefined,
  shown: number,
): number {
  const total = counts?.[section.category];
  return total === undefined ? 0 : Math.max(total - shown, 0);
}

/**
 * The head shelf takes the best-ranked connector from each shelf-worthy
 * category rather than the globally top-ranked six, which would be six Google
 * products in a row and would tell a first-time visitor nothing about breadth.
 */
function headConnectors<T extends ShelfConnector>(
  sections: readonly { readonly connectors: readonly T[] }[],
  previewSize: number,
): T[] {
  return byRank(
    sections.flatMap((section) => {
      const best = section.connectors[0];
      return best !== undefined && rankOf(best) !== UNRANKED ? [best] : [];
    }),
  ).slice(0, previewSize);
}

/**
 * Splits the catalog into shelves. A connector appears on exactly one shelf:
 * whatever the head shelf shows does not come back under its own category,
 * which is what keeps Gmail and Slack from opening two sections in a row.
 */
export function buildConnectorShelves<T extends ShelfConnector>({
  sections,
  categoryCounts,
  headLabel,
  previewSize = CONNECTOR_SHELF_PREVIEW,
  minRanked = CONNECTOR_SHELF_MIN_RANKED,
}: {
  readonly sections: readonly ConnectorCategorySection<T>[];
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly headLabel: string;
  readonly previewSize?: number;
  readonly minRanked?: number;
}): ConnectorShelfLayout<T> {
  const ordered = sections.map((section) => {
    return { section, connectors: byRank(section.connectors) };
  });
  const eligible = ordered.filter((entry) => {
    return rankedCount(entry.connectors) >= minRanked;
  });
  const chips = ordered
    .filter((entry) => {
      return rankedCount(entry.connectors) < minRanked;
    })
    .map((entry) => {
      return {
        category: entry.section.category,
        label: entry.section.menuLabel,
        total: categoryCounts?.[entry.section.category],
      };
    });

  const shelves: ConnectorShelf<T>[] = [];
  const used = new Set<string>();
  const head = headConnectors(eligible, previewSize);
  if (head.length > 0) {
    for (const connector of head) {
      used.add(connector.slug);
    }
    // The head shelf spans every category, so it has no category to open and
    // closes on nothing; the shelves under it are the way through.
    shelves.push({
      category: null,
      label: headLabel,
      connectors: head,
      tail: [],
      remaining: 0,
    });
  }

  for (const entry of eligible) {
    const available = entry.connectors.filter((connector) => {
      return !used.has(connector.slug);
    });
    // Only ranked connectors reach a shelf; the alphabet stays in the tail.
    const preview = available
      .filter((connector) => {
        return rankOf(connector) !== UNRANKED;
      })
      .slice(0, previewSize);
    if (preview.length === 0) {
      continue;
    }
    for (const connector of preview) {
      used.add(connector.slug);
    }
    const remainder = available.filter((connector) => {
      return !used.has(connector.slug);
    });
    shelves.push({
      category: entry.section.category,
      label: entry.section.label,
      connectors: preview,
      tail: remainder.slice(0, 3),
      remaining: remainingOf(entry.section, categoryCounts, preview.length),
    });
  }

  return {
    shelves,
    chips,
    connectors: shelves.flatMap((shelf) => {
      return shelf.connectors;
    }),
  };
}
