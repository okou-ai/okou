import { Toolbar } from "@base-ui/react/toolbar";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { cn } from "@okouai/ui";
import type { PlatformConnectorCatalogStatusItem } from "../../../../signals/connector-domain.ts";
import type {
  ConnectorShelf,
  ConnectorShelfChip,
} from "../../../../signals/okou-page/settings/connector-shelves.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { DIRECTORY_HAIRLINE } from "./connector-card.tsx";

/**
 * The closing cell. "See all 327" names nothing a reader can act on, so this
 * shows three marks and the products behind them instead of the count alone.
 */
function ConnectorShelfTail({
  shelf,
  onOpen,
}: {
  readonly shelf: ConnectorShelf<PlatformConnectorCatalogStatusItem>;
  readonly onOpen: () => void;
}) {
  const { t } = useTranslation();
  const names = shelf.tail
    .slice(0, 2)
    .map((connector) => {
      return connector.label;
    })
    .join(", ");
  return (
    <button
      type="button"
      className="mt-2 flex w-full cursor-pointer items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition-colors hover:bg-state-hover"
      onClick={onOpen}
    >
      <span className="flex shrink-0 items-center" aria-hidden="true">
        {shelf.tail.map((connector) => {
          return (
            <span
              key={connector.slug}
              className={cn(
                "-ml-1.5 flex h-5 w-5 items-center justify-center overflow-hidden rounded-md bg-gray-50 first:ml-0",
                DIRECTORY_HAIRLINE,
              )}
            >
              <ConnectorIcon icon={connector.icon} size={12} />
            </span>
          );
        })}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {t(
          ($) => {
            return $.connectors.catalog.shelf.seeMore;
          },
          { names, count: shelf.remaining },
        )}
      </span>
      <ChevronRight
        size={14}
        className="shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </button>
  );
}

/** One shelf: its title, its cells, and the cell that closes it. */
export function ConnectorShelfSection({
  shelf,
  columns,
  onOpenCategory,
  children,
  keyboardNavigation = false,
}: {
  readonly shelf: ConnectorShelf<PlatformConnectorCatalogStatusItem>;
  readonly columns: 2 | 3;
  readonly onOpenCategory: (category: string) => void;
  readonly children: React.ReactNode;
  readonly keyboardNavigation?: boolean;
}) {
  const gridClassName = cn(
    "grid gap-3",
    columns === 3
      ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
      : "grid-cols-1 sm:grid-cols-2",
  );
  return (
    <div
      className="mb-4 last:mb-0"
      data-testid={`connector-shelf-${shelf.category ?? "head"}`}
    >
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        {shelf.label}
      </h3>
      {keyboardNavigation ? (
        <Toolbar.Root
          key={shelf.connectors
            .map((connector) => {
              return connector.slug;
            })
            .join(",")}
          aria-label={shelf.label}
          orientation="vertical"
          className={gridClassName}
        >
          {children}
        </Toolbar.Root>
      ) : (
        <div className={gridClassName}>{children}</div>
      )}
      {shelf.tail.length > 0 &&
        shelf.remaining > 0 &&
        shelf.category !== null && (
          <ConnectorShelfTail
            shelf={shelf}
            onOpen={() => {
              onOpenCategory(shelf.category ?? "");
            }}
          />
        )}
    </div>
  );
}

/** Categories that cannot fill a shelf yet, offered as counted chips. */
export function ConnectorShelfChips({
  chips,
  onSelect,
}: {
  readonly chips: readonly ConnectorShelfChip[];
  readonly onSelect: (category: string) => void;
}) {
  const { t } = useTranslation();
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className="mb-1">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.connectors.catalog.shelf.moreCategories;
        })}
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => {
          return (
            <button
              key={chip.category}
              type="button"
              className={cn(
                "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg bg-gray-50 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
                DIRECTORY_HAIRLINE,
              )}
              onClick={() => {
                onSelect(chip.category);
              }}
            >
              {chip.label}
              {chip.total !== undefined && (
                <span className="text-[11px] tabular-nums text-muted-foreground/70">
                  {chip.total}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
