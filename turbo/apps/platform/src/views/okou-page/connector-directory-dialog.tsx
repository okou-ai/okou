import { useLastLoadable, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { BuiltinConnectorProtocolTabs } from "./components/settings/builtin-connector-protocol-tabs.tsx";
import { ArrowRight, Plus, Search, TriangleAlert } from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { Input } from "@okouai/ui/components/ui/input";
import {
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui/components/ui/segment-control";
import { Button, cn } from "@okouai/ui";
import type { PublicConnectorCatalogCategoryMetadata } from "@okouai/api-contracts/contracts/connector-catalog";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import { connectorAccountSummaryByTarget$ } from "../../signals/okou-page/connector-accounts.ts";
import { sshSummary$ } from "../../signals/ssh.ts";
import { REMOTE_ACCESS_CATEGORY } from "../../signals/okou-page/settings/ssh-connector.ts";
import type {
  ComposerConnectorUiState,
  ConnectorDirectoryTab,
} from "../../signals/okou-page/connectors.ts";
import type { ConnectorCategorySection } from "../../signals/okou-page/settings/connector-categories.ts";
import {
  ConnectorCard,
  DIRECTORY_HAIRLINE,
  DIRECTORY_SURFACE,
} from "./components/settings/connector-card.tsx";
import {
  ConnectorShelfChips,
  ConnectorShelfSection,
} from "./components/settings/connector-shelf.tsx";
import { CustomConnectorIcon } from "./components/settings/custom-connector-icon.tsx";
import { customConnectorTarget } from "./components/settings/custom-connector-display.ts";
import {
  launchConnectorConnect,
  type ConnectorConnectHandlers,
} from "./components/settings/launch-connector-connect.ts";
import { useConnectorAccountLabel } from "./components/settings/use-connector-account-label.ts";
import { ConnectorDetailPanel } from "./connector-directory-detail.tsx";
import { SshConnectorCard } from "./components/settings/ssh-connector-card.tsx";
import {
  buildConnectorDirectoryModel,
  type ConnectorDirectoryModel,
} from "./connector-directory-model.ts";

/**
 * The scroll region runs to the sheet edge and fades into it at both ends.
 * Ending it on a hard line slices whichever card sits on the boundary, which
 * reads as a rendering fault rather than as "the list continues".
 */
const SCROLL_EDGE_FADE =
  "[mask-image:linear-gradient(to_bottom,transparent_0,#000_18px,#000_calc(100%-44px),transparent_100%)]";

type UpdateDirectoryState = (patch: Partial<ComposerConnectorUiState>) => void;

type RenderConnectorCard = (
  connector: PlatformConnectorCatalogStatusItem,
  connected: boolean,
) => React.ReactNode;

function DirectorySection({
  title,
  showAllCount,
  tone = "default",
  onShowAll,
  children,
}: {
  readonly title: string;
  readonly showAllCount?: number;
  readonly tone?: "default" | "warning";
  readonly onShowAll?: () => void;
  readonly children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-5 last:mb-0">
      <div className="mb-2 flex items-center gap-2">
        <h3
          className={cn(
            "flex items-center gap-1.5 text-xs font-medium",
            tone === "warning"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground",
          )}
        >
          {tone === "warning" && <TriangleAlert size={14} aria-hidden="true" />}
          {title}
        </h3>
        {onShowAll && showAllCount !== undefined && (
          <Button
            type="button"
            variant="quiet"
            size="xs"
            className="ml-auto gap-1.5"
            onClick={onShowAll}
          >
            {t(
              ($) => {
                return $.chat.connectors.directory.showAll;
              },
              { count: showAllCount },
            )}
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function DirectoryEmptyState({
  icon,
  title,
  body,
  action,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly body: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span
        className={cn(
          "flex h-13 w-13 items-center justify-center rounded-[14px] bg-gray-50 text-muted-foreground",
          DIRECTORY_HAIRLINE,
        )}
      >
        {icon}
      </span>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 max-w-[38ch] text-xs text-muted-foreground">
          {body}
        </p>
      </div>
      {action}
    </div>
  );
}

function DirectorySkeleton() {
  return (
    <div className="grid animate-pulse grid-cols-1 gap-3 sm:grid-cols-2">
      {Array.from({ length: 6 }, (_, index) => {
        return (
          <div key={index} className={cn(DIRECTORY_SURFACE, "flex flex-col")}>
            <div className="flex items-center gap-3 px-4 pb-2 pt-3.5">
              <span className="h-9 w-9 shrink-0 rounded-[10px] bg-muted/50" />
              <span className="h-3.5 flex-1 rounded bg-muted/50" />
              <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50" />
            </div>
            <div className="flex flex-col gap-2 px-4 pb-4">
              <span className="h-2.5 w-11/12 rounded bg-muted/30" />
              <span className="h-2.5 w-7/12 rounded bg-muted/30" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DirectoryNoResults({
  query,
  action,
}: {
  readonly query: string;
  readonly action?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DirectoryEmptyState
      icon={<Search size={24} aria-hidden="true" />}
      title={t(
        ($) => {
          return $.chat.connectors.directory.noResultsTitle;
        },
        { query },
      )}
      body={t(($) => {
        return $.chat.connectors.directory.noResultsBody;
      })}
      action={action}
    />
  );
}

function CustomConnectorDirectoryCard({
  connector,
  onConnect,
}: {
  readonly connector: CustomConnectorResponse;
  readonly onConnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t(
        ($) => {
          return $.connectors.card.connectAria;
        },
        { connector: connector.displayName },
      )}
      className={cn(
        DIRECTORY_SURFACE,
        "cursor-pointer overflow-hidden text-left hover:bg-card-hover",
      )}
      onClick={onConnect}
    >
      <span className="flex items-center gap-3 px-4 pb-2 pt-3.5">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-gray-50",
            DIRECTORY_HAIRLINE,
          )}
        >
          <CustomConnectorIcon
            id={connector.id}
            displayName={connector.displayName}
            size={22}
          />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            data-testid="connector-card-label"
            className="min-w-0 truncate text-sm font-medium text-foreground"
          >
            {connector.displayName}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-md bg-gray-0 px-1.5 py-px text-[10px] text-muted-foreground",
              DIRECTORY_HAIRLINE,
            )}
          >
            {t(($) => {
              return $.chat.connectors.directory.customBadge;
            })}
          </span>
        </span>
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/60 text-muted-foreground"
          aria-hidden="true"
        >
          <Plus size={14} />
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1 px-4 pb-3.5 text-xs text-muted-foreground">
        <span className="shrink-0">
          {connector.kind === "mcp"
            ? t(($) => {
                return $.connectors.custom.mcpType;
              })
            : t(($) => {
                return $.connectors.custom.create.httpType;
              })}
        </span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground/60">
          {customConnectorTarget(connector)}
        </span>
      </span>
    </button>
  );
}

function DirectoryCategoryChips({
  sections,
  categoryCounts,
  selected,
  onSelect,
}: {
  readonly sections: readonly ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[];
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly selected: string | null;
  readonly onSelect: (category: string | null) => void;
}) {
  const { t } = useTranslation();
  // The row is horizontal and every chip is auto-width, so selection may not
  // change a chip's metrics: a heavier selected label widens that chip and
  // shifts every chip after it, one frame after the click. Weight stays
  // constant and selection is carried by the fill and the ink, which is how
  // SegmentControl already does it.
  const chipClass = (active: boolean) => {
    return cn(
      "flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-gray-50 px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
      DIRECTORY_HAIRLINE,
      active ? "bg-state-selected text-foreground" : "text-muted-foreground",
    );
  };
  return (
    <div className="shrink-0 overflow-x-auto px-6 pt-3 [scrollbar-width:none]">
      <div className="flex w-max gap-1.5 pb-1">
        <button
          type="button"
          data-connector-category-chip=""
          className={chipClass(selected === null)}
          onClick={() => {
            onSelect(null);
          }}
        >
          {t(($) => {
            return $.chat.connectors.directory.allCategories;
          })}
        </button>
        {sections.map((section) => {
          return (
            <button
              key={section.category}
              type="button"
              data-connector-category-chip=""
              className={chipClass(selected === section.category)}
              onClick={() => {
                onSelect(section.category);
              }}
            >
              {section.menuLabel}
              {/* The chip stands for the whole category, not the slice
                  discovery returned, so it counts only what the server
                  reported and shows nothing when it reported nothing. */}
              {categoryCounts?.[section.category] !== undefined && (
                <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                  {categoryCounts[section.category]}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DirectoryDiscoverPanel({
  model,
  showSsh,
  renderCard,
  search,
  category,
  onSelectCategory,
  onCreateCustom,
}: {
  readonly model: ConnectorDirectoryModel;
  readonly showSsh: boolean;
  readonly renderCard: RenderConnectorCard;
  readonly search: string;
  readonly category: string | null;
  readonly onSelectCategory: (category: string) => void;
  readonly onCreateCustom: () => void;
}) {
  const { t } = useTranslation();
  // Connection health has no other home in the composer: the connector popover
  // lists what is connected but not whether it still works.
  const attention =
    model.attention.length > 0 ? (
      <DirectorySection
        tone="warning"
        title={t(($) => {
          return $.chat.connectors.directory.needsAttention;
        })}
      >
        {model.attention.map((item) => {
          return renderCard(item, true);
        })}
      </DirectorySection>
    ) : null;
  if (
    model.discover.length === 0 &&
    model.matchedConnected.length === 0 &&
    !showSsh
  ) {
    return (
      <>
        {attention}
        <DirectoryNoResults
          query={search}
          action={
            <Button type="button" variant="outline" onClick={onCreateCustom}>
              {t(($) => {
                return $.chat.connectors.directory.createCustom;
              })}
            </Button>
          }
        />
      </>
    );
  }
  // A query or a chosen category is already a filter: show what matched as one
  // list instead of scattering the results back across category sections. A
  // catalog too small for any category to fill a shelf takes the same path --
  // shelves need something to shelve.
  if (
    search.trim() ||
    category !== null ||
    model.shelfLayout.shelves.length === 0
  ) {
    return (
      <>
        {attention}
        {model.matchedConnected.length > 0 && (
          <DirectorySection
            title={t(($) => {
              return $.chat.connectors.directory.connected;
            })}
          >
            {model.matchedConnected.map((item) => {
              return renderCard(item, true);
            })}
          </DirectorySection>
        )}
        {(model.discover.length > 0 || showSsh) && (
          <DirectorySection
            title={t(
              ($) => {
                return $.chat.connectors.directory.matchCount;
              },
              { count: model.discover.length + Number(showSsh) },
            )}
          >
            {model.discover.map((item) => {
              return renderCard(item, false);
            })}
            {showSsh && <SshConnectorCard configuredCount={0} />}
          </DirectorySection>
        )}
      </>
    );
  }
  return (
    <>
      {attention}
      {model.shelfLayout.shelves.map((shelf) => {
        return (
          <ConnectorShelfSection
            key={shelf.category ?? "head"}
            shelf={shelf}
            columns={2}
            onOpenCategory={onSelectCategory}
          >
            {shelf.connectors.map((item) => {
              return renderCard(item, false);
            })}
          </ConnectorShelfSection>
        );
      })}
      <ConnectorShelfChips
        chips={model.shelfLayout.chips}
        onSelect={onSelectCategory}
      />
      {showSsh && (
        <DirectorySection
          title={t(($) => {
            return $.connectors.catalog.remoteAccess;
          })}
        >
          <SshConnectorCard configuredCount={0} />
        </DirectorySection>
      )}
    </>
  );
}

function DirectoryCustomPanel({
  connectors,
  onConnectCustom,
}: {
  readonly connectors: readonly CustomConnectorResponse[];
  readonly onConnectCustom: (connector: CustomConnectorResponse) => void;
}) {
  const { t } = useTranslation();
  if (connectors.length === 0) {
    return (
      <DirectoryEmptyState
        icon={<Plus size={24} aria-hidden="true" />}
        title={t(($) => {
          return $.chat.connectors.directory.emptyCustomTitle;
        })}
        body={t(($) => {
          return $.chat.connectors.directory.emptyCustomBody;
        })}
      />
    );
  }
  return (
    <DirectorySection
      title={t(($) => {
        return $.chat.connectors.directory.tabCustom;
      })}
    >
      {connectors.map((connector) => {
        return (
          <CustomConnectorDirectoryCard
            key={connector.id}
            connector={connector}
            onConnect={() => {
              onConnectCustom(connector);
            }}
          />
        );
      })}
    </DirectorySection>
  );
}

function DirectoryToolbar({
  tab,
  search,
  onTabChange,
  onSearchChange,
}: {
  readonly tab: ConnectorDirectoryTab;
  readonly search: string;
  readonly onTabChange: (tab: ConnectorDirectoryTab) => void;
  readonly onSearchChange: (search: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DialogHeader className="shrink-0 space-y-0 px-6 pt-6">
        <DialogTitle className="text-lg">
          {t(($) => {
            return $.chat.connectors.title;
          })}
        </DialogTitle>
      </DialogHeader>
      <div className="shrink-0 px-6 pt-4">
        <SegmentControl
          value={tab}
          onValueChange={(value: string) => {
            onTabChange(value as ConnectorDirectoryTab);
          }}
          aria-label={t(($) => {
            return $.chat.connectors.title;
          })}
        >
          <SegmentControlItem value="discover">
            {t(($) => {
              return $.chat.connectors.directory.tabDiscover;
            })}
          </SegmentControlItem>
          <SegmentControlItem value="custom">
            {t(($) => {
              return $.chat.connectors.directory.tabCustom;
            })}
          </SegmentControlItem>
        </SegmentControl>
      </div>
      <div className="relative shrink-0 px-6 pt-3">
        <Search
          size={15}
          className="pointer-events-none absolute left-9 top-1/2 mt-1.5 -translate-y-1/2 text-muted-foreground/60"
          aria-hidden="true"
        />
        <Input
          type="text"
          className="pl-9"
          placeholder={t(($) => {
            return $.chat.connectors.find;
          })}
          value={search}
          onChange={(event) => {
            onSearchChange(event.target.value);
          }}
          autoFocus
        />
      </div>
    </>
  );
}

function DirectoryBody({
  tab,
  showSsh,
  loading,
  model,
  renderCard,
  search,
  category,
  onUpdateState,
  onConnectCustom,
}: {
  readonly tab: ConnectorDirectoryTab;
  readonly showSsh: boolean;
  readonly loading: boolean;
  readonly model: ConnectorDirectoryModel;
  readonly renderCard: RenderConnectorCard;
  readonly search: string;
  readonly category: string | null;
  readonly onUpdateState: UpdateDirectoryState;
  readonly onConnectCustom: (connector: CustomConnectorResponse) => void;
}) {
  if (loading) {
    return <DirectorySkeleton />;
  }
  if (tab === "discover") {
    return (
      <DirectoryDiscoverPanel
        model={model}
        showSsh={showSsh}
        renderCard={renderCard}
        search={search}
        category={category}
        onSelectCategory={(next) => {
          onUpdateState({ directoryCategory: next, directoryActiveIndex: 0 });
        }}
        onCreateCustom={() => {
          onUpdateState({ directoryTab: "custom", directoryActiveIndex: 0 });
        }}
      />
    );
  }
  return (
    <DirectoryCustomPanel
      connectors={model.custom}
      onConnectCustom={onConnectCustom}
    />
  );
}

function DirectoryBrowseView({
  tab,
  protocol,
  search,
  category,
  categoryCounts,
  loading,
  model,
  renderCard,
  onUpdateState,
  onConnectCustom,
}: {
  readonly tab: ConnectorDirectoryTab;
  readonly protocol: "http" | "mcp";
  readonly search: string;
  readonly category: string | null;
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly loading: boolean;
  readonly model: ConnectorDirectoryModel;
  readonly renderCard: RenderConnectorCard;
  readonly onUpdateState: UpdateDirectoryState;
  readonly onConnectCustom: (connector: CustomConnectorResponse) => void;
}) {
  const { t } = useTranslation();
  const summary = useLoadable(sshSummary$);
  const sshAvailable =
    summary.state === "hasData" && summary.data?.configuredCount === 0;
  const showSsh =
    sshAvailable &&
    (category === null || category === REMOTE_ACCESS_CATEGORY) &&
    "ssh".includes(search.trim().toLowerCase());
  const remoteAccessLabel = t(($) => {
    return $.connectors.catalog.remoteAccess;
  });
  // The chip row comes from the browse response, not from what is currently
  // shown: a chip row that empties itself when you pick a chip cannot be used
  // to pick another one.
  const sections = sshAvailable
    ? [
        ...model.chipSections,
        {
          category: REMOTE_ACCESS_CATEGORY,
          label: remoteAccessLabel,
          menuLabel: remoteAccessLabel,
          groupId: null,
          connectors: [],
        },
      ]
    : model.chipSections;
  return (
    <>
      <DirectoryToolbar
        tab={tab}
        search={search}
        onTabChange={(next) => {
          onUpdateState({ directoryTab: next, directoryActiveIndex: 0 });
        }}
        onSearchChange={(next) => {
          onUpdateState({
            addDialogSearch: next,
            directoryActiveIndex: 0,
          });
        }}
      />
      {tab === "discover" && (
        <div className="px-6 pb-3">
          <BuiltinConnectorProtocolTabs
            value={protocol}
            onChange={(next) => {
              onUpdateState({
                directoryProtocol: next,
                directoryCategory: null,
                addDialogSearch: "",
                directoryActiveIndex: 0,
                directoryDetailSlug: null,
              });
            }}
          />
        </div>
      )}
      {tab === "discover" && (
        <DirectoryCategoryChips
          sections={sections}
          categoryCounts={
            sshAvailable
              ? { ...categoryCounts, [REMOTE_ACCESS_CATEGORY]: 1 }
              : categoryCounts
          }
          selected={category}
          onSelect={(next) => {
            onUpdateState({
              directoryCategory: next,
              directoryActiveIndex: 0,
            });
          }}
        />
      )}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4",
          SCROLL_EDGE_FADE,
        )}
      >
        <DirectoryBody
          tab={tab}
          showSsh={showSsh}
          loading={loading}
          model={model}
          renderCard={renderCard}
          search={search}
          category={category}
          onUpdateState={onUpdateState}
          onConnectCustom={onConnectCustom}
        />
      </div>
    </>
  );
}

function DirectoryConnectorCardSlot({
  connector,
  connected,
  busy,
  active,
  summary,
  accountLabelOf,
  connect,
  onOpenDetail,
}: {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly active: boolean;
  readonly summary: ConnectorAccountSummary | undefined;
  readonly accountLabelOf: (
    account: NonNullable<ConnectorAccountSummary["defaultConnection"]>,
  ) => string;
  readonly connect: ConnectorConnectHandlers;
  readonly onOpenDetail: () => void;
}) {
  return (
    <ConnectorCard
      variant="directory"
      connector={connector}
      busy={busy}
      connected={connected}
      accountCount={summary?.accountCount ?? (connected ? 1 : 0)}
      accountLabel={
        summary?.defaultConnection
          ? accountLabelOf(summary.defaultConnection)
          : (connector.connection?.externalUsername ?? undefined)
      }
      active={active}
      connect={connect}
      onOpenDetail={onOpenDetail}
    />
  );
}

/** The connectors the arrow keys walk through on the visible tab. */
function navigableDirectorySlugs(
  tab: ConnectorDirectoryTab,
  model: ConnectorDirectoryModel,
): readonly ConnectorSlug[] {
  return tab === "discover" ? model.discoverSlugs : [];
}

function createDirectoryKeyDownHandler({
  activeIndex,
  navigableSlugs,
  activeSlug,
  model,
  inDetail,
  connecting,
  connectHandlers,
  onUpdateState,
}: {
  readonly activeIndex: number;
  readonly navigableSlugs: readonly ConnectorSlug[];
  readonly activeSlug: ConnectorSlug | undefined;
  readonly model: ConnectorDirectoryModel;
  readonly inDetail: boolean;
  readonly connecting: boolean;
  readonly connectHandlers: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ConnectorConnectHandlers;
  readonly onUpdateState: UpdateDirectoryState;
}) {
  return (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      inDetail ||
      (event.target instanceof HTMLElement && event.target.closest("a, button"))
    ) {
      return;
    }
    const next = nextDirectoryIndex(
      event.key,
      activeIndex,
      navigableSlugs.length,
    );
    if (next !== null) {
      event.preventDefault();
      onUpdateState({ directoryActiveIndex: next });
      document
        .querySelector(`[data-connector-slug="${navigableSlugs[next]}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    const target =
      event.key === "Enter" && activeSlug
        ? model.bySlug.get(activeSlug)
        : undefined;
    if (!target) {
      return;
    }
    event.preventDefault();
    if (target.connected) {
      onUpdateState({ directoryDetailSlug: target.slug });
    } else if (!connecting) {
      launchConnectorConnect({ connector: target, ...connectHandlers(target) });
    }
  };
}

function DirectoryDetailSlot({
  connector,
  accountSummary,
  model,
  connecting,
  connectHandlers,
  onConfigurePermissions,
  onUpdateState,
}: {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly accountSummary: ConnectorAccountSummary | undefined;
  readonly model: ConnectorDirectoryModel;
  readonly connecting: boolean;
  readonly connectHandlers: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ConnectorConnectHandlers;
  readonly onConfigurePermissions: (connectorSlug: ConnectorSlug) => void;
  readonly onUpdateState: UpdateDirectoryState;
}) {
  return (
    <ConnectorDetailPanel
      connector={connector}
      accountSummary={accountSummary}
      categoryLabel={model.categoryLabelOf(connector.category)}
      busy={connecting}
      connect={connectHandlers(connector)}
      onConfigurePermissions={() => {
        onConfigurePermissions(connector.slug);
      }}
      onBack={() => {
        onUpdateState({ directoryDetailSlug: null });
      }}
    />
  );
}

interface ConnectorDirectoryDialogProps {
  readonly state: ComposerConnectorUiState;
  readonly onUpdateState: UpdateDirectoryState;
  /** Category totals from discovery; a shelf's closing cell stands for these. */
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  /**
   * The catalog's category names, from the same discovery response as the
   * connectors. Reading them from the full-catalog status endpoint instead
   * made every chip wait on a 6.7 MB response and show an id-derived name
   * until it arrived.
   */
  readonly categoryMetadata: PublicConnectorCatalogCategoryMetadata | undefined;
  readonly loading: boolean;
  /** Every connector the browse response carried, for the chip row. */
  readonly chipCatalog: readonly PlatformConnectorCatalogStatusItem[];
  readonly connected: readonly PlatformConnectorCatalogStatusItem[];
  readonly unconnected: readonly PlatformConnectorCatalogStatusItem[];
  readonly connectedCustom: readonly CustomConnectorResponse[];
  readonly unconnectedCustom: readonly CustomConnectorResponse[];
  readonly connecting: boolean;
  readonly connectHandlers: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ConnectorConnectHandlers;
  readonly onConnectCustom: (connector: CustomConnectorResponse) => void;
  readonly onConfigurePermissions: (connectorSlug: ConnectorSlug) => void;
  readonly onClose: () => void;
}

/**
 * Moves the arrow-key selection and reports the slug that lands under it, so
 * the dialog only has to decide what happens when the selection is activated.
 */
function nextDirectoryIndex(
  key: string,
  current: number,
  length: number,
): number | null {
  if (length === 0) {
    return null;
  }
  if (key === "ArrowDown") {
    return (current + 1) % length;
  }
  if (key === "ArrowUp") {
    return (current - 1 + length) % length;
  }
  return null;
}

export function ConnectorDirectoryDialog({
  state,
  onUpdateState,
  categoryCounts,
  categoryMetadata,
  loading,
  chipCatalog,
  connected,
  unconnected,
  connectedCustom,
  unconnectedCustom,
  connecting,
  connectHandlers,
  onConnectCustom,
  onConfigurePermissions,
  onClose,
}: ConnectorDirectoryDialogProps) {
  const { t } = useTranslation();
  const accountLabelOf = useConnectorAccountLabel();
  const accountsLoadable = useLastLoadable(connectorAccountSummaryByTarget$);
  const accountSummaries: ReadonlyMap<string, ConnectorAccountSummary> =
    accountsLoadable.state === "hasData"
      ? accountsLoadable.data
      : new Map<string, ConnectorAccountSummary>();

  const search = state.addDialogSearch;
  const tab = state.directoryTab;
  const category = state.directoryCategory;
  const matchesProtocol = (connector: PlatformConnectorCatalogStatusItem) => {
    return (connector.protocol ?? "http") === state.directoryProtocol;
  };
  const model = buildConnectorDirectoryModel({
    connected: connected.filter(matchesProtocol),
    unconnected: unconnected.filter(matchesProtocol),
    chipCatalog: chipCatalog.filter(matchesProtocol),
    connectedCustom,
    unconnectedCustom,
    search,
    category,
    categoryMetadata,
    otherCategoryLabel: t(($) => {
      return $.chat.connectors.directory.otherCategory;
    }),
    categoryCounts,
    headShelfLabel: t(($) => {
      return $.connectors.catalog.shelf.popular;
    }),
  });
  const navigableSlugs = navigableDirectorySlugs(tab, model);
  const activeSlug = navigableSlugs[state.directoryActiveIndex];
  const detailConnector = state.directoryDetailSlug
    ? model.bySlug.get(state.directoryDetailSlug)
    : undefined;

  const renderCard: RenderConnectorCard = (connector, isConnected) => {
    return (
      <DirectoryConnectorCardSlot
        key={connector.slug}
        connector={connector}
        connected={isConnected}
        busy={connecting}
        active={activeSlug === connector.slug}
        summary={accountSummaries.get(`builtin:${connector.slug}`)}
        accountLabelOf={accountLabelOf}
        connect={connectHandlers(connector)}
        onOpenDetail={() => {
          onUpdateState({ directoryDetailSlug: connector.slug });
        }}
      />
    );
  };

  const handleKeyDown = createDirectoryKeyDownHandler({
    activeIndex: state.directoryActiveIndex,
    navigableSlugs,
    activeSlug,
    model,
    inDetail: detailConnector !== undefined,
    connecting,
    connectHandlers,
    onUpdateState,
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && onClose();
      }}
    >
      <DialogContent
        maxWidth="2xl"
        height={600}
        contentClassName="flex flex-col gap-0 p-0"
        aria-describedby={undefined}
        onKeyDown={handleKeyDown}
      >
        {detailConnector ? (
          <DirectoryDetailSlot
            connector={detailConnector}
            accountSummary={accountSummaries.get(
              `builtin:${detailConnector.slug}`,
            )}
            model={model}
            connecting={connecting}
            connectHandlers={connectHandlers}
            onConfigurePermissions={onConfigurePermissions}
            onUpdateState={onUpdateState}
          />
        ) : (
          <DirectoryBrowseView
            tab={tab}
            protocol={state.directoryProtocol}
            search={search}
            category={category}
            categoryCounts={categoryCounts}
            loading={loading}
            model={model}
            renderCard={renderCard}
            onUpdateState={onUpdateState}
            onConnectCustom={onConnectCustom}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
