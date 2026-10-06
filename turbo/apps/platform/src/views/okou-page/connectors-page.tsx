// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  type Loadable,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Search, Filter, ChevronDown, Check } from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  PublicConnectorCatalogCategoryMetadata,
  PublicConnectorCatalogDiscoveryResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { agents$ } from "../../signals/agent.ts";
import { CustomConnectorGrid } from "./components/settings/custom-connectors-panel.tsx";
import { filteredDirectoryCustomConnectors$ } from "../../signals/okou-page/settings/connector-directory-custom.ts";
import {
  ConnectorsDirectoryContent,
  NewCustomConnectorButton,
} from "./connectors-directory-content.tsx";
import {
  connectorDirectoryCustomScope$,
  connectorsScope$,
  setConnectorsScope$,
  type ConnectorsScope,
} from "../../signals/okou-page/settings/connector-directory-route.ts";
import {
  connectorCatalogDiscovery$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  connectBuiltinConnectorNoAuth$,
  builtinConnectFlowSlug$,
  runBuiltinConnectorConnectSuccess$,
  connectorsSearch$,
  connectorsCategoryFilter$,
  connectorsConnectionFilter$,
  filteredConnectorCatalogItems$,
  setConnectorsCategoryFilter$,
  setConnectorsConnectionFilter$,
  setConnectorsSearch$,
  builtinPollingOAuthAuthCodeSlug$,
  builtinPollingOAuthDeviceAuthSlug$,
  relatedCatalogItems$,
  builtinConnectorScopeReviewSelection$,
  setBuiltinConnectorScopeReviewSelection$,
  type ConnectorsConnectionFilter,
} from "../../signals/okou-page/settings/connectors.ts";
import {
  buildConnectorShelves,
  emptyConnectorShelfLayout,
  type ConnectorShelfLayout,
} from "../../signals/okou-page/settings/connector-shelves.ts";
import {
  groupConnectorsByCategory,
  type ConnectorCategoryGroup,
  type ConnectorCategorySection,
} from "../../signals/okou-page/settings/connector-categories.ts";
import {
  bindConnectorCategoryGrid$,
  connectorCategoryGridMetrics$,
  connectorCategoryGridWindow,
  CONNECTOR_CATEGORY_GRID_ROW_HEIGHT,
} from "../../signals/okou-page/settings/connector-category-grid.ts";
import { localizeConnectorCategoryMetadata } from "./components/settings/connector-category-labels.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import {
  ConnectorCard,
  connectorAccountSummaryStatus,
  type ConnectorAccountDisplaySummary,
  type ConnectorAccountSummaryStatus,
} from "./components/settings/connector-card.tsx";
import {
  ConnectorShelfChips,
  ConnectorShelfSection,
} from "./components/settings/connector-shelf.tsx";
import {
  launchConnectorConnect,
  type ConnectorConnectHandlers,
} from "./components/settings/launch-connector-connect.ts";
import { ScopeReviewModal } from "./components/settings/scope-review-modal.tsx";
import { ConnectorAccessManagementDialog } from "./components/settings/connector-access-management-dialog.tsx";
import {
  ConnectorAgentAccessButton,
  connectorAgentAccessStatus,
} from "./components/settings/connector-agent-access-button.tsx";
import {
  closeConnectorAccessManagement$,
  connectorAuthorizedAgentsBySlug$,
  managedConnectorAccessSlug$,
  setManagedConnectorAccessSlug$,
} from "../../signals/okou-page/settings/connector-access-management.ts";
import { noConnectorImg } from "./platform-assets.ts";
import { AvatarFromUrl } from "./sidebar-shared.tsx";
import {
  cn,
  surfaceVariants,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Input,
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui";
import { i18n } from "../../i18n/index.ts";
import {
  connectedConnectorsBadge$,
  connectorOverviewAccountSummaryByTarget$,
} from "../../signals/okou-page/connector-accounts.ts";
import { ConnectorAccountManagerDialog } from "./components/settings/connector-account-manager-dialog.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  builtinAccountConnectDialog$,
  builtinAccountManager$,
  closeBuiltinAccountConnectDialog$,
  closeBuiltinAccountManager$,
  finishConnectorAccountConnection$,
  openBuiltinAccountConnectDialog$,
  openBuiltinAccountManager$,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { ConnectorAccountNameDialog } from "./components/settings/connector-account-name-dialog.tsx";
import { vncSummary$ } from "../../signals/vnc.ts";
import { sshSummary$ } from "../../signals/ssh.ts";
import { cloudflareAccessSummary$ } from "../../signals/cloudflare-access.ts";
import {
  PrivateNetworkPanel,
  RemoteControlPanel,
} from "./connectors-remote-panels.tsx";
import { WorkspaceCanvasBackdrop } from "./workspace-inset.tsx";

function ConnectorFilterSectionLabel({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground/80">
      {children}
    </div>
  );
}

function ConnectorFilterOption({
  active,
  onSelect,
  children,
}: {
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenuItem className="justify-between gap-2" onClick={onSelect}>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
      {active && <Check size={15} className="shrink-0 text-foreground" />}
    </DropdownMenuItem>
  );
}

interface ConnectorsScopeBadge {
  readonly connected: number;
  readonly custom: number;
  readonly remoteControl: number;
  readonly privateNetwork: number;
  readonly needsAttention: boolean;
}

/** Configured resources determine whether a remote-access service is connected. */
function configuredRemoteAccessResources(
  summary: Loadable<{ configuredCount: number } | null>,
): number {
  return summary.state === "hasData" ? (summary.data?.configuredCount ?? 0) : 0;
}

/** The custom connectors the page needs: all of them, and the connected ones. */
function directoryCustomConnectors(
  loadable: Loadable<readonly CustomConnectorResponse[]>,
): {
  readonly all: readonly CustomConnectorResponse[];
  readonly connected: readonly CustomConnectorResponse[];
} {
  const all = loadable.state === "hasData" ? loadable.data : [];
  return {
    all,
    connected: all.filter((connector) => {
      return connector.connected;
    }),
  };
}

/**
 * Before the summaries land the segment says nothing rather than a zero it
 * would have to take back.
 */
function connectorsScopeBadge(
  loadable: Loadable<{
    readonly count: number;
    readonly needsAttention: boolean;
  }>,
  custom: number,
  remoteControl: number,
  privateNetwork: number,
): ConnectorsScopeBadge {
  const connected =
    loadable.state === "hasData"
      ? loadable.data
      : { count: 0, needsAttention: false };
  return {
    connected: connected.count,
    custom,
    remoteControl,
    privateNetwork,
    needsAttention: connected.needsAttention,
  };
}

/**
 * What a segment says about the list behind it. A count that has not arrived
 * shows nothing rather than a zero it would have to take back.
 */
function ConnectorsScopeCount({ value }: { readonly value: number }) {
  if (value <= 0) {
    return null;
  }
  // The count pairs its own line height: an arbitrary font size carries none,
  // and the segment must not take its box from an ancestor.
  return (
    <span className="text-[11px]/4 tabular-nums text-muted-foreground/70">
      {formatLocalizedNumber(value)}
    </span>
  );
}

/**
 * Which list the page is showing. Discovery leads because that is what a visit
 * is usually for; the scope you already own carries its own count, so the page
 * does not have to show that list to say it is there, and a warning dot when
 * one of those connections stopped working -- the one thing a count cannot say.
 */
function ConnectorsScopeSegment({
  scope,
  setScope,
  badge,
}: {
  readonly scope: ConnectorsScope;
  readonly setScope: (value: ConnectorsScope) => void;
  readonly badge: ConnectorsScopeBadge;
}) {
  const { t } = useTranslation();
  return (
    <SegmentControl
      aria-label={t(($) => {
        return $.connectors.catalog.scope.aria;
      })}
      value={scope}
      onValueChange={setScope}
    >
      <SegmentControlItem
        value="discover"
        data-testid="connectors-scope-discover"
      >
        {t(($) => {
          return $.connectors.catalog.scope.discover;
        })}
      </SegmentControlItem>
      <SegmentControlItem
        value="connected"
        data-testid="connectors-scope-connected"
      >
        {badge.needsAttention && (
          <span
            data-testid="connectors-scope-attention"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
            aria-label={t(($) => {
              return $.connectors.catalog.scope.attention;
            })}
          />
        )}
        {t(($) => {
          return $.connectors.catalog.scope.connected;
        })}
        <ConnectorsScopeCount value={badge.connected} />
      </SegmentControlItem>
      <SegmentControlItem
        value="remote-control"
        data-testid="connectors-scope-remote-control"
      >
        {t(($) => {
          return $.connectors.catalog.scope.remoteControl;
        })}
        <ConnectorsScopeCount value={badge.remoteControl} />
      </SegmentControlItem>
      <SegmentControlItem
        value="private-network"
        data-testid="connectors-scope-private-network"
      >
        {t(($) => {
          return $.connectors.catalog.scope.privateNetwork;
        })}
        <ConnectorsScopeCount value={badge.privateNetwork} />
      </SegmentControlItem>
      <SegmentControlItem value="custom" data-testid="connectors-scope-custom">
        {t(($) => {
          return $.connectors.catalog.scope.custom;
        })}
        <ConnectorsScopeCount value={badge.custom} />
      </SegmentControlItem>
    </SegmentControl>
  );
}

/**
 * The toolbar's one filter slot. The trigger reads the same in either scope, so
 * switching scope changes what the menu offers rather than how the toolbar is
 * built.
 */
function ConnectorFilterMenu({
  label,
  width,
  leading,
  children,
}: {
  readonly label: string;
  readonly width: string;
  readonly leading?: ReactNode;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0 self-end gap-1.5"
            aria-label={t(($) => {
              return $.connectors.catalog.filters.aria;
            })}
          />
        }
      >
        <Filter size={14} aria-hidden="true" />
        {leading}
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={cn(
          "max-h-[min(420px,var(--available-height))] overflow-y-auto",
          width,
        )}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The one dimension that organises the connectors you already have: who uses
 * them. Connection status is not offered because this scope is the connected
 * ones -- the question left to ask is which agent can reach them.
 */
function ConnectorAgentFilterMenu({
  agents,
  value,
  onChange,
}: {
  readonly agents: readonly AgentResponse[];
  readonly value: ConnectorsConnectionFilter;
  readonly onChange: (value: ConnectorsConnectionFilter) => void;
}) {
  const { t } = useTranslation();
  const activeAgent =
    value.kind === "agent"
      ? agents.find((agent) => {
          return agent.agentId === value.agentId;
        })
      : undefined;
  const label =
    value.kind === "unshared"
      ? t(($) => {
          return $.connectors.catalog.filters.unshared;
        })
      : activeAgent
        ? connectorAgentName(activeAgent)
        : t(($) => {
            return $.connectors.catalog.filters.allAgents;
          });
  return (
    <ConnectorFilterMenu
      label={t(
        ($) => {
          return $.connectors.catalog.filterWith;
        },
        { category: label },
      )}
      width="w-56"
      leading={
        activeAgent ? (
          <AvatarFromUrl
            avatarUrl={activeAgent.avatarUrl}
            alt={connectorAgentName(activeAgent)}
            size={16}
            className="h-4 w-4 rounded-full object-cover"
          />
        ) : null
      }
    >
      <ConnectorFilterOption
        active={value.kind !== "agent" && value.kind !== "unshared"}
        onSelect={() => {
          onChange({ kind: "all" });
        }}
      >
        {t(($) => {
          return $.connectors.catalog.filters.allAgents;
        })}
      </ConnectorFilterOption>
      {agents.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <ConnectorFilterSectionLabel>
            {t(($) => {
              return $.connectors.catalog.filters.agents;
            })}
          </ConnectorFilterSectionLabel>
          {agents.map((agent) => {
            return (
              <ConnectorFilterOption
                key={agent.agentId}
                active={
                  value.kind === "agent" && value.agentId === agent.agentId
                }
                onSelect={() => {
                  onChange({ kind: "agent", agentId: agent.agentId });
                }}
              >
                <AvatarFromUrl
                  avatarUrl={agent.avatarUrl}
                  alt={connectorAgentName(agent)}
                  size={16}
                  className="h-4 w-4 rounded-full object-cover"
                />
                <span className="truncate">{connectorAgentName(agent)}</span>
              </ConnectorFilterOption>
            );
          })}
          <DropdownMenuSeparator />
          <ConnectorFilterOption
            active={value.kind === "unshared"}
            onSelect={() => {
              onChange({ kind: "unshared" });
            }}
          >
            {t(($) => {
              return $.connectors.catalog.filters.unshared;
            })}
          </ConnectorFilterOption>
        </>
      )}
    </ConnectorFilterMenu>
  );
}

/**
 * The directory toolbar. Each scope is organised by exactly one dimension --
 * category for the catalog, agent for the connectors you already have -- so the
 * filter slot holds one control and changes contents with the segment rather
 * than putting two dropdowns side by side.
 */
function ConnectorsDirectoryToolbar({
  scope,
  setScope,
  badge,
  isAdmin,
  agents,
  connectionFilter,
  setConnectionFilter,
  search,
  setSearch,
  categories,
  categoryCounts,
  categoryFilter,
  setCategoryFilter,
}: {
  readonly scope: ConnectorsScope;
  readonly setScope: (value: ConnectorsScope) => void;
  readonly badge: ConnectorsScopeBadge;
  readonly isAdmin: boolean;
  readonly agents: readonly AgentResponse[];
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly setConnectionFilter: (value: ConnectorsConnectionFilter) => void;
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly categories: readonly ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[];
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly categoryFilter: string | null;
  readonly setCategoryFilter: (category: string | null) => void;
}) {
  const { t } = useTranslation();
  const customScope = useGet(connectorDirectoryCustomScope$);
  const active = categories.find((section) => {
    return section.category === categoryFilter;
  });
  // Custom is a scope, and the segment above already names the open one. Only a
  // category needs a trail, because a category is a place inside the catalog.
  const breadcrumb = customScope ? undefined : active?.label;
  return (
    // The controls outlive the header: the title scrolls away and the scope and
    // the search stay reachable. The negative margins hand back the page's own
    // top padding and column gap so nothing moves until the page is scrolled,
    // and the strip under the controls dissolves what passes beneath them
    // rather than clipping it on a line.
    // z-30 keeps the toolbar above complete card stacking contexts at the page
    // level. Each card owns the ordering of its actions within its isolate host.
    // The padding the strip carries is the clearance the segment gets once the
    // strip is latched, so it is the page's 24px rather than the 12px the
    // controls keep between themselves -- a gap equal to the one inside the
    // group reads as a crop against the viewport edge.
    // The strip repaints the workspace canvas, fill and gradient both, rather
    // than a flat colour: under a gradient palette the canvas is `--card` plus
    // two corner gradients, so any flat strip -- `background` or the canvas
    // fill alone -- stood out as a block the width of the 900px column,
    // hard-edged against the gradient on both sides.
    <div className="sticky top-0 z-30 -mb-6 -mt-6">
      <div className="relative isolate flex flex-col gap-3 pt-6">
        <WorkspaceCanvasBackdrop />
        <div className="flex items-center overflow-x-auto">
          <ConnectorsScopeSegment
            scope={scope}
            setScope={setScope}
            badge={badge}
          />
        </div>
        {breadcrumb &&
          scope !== "remote-control" &&
          scope !== "private-network" && (
            <ConnectorsBreadcrumb
              label={breadcrumb}
              onBack={() => {
                setCategoryFilter(null);
              }}
            />
          )}
        {scope !== "remote-control" && scope !== "private-network" && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 sm:flex-1">
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
                aria-hidden="true"
              />
              <Input
                type="text"
                placeholder={t(($) => {
                  return scope === "connected"
                    ? $.connectors.catalog.scope.searchConnected
                    : scope === "custom"
                      ? $.connectors.catalog.scope.searchCustom
                      : $.connectors.catalog.search;
                })}
                value={search}
                onChange={(event) => {
                  return setSearch(event.target.value);
                }}
                className="pl-9 pr-3"
              />
            </div>
            {scope === "connected" ? (
              <ConnectorAgentFilterMenu
                agents={agents}
                value={connectionFilter}
                onChange={setConnectionFilter}
              />
            ) : scope === "custom" ? (
              isAdmin && <NewCustomConnectorButton />
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0 self-end gap-1.5"
                      aria-label={t(($) => {
                        return $.connectors.catalog.filters.aria;
                      })}
                    />
                  }
                >
                  <Filter size={14} aria-hidden="true" />
                  <span className="max-w-[160px] truncate">
                    {t(
                      ($) => {
                        return $.connectors.catalog.filterWith;
                      },
                      {
                        category:
                          (customScope
                            ? t(($) => {
                                return $.connectors.catalog.directory.custom;
                              })
                            : active?.menuLabel) ??
                          t(($) => {
                            return $.connectors.catalog.filters.all;
                          }),
                      },
                    )}
                  </span>
                  <ChevronDown size={14} aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="max-h-[min(420px,var(--available-height))] w-64 overflow-y-auto"
                >
                  <ConnectorFilterSectionLabel>
                    {t(($) => {
                      return $.connectors.catalog.directory.browse;
                    })}
                  </ConnectorFilterSectionLabel>
                  <ConnectorFilterOption
                    active={!customScope && categoryFilter === null}
                    onSelect={() => {
                      setCategoryFilter(null);
                    }}
                  >
                    {t(($) => {
                      return $.connectors.catalog.filters.all;
                    })}
                  </ConnectorFilterOption>
                  <DropdownMenuSeparator />
                  <ConnectorFilterSectionLabel>
                    {t(($) => {
                      return $.connectors.catalog.filterCategory;
                    })}
                  </ConnectorFilterSectionLabel>
                  {categories.map((section) => {
                    const total = categoryCounts?.[section.category];
                    return (
                      <ConnectorFilterOption
                        key={section.category}
                        active={categoryFilter === section.category}
                        onSelect={() => {
                          setCategoryFilter(section.category);
                        }}
                      >
                        <span className="min-w-0 truncate">
                          {section.menuLabel}
                        </span>
                        {total !== undefined && (
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                            {total}
                          </span>
                        )}
                      </ConnectorFilterOption>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
      <div aria-hidden="true" className="relative isolate h-6">
        <WorkspaceCanvasBackdrop className="[-webkit-mask-image:linear-gradient(to_bottom,#000,transparent)] [mask-image:linear-gradient(to_bottom,#000,transparent)]" />
      </div>
    </div>
  );
}

/**
 * A category is a place, not a filter chip: entering one has to leave a way
 * back to the directory it was entered from.
 */
function ConnectorsBreadcrumb({
  label,
  onBack,
}: {
  readonly label: string;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="flex items-center gap-1.5 text-sm">
      <button
        type="button"
        className="cursor-pointer rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
        onClick={onBack}
      >
        {t(($) => {
          return $.connectors.catalog.scope.discover;
        })}
      </button>
      <span className="text-muted-foreground/50" aria-hidden="true">
        /
      </span>
      <span aria-current="page" className="font-medium text-foreground">
        {label}
      </span>
    </nav>
  );
}

function ConnectorCategoryGroupSection({
  group,
  renderCard,
}: {
  group: ConnectorCategoryGroup<PlatformConnectorCatalogStatusItem>;
  renderCard: (connector: PlatformConnectorCatalogStatusItem) => ReactNode;
}) {
  if (group.kind === "group") {
    return (
      <section
        key={group.id}
        className="flex flex-col gap-4"
        data-testid={`connector-category-${group.id}`}
      >
        <h2 className="text-sm font-medium text-muted-foreground">
          {group.label}
        </h2>
        <div className="flex flex-col gap-5">
          {group.sections.map((section) => {
            return (
              <div
                key={section.category}
                className="flex flex-col gap-3"
                data-testid={`connector-category-${section.category}`}
              >
                <h3 className="text-xs font-medium text-muted-foreground/80">
                  {section.label}
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {section.connectors.map(renderCard)}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  const section = group.sections[0];
  return (
    <section
      key={section.category}
      className="flex flex-col gap-3"
      data-testid={`connector-category-${section.category}`}
    >
      <h2 className="text-sm font-medium text-muted-foreground">
        {section.label}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {section.connectors.map(renderCard)}
      </div>
    </section>
  );
}

/**
 * The browse view: a shelf per category, six deep. Listing every discovered
 * connector under twelve headings puts the same wall of cards in front of
 * someone who came to add one thing. What this workspace already connected is
 * not repeated here -- it is the other scope, and a connected connector still
 * shows its account on its own card wherever it appears.
 */
/**
 * The open category, rendered a viewport at a time. The reserved rows are grid
 * items spanning the tracks their cards would occupy, so the scrollbar, the
 * column count and the row rhythm stay the browser's own -- the grid keeps its
 * responsive template and only the cards near the viewport are mounted.
 */
function ConnectorCategoryGrid({
  connectors,
  renderCard,
}: {
  readonly connectors: readonly PlatformConnectorCatalogStatusItem[];
  readonly renderCard: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ReactNode;
}) {
  const bindGrid = useSet(bindConnectorCategoryGrid$);
  const metrics = useGet(connectorCategoryGridMetrics$);
  const visible = connectorCategoryGridWindow(connectors.length, metrics);
  return (
    <div
      ref={bindGrid}
      data-testid="connector-category-grid"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      style={{
        gridAutoRows: `${CONNECTOR_CATEGORY_GRID_ROW_HEIGHT}px`,
      }}
    >
      {visible.leadingRows > 0 && (
        <div
          aria-hidden="true"
          data-testid="connector-category-reserved-rows"
          style={{
            gridColumn: "1 / -1",
            gridRow: `span ${visible.leadingRows}`,
          }}
        />
      )}
      {connectors.slice(visible.startIndex, visible.endIndex).map(renderCard)}
      {visible.trailingRows > 0 && (
        <div
          aria-hidden="true"
          data-testid="connector-category-reserved-rows"
          style={{
            gridColumn: "1 / -1",
            gridRow: `span ${visible.trailingRows}`,
          }}
        />
      )}
    </div>
  );
}

function ConnectorShelfBrowse({
  layout,
  renderCard,
}: {
  readonly layout: ConnectorShelfLayout<PlatformConnectorCatalogStatusItem>;
  readonly renderCard: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ReactNode;
}) {
  const onOpenCategory = useSet(setConnectorsCategoryFilter$);
  return (
    <>
      <section className="flex flex-col">
        {layout.shelves.map((shelf) => {
          return (
            <ConnectorShelfSection
              key={shelf.category ?? "head"}
              shelf={shelf}
              columns={3}
              onOpenCategory={onOpenCategory}
            >
              {shelf.connectors.map(renderCard)}
            </ConnectorShelfSection>
          );
        })}
        <ConnectorShelfChips chips={layout.chips} onSelect={onOpenCategory} />
      </section>
    </>
  );
}

/** Category totals ride on the discovery response; absent while it loads. */
function discoveryCategoryCounts(
  catalogStatusLoadable: Loadable<PublicConnectorCatalogDiscoveryResponse>,
): Readonly<Record<string, number>> | undefined {
  return catalogStatusLoadable.state === "hasData"
    ? catalogStatusLoadable.data.categoryConnectorCounts
    : undefined;
}

/**
 * The categories the filter offers. They come from the catalog's own category
 * list rather than from the connectors that came back, because inside a
 * category the response holds only that category and a filter offering
 * nothing else is a dead end.
 */
function categoryFilterSections(
  categoryMetadata: PublicConnectorCatalogCategoryMetadata | undefined,
): ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[] {
  return (categoryMetadata?.categories ?? []).map((category) => {
    return {
      category: category.id,
      label: category.label,
      menuLabel: category.menuLabel,
      groupId: category.groupId,
      connectors: [],
    };
  });
}

interface ConnectorsBrowseModel {
  /** Whether the catalog response has arrived; an empty list is not an answer. */
  readonly ready: boolean;
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly showShelves: boolean;
  /**
   * The chosen category's connectors, or null when no category is open. The
   * breadcrumb and the filter already name the category, so this view renders
   * the cards alone rather than repeating the name in a group and a section
   * heading above them.
   */
  readonly categoryConnectors:
    | readonly PlatformConnectorCatalogStatusItem[]
    | null;
  readonly layout: ConnectorShelfLayout<PlatformConnectorCatalogStatusItem>;
  readonly connected: readonly PlatformConnectorCatalogStatusItem[];
  readonly chipSections: readonly ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[];
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
}

/**
 * Splits what the page shows into "what you have" and "what you could add".
 * Shelves are built from the unconnected half only, and stand down entirely
 * once a keyword, a category or a status is chosen: that is already a filter,
 * and a shelf on top of it would hide most of what was just asked for.
 */
function buildConnectorsBrowseModel({
  catalogItems,
  categoryMetadata,
  categoryCounts,
  otherCategoryLabel,
  headLabel,
  search,
  categoryFilter,
  connectionFilter,
  ready,
}: {
  readonly catalogItems: readonly PlatformConnectorCatalogStatusItem[];
  readonly categoryMetadata: PublicConnectorCatalogCategoryMetadata | undefined;
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly otherCategoryLabel: string;
  readonly headLabel: string;
  readonly search: string;
  readonly categoryFilter: string | null;
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly ready: boolean;
}): ConnectorsBrowseModel {
  const filtered =
    search.trim().length > 0 ||
    categoryFilter !== null ||
    connectionFilter.kind !== "all";
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
  // Shelving is the unfiltered view's own work, and a filtered one throws the
  // result away. Inside a category that discarded pass groups and shelves the
  // whole category -- the largest holds over a thousand connectors -- on every
  // render of the page.
  const layout = filtered
    ? emptyConnectorShelfLayout<PlatformConnectorCatalogStatusItem>()
    : buildConnectorShelves({
        // Shelves cover the whole catalog, connected included: a connector this
        // workspace already has is still the answer to "what talks to Slack",
        // and its card says so by showing the account instead of an add button.
        sections: sectionsOf(catalogItems),
        categoryCounts,
        headLabel,
        // The page's card grid is three wide, so six is two whole rows.
        previewSize: 6,
      });
  // The filter lists the catalog's categories, not the ones the current
  // response happens to contain: inside a category the response holds only
  // that category, and a filter that offers nothing else is a dead end.
  const chipSections = categoryFilterSections(categoryMetadata);
  return {
    ready,
    connectionFilter,
    // Shelves need something to shelve: a catalog too small for any category to
    // fill one falls through to the plain list.
    showShelves: ready && !filtered && layout.shelves.length > 0,
    categoryConnectors:
      ready && categoryFilter !== null && catalogItems.length > 0
        ? catalogItems
        : null,
    layout,
    connected: catalogItems.filter((connector) => {
      return connector.connected;
    }),
    // Chips come from the whole catalog, not the filtered view: a chip row
    // that empties itself when you pick a chip cannot be used to pick another.
    chipSections,
    categoryCounts,
  };
}

/**
 * The built-in catalog: the shelves, the open category, or, once the reader has
 * searched, the plain result list.
 */
function ConnectorsBuiltinPanel({
  browse,
  renderCard,
  fallback,
}: {
  readonly browse: ConnectorsBrowseModel;
  readonly renderCard: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ReactNode;
  readonly fallback: ReactNode;
}) {
  if (browse.showShelves) {
    return (
      <ConnectorShelfBrowse layout={browse.layout} renderCard={renderCard} />
    );
  }
  if (browse.categoryConnectors) {
    return (
      <ConnectorCategoryGrid
        connectors={browse.categoryConnectors}
        renderCard={renderCard}
      />
    );
  }
  return fallback;
}

function connectorAgentName(agent: AgentResponse): string {
  return (
    agent.displayName ??
    i18n.t(($) => {
      return $.connectors.catalog.unnamedAgent;
    })
  );
}

function ConnectorAccessButton({
  connectorSlug,
  connectorLabel,
  allowAccessIncrease,
  onClick,
}: {
  readonly connectorSlug: ConnectorSlug;
  readonly connectorLabel: string;
  readonly allowAccessIncrease: boolean;
  readonly onClick: () => void;
}) {
  const agentsBySlugLoadable = useLastLoadable(
    connectorAuthorizedAgentsBySlug$,
  );
  const agents =
    agentsBySlugLoadable.state === "hasData"
      ? (agentsBySlugLoadable.data.get(connectorSlug) ?? [])
      : [];
  return (
    <ConnectorAgentAccessButton
      agents={agents}
      status={connectorAgentAccessStatus(agentsBySlugLoadable.state)}
      allowAccessIncrease={allowAccessIncrease}
      connectorLabel={connectorLabel}
      onClick={onClick}
    />
  );
}

/**
 * The catalog grouped under its categories. An empty result says nothing here:
 * the directory content owns the empty state for the sources it shows.
 */
function renderBuiltinList({
  loadingState,
  grouped,
  renderCard,
}: {
  loadingState: "loading" | "hasData" | "hasError";
  grouped: ConnectorCategoryGroup<PlatformConnectorCatalogStatusItem>[];
  renderCard: (connector: PlatformConnectorCatalogStatusItem) => ReactNode;
}): ReactNode {
  if (loadingState !== "hasData") {
    return <ConnectorCardSkeletons />;
  }
  return grouped.map((group) => {
    return (
      <ConnectorCategoryGroupSection
        key={group.id}
        group={group}
        renderCard={renderCard}
      />
    );
  });
}

/**
 * Remote control and Private network have their own panels; Connected lists
 * what this workspace already has; Discover and Custom are the directory.
 */
function ConnectorsPagePanels({
  scope,
  connectedPanel,
  directoryPanel,
  remoteControlPanel,
  privateNetworkPanel,
}: {
  readonly scope: ConnectorsScope;
  readonly connectedPanel: ReactNode;
  readonly directoryPanel: ReactNode;
  readonly remoteControlPanel: ReactNode;
  readonly privateNetworkPanel: ReactNode;
}) {
  if (scope === "remote-control") {
    return remoteControlPanel;
  }
  if (scope === "private-network") {
    return privateNetworkPanel;
  }
  if (scope === "connected") {
    return connectedPanel;
  }
  return directoryPanel;
}

/** The card grid before the catalog answers. */
function ConnectorCardSkeletons() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }, (_, index) => {
        return (
          <div
            key={index}
            data-testid="connector-skeleton"
            className={surfaceVariants({
              className: "flex flex-col animate-pulse",
            })}
          >
            <div className="flex h-14 items-center gap-2.5 px-5">
              <span className="h-5 w-5 shrink-0 rounded-lg bg-muted/50" />
              <span className="h-4 w-24 rounded bg-muted/50" />
            </div>
            <div className="flex h-11 items-center border-t border-border/30 px-5">
              <span className="h-3 w-16 rounded bg-muted/30" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** What a list says when it has nothing to show and knows why. */
function ConnectorEmptyState({ message }: { readonly message: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 py-12">
      <img
        src={noConnectorImg}
        alt={t(($) => {
          return $.connectors.catalog.noConnectorsAlt;
        })}
        className="h-20 w-20 object-contain opacity-80"
      />
      <p className="text-center text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

/**
 * Connected built-in and custom connector accounts. Remote control and private
 * network resources have their own scopes.
 */
function ConnectorsConnectedPanel({
  connected,
  ready,
  connectionFilter,
  renderCard,
  extras,
  extraCount,
  suppressEmpty = false,
}: {
  readonly connected: readonly PlatformConnectorCatalogStatusItem[];
  readonly ready: boolean;
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly renderCard: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ReactNode;
  readonly extras: ReactNode;
  readonly extraCount: number;
  readonly suppressEmpty?: boolean;
}) {
  const { t } = useTranslation();
  if (!ready) {
    return <ConnectorCardSkeletons />;
  }
  if (connected.length + extraCount === 0 && !suppressEmpty) {
    return (
      <ConnectorEmptyState
        message={t(($) => {
          // An empty list means something different under each filter: nothing
          // connected at all, nothing this agent can reach, or nothing left
          // that no agent uses.
          return connectionFilter.kind === "agent"
            ? $.connectors.catalog.empty.agent
            : connectionFilter.kind === "unshared"
              ? $.connectors.catalog.empty.unshared
              : $.connectors.catalog.empty.connected;
        })}
      />
    );
  }
  return (
    <div
      data-testid="connectors-connected-grid"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {connected.map(renderCard)}
      {extras}
    </div>
  );
}

function connectorLabelForSlug(
  connectors: readonly PlatformConnectorCatalogStatusItem[],
  connectorSlug: ConnectorSlug | null,
): string | null {
  if (!connectorSlug) {
    return null;
  }
  return (
    connectors.find((connector) => {
      return connector.slug === connectorSlug;
    })?.label ?? connectorSlug
  );
}

interface SettingsConnectorCardProps {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly accountSummary: ConnectorAccountDisplaySummary | undefined;
  readonly accountSummaryStatus: ConnectorAccountSummaryStatus;
  readonly busy: boolean;
  readonly connect: ConnectorConnectHandlers;
  readonly onManageAccounts: () => void;
  readonly onManageAccess: () => void;
}

interface ConnectorCatalogHeaderProps {
  readonly connectorCatalogCount: number | null;
}

function ConnectorCatalogHeader(props: ConnectorCatalogHeaderProps) {
  const { t } = useTranslation();
  const description =
    props.connectorCatalogCount !== null
      ? t(
          ($) => {
            return $.connectors.catalog.descriptionWithCount;
          },
          { value: formatLocalizedNumber(props.connectorCatalogCount) },
        )
      : t(($) => {
          return $.connectors.catalog.description;
        });
  return (
    <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-0 md:pt-10 pb-0">
      <div className="mx-auto w-full max-w-[900px]">
        <div className="min-w-0 hidden md:block">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.connectors.catalog.title;
            })}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </header>
  );
}

function SettingsConnectorCard(props: SettingsConnectorCardProps) {
  const manageAccess = (
    <ConnectorAccessButton
      connectorSlug={props.connector.slug}
      connectorLabel={props.connector.label}
      allowAccessIncrease={
        props.accountSummaryStatus === "ready" &&
        (props.accountSummary?.accountCount ?? 0) > 0
      }
      onClick={props.onManageAccess}
    />
  );
  return (
    <ConnectorCard
      variant="accounts"
      connector={props.connector}
      summary={props.accountSummary}
      summaryStatus={props.accountSummaryStatus}
      busy={props.busy}
      connect={props.connect}
      onManage={props.onManageAccounts}
      manageAccess={manageAccess}
    />
  );
}

function ManagedConnectorAccessDialog() {
  const connectorSlug = useGet(managedConnectorAccessSlug$);
  const close = useSet(closeConnectorAccessManagement$);
  const catalogItemsLoadable = useLastLoadable(relatedCatalogItems$);
  const accountSummariesLoadable = useLastLoadable(
    connectorOverviewAccountSummaryByTarget$,
  );
  if (!connectorSlug || catalogItemsLoadable.state !== "hasData") {
    return null;
  }
  const connectorLabel = connectorLabelForSlug(
    catalogItemsLoadable.data,
    connectorSlug,
  );
  if (!connectorLabel) {
    return null;
  }
  const accountSummary =
    accountSummariesLoadable.state === "hasData"
      ? accountSummariesLoadable.data.get(`builtin:${connectorSlug}`)
      : undefined;
  return (
    <ConnectorAccessManagementDialog
      connectorSlug={connectorSlug}
      connectorLabel={connectorLabel}
      allowAccessIncrease={(accountSummary?.accountCount ?? 0) > 0}
      onClose={close}
    />
  );
}

export function ConnectorsPage() {
  const { t } = useTranslation();
  const vncEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.VncAccess] === true;
  const relatedCatalogItemsLoadable = useLastLoadable(relatedCatalogItems$);
  const filteredCatalogItemsLoadable = useLoadable(
    filteredConnectorCatalogItems$,
  );
  const sshSummary = useLoadable(sshSummary$);
  const vncSummary = useLoadable(vncSummary$);
  const cloudflareAccessSummary = useLoadable(cloudflareAccessSummary$);
  const catalogStatusLoadable = useLastLoadable(connectorCatalogDiscovery$);
  const accountSummariesLoadable = useLastLoadable(
    connectorOverviewAccountSummaryByTarget$,
  );
  const accountSummaryStatus = connectorAccountSummaryStatus(
    accountSummariesLoadable.state,
  );
  const finishAccountConnection = useSet(finishConnectorAccountConnection$);
  const runConnectSuccess = useSet(runBuiltinConnectorConnectSuccess$);
  const managedAccountConnector = useGet(builtinAccountManager$);
  const accountConnect = useGet(builtinAccountConnectDialog$);
  const openAccountManager = useSet(openBuiltinAccountManager$);
  const closeAccountManager = useSet(closeBuiltinAccountManager$);
  const openAccountConnect = useSet(openBuiltinAccountConnectDialog$);
  const closeAccountConnect = useSet(closeBuiltinAccountConnectDialog$);
  const pollingAuthCodeSlug = useGet(builtinPollingOAuthAuthCodeSlug$);
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  const connectFlowSlug = useGet(builtinConnectFlowSlug$);
  const connect = useSet(connectBuiltinConnectorOAuthAuthCodeAndSettle$);
  const connectNoAuth = useSet(connectBuiltinConnectorNoAuth$);
  const signal = useGet(pageSignal$);
  const scopeReviewSelection = useGet(builtinConnectorScopeReviewSelection$);
  const setScopeReviewSelection = useSet(
    setBuiltinConnectorScopeReviewSelection$,
  );
  const setManagedConnectorSlug = useSet(setManagedConnectorAccessSlug$);
  const scope = useGet(connectorsScope$);
  const setScope = useSet(setConnectorsScope$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;

  const search = useGet(connectorsSearch$);
  const setSearch = useSet(setConnectorsSearch$);
  const connectionFilter = useGet(connectorsConnectionFilter$);
  const setConnectionFilter = useSet(setConnectorsConnectionFilter$);
  const categoryFilter = useGet(connectorsCategoryFilter$);
  const setCategoryFilter = useSet(setConnectorsCategoryFilter$);
  const connectedBadge = useLastLoadable(connectedConnectorsBadge$);
  const custom = directoryCustomConnectors(
    useLastLoadable(filteredDirectoryCustomConnectors$),
  );
  const scopeBadge = connectorsScopeBadge(
    connectedBadge,
    custom.all.length,
    configuredRemoteAccessResources(sshSummary) +
      (vncEnabled ? configuredRemoteAccessResources(vncSummary) : 0),
    configuredRemoteAccessResources(cloudflareAccessSummary),
  );
  const agentsLoadable = useLastLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];

  const filteredConnectors =
    filteredCatalogItemsLoadable.state === "hasData"
      ? filteredCatalogItemsLoadable.data
      : [];
  const connectorCatalogCount =
    catalogStatusLoadable.state === "hasData"
      ? catalogStatusLoadable.data.totalConnectorCount
      : null;
  const categoryMetadata = localizeConnectorCategoryMetadata(
    catalogStatusLoadable.state === "hasData"
      ? catalogStatusLoadable.data.categoryMetadata
      : undefined,
  );
  const allConnectors =
    relatedCatalogItemsLoadable.state === "hasData"
      ? relatedCatalogItemsLoadable.data
      : [];
  const finishExplicitAccountAdd = async (
    connector: PlatformConnectorCatalogStatusItem,
    connectionId: string | null,
    attemptSignal: AbortSignal,
  ): Promise<void> => {
    await runConnectSuccess(
      connector.slug,
      (completedConnectionId, continuationSignal) => {
        return finishAccountConnection(
          {
            target: { kind: "builtin", connectorSlug: connector.slug },
            connectionId: completedConnectionId,
            connectorLabel: connector.label,
            mode: { kind: "add" },
          },
          continuationSignal,
        );
      },
      connectionId,
      attemptSignal,
    );
  };

  const accountConnectHandlers = (
    connector: PlatformConnectorCatalogStatusItem,
  ): ConnectorConnectHandlers => {
    return {
      openModal: () => {
        openAccountConnect(connector, { kind: "add" });
      },
      connectBrowserAuth: async (authMethod) => {
        await connect(
          {
            connectorSlug: connector.slug,
            method: authMethod,
            options: {
              account: { intent: "add" },
              authorizeVisibleAgents: true,
              connectorLabel: connector.label,
              connectorIcon: connector.icon,
            },
            onSuccess: (connectionId, attemptSignal) => {
              return finishExplicitAccountAdd(
                connector,
                connectionId,
                attemptSignal,
              );
            },
          },
          signal,
        );
      },
      connectNoAuth: async (authMethod) => {
        const result = await connectNoAuth(
          {
            connectorSlug: connector.slug,
            authMethod,
            options: {
              account: { intent: "add" },
              authorizeVisibleAgents: true,
              connectorLabel: connector.label,
            },
          },
          signal,
        );
        if (result) {
          await finishExplicitAccountAdd(
            connector,
            result.connectionId,
            signal,
          );
        }
        return result;
      },
    };
  };

  const renderCard = (c: PlatformConnectorCatalogStatusItem) => {
    const isPolling =
      pollingAuthCodeSlug === c.slug ||
      pollingDeviceAuthSlug === c.slug ||
      connectFlowSlug === c.slug;
    const summary =
      accountSummariesLoadable.state === "hasData"
        ? accountSummariesLoadable.data.get(`builtin:${c.slug}`)
        : undefined;
    return (
      <SettingsConnectorCard
        key={c.slug}
        connector={c}
        accountSummary={summary}
        accountSummaryStatus={accountSummaryStatus}
        busy={isPolling}
        connect={accountConnectHandlers(c)}
        onManageAccounts={() => {
          return openAccountManager(c, signal);
        }}
        onManageAccess={() => {
          return setManagedConnectorSlug(c.slug);
        }}
      />
    );
  };

  const otherCategoryLabel = t(($) => {
    return $.connectors.catalog.otherCategory;
  });
  const browse = buildConnectorsBrowseModel({
    catalogItems: filteredConnectors,
    categoryMetadata,
    categoryCounts: discoveryCategoryCounts(catalogStatusLoadable),
    otherCategoryLabel,
    headLabel: t(($) => {
      return $.connectors.catalog.shelf.top;
    }),
    search,
    categoryFilter,
    connectionFilter,
    ready: filteredCatalogItemsLoadable.state === "hasData",
  });

  const builtinList = renderBuiltinList({
    loadingState: filteredCatalogItemsLoadable.state,
    grouped: groupConnectorsByCategory(
      filteredConnectors,
      categoryMetadata,
      otherCategoryLabel,
    ),
    renderCard,
  });
  const builtinPanel = (
    <ConnectorsBuiltinPanel
      browse={browse}
      renderCard={renderCard}
      fallback={builtinList}
    />
  );
  return (
    <div
      data-testid="connectors-scroll-viewport"
      className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]"
    >
      <ConnectorCatalogHeader connectorCatalogCount={connectorCatalogCount} />

      <main
        data-testid="connectors-scroll-content"
        className="flex-1 px-4 sm:px-6 pt-6 pb-safe-or-16"
      >
        <div className="relative mx-auto w-full max-w-[900px]">
          <div className="min-w-0 flex w-full max-w-[900px] flex-col gap-6">
            <ConnectorsDirectoryToolbar
              scope={scope}
              setScope={setScope}
              badge={scopeBadge}
              isAdmin={isAdmin}
              agents={agents}
              connectionFilter={connectionFilter}
              setConnectionFilter={setConnectionFilter}
              search={search}
              setSearch={setSearch}
              categories={browse.chipSections}
              categoryCounts={browse.categoryCounts}
              categoryFilter={categoryFilter}
              setCategoryFilter={setCategoryFilter}
            />

            <ConnectorsPagePanels
              scope={scope}
              connectedPanel={
                <ConnectorsConnectedPanel
                  connected={browse.connected}
                  ready={browse.ready}
                  connectionFilter={connectionFilter}
                  renderCard={renderCard}
                  extraCount={custom.connected.length}
                  extras={
                    custom.connected.length > 0 ? (
                      <CustomConnectorGrid
                        connectors={custom.connected}
                        isAdmin={isAdmin}
                        className="contents"
                      />
                    ) : null
                  }
                />
              }
              remoteControlPanel={
                <RemoteControlPanel vncEnabled={vncEnabled} />
              }
              privateNetworkPanel={<PrivateNetworkPanel />}
              directoryPanel={
                <ConnectorsDirectoryContent
                  builtin={builtinPanel}
                  builtinState={filteredCatalogItemsLoadable.state}
                  builtinCount={filteredConnectors.length}
                />
              }
            />
          </div>
        </div>
      </main>

      {accountConnect && (
        <ConnectModal
          item={accountConnect.connector}
          authorizeVisibleAgentsOnConnect
          accountMode={accountConnect.mode}
          accountOptions={{
            account:
              accountConnect.mode.kind === "add"
                ? { intent: "add" }
                : {
                    intent: "reconnect",
                    connectionId: accountConnect.mode.connectionId,
                  },
          }}
          onClose={() => {
            closeAccountConnect();
          }}
          onSuccess={async (connectionId, attemptSignal) => {
            await finishAccountConnection(
              {
                target: {
                  kind: "builtin",
                  connectorSlug: accountConnect.connector.slug,
                },
                connectionId,
                connectorLabel: accountConnect.connector.label,
                mode: accountConnect.mode,
              },
              attemptSignal,
            );
          }}
        />
      )}

      {managedAccountConnector && (
        <ConnectorAccountManagerDialog
          target={{
            kind: "builtin",
            connectorSlug: managedAccountConnector.slug,
          }}
          connectorLabel={managedAccountConnector.label}
          icon={<ConnectorIcon icon={managedAccountConnector.icon} size={20} />}
          onClose={() => {
            closeAccountManager();
          }}
          onAdd={() => {
            closeAccountManager();
            launchConnectorConnect({
              connector: managedAccountConnector,
              ...accountConnectHandlers(managedAccountConnector),
            });
          }}
          onReconnect={(account) => {
            openAccountConnect(managedAccountConnector, {
              kind: "reconnect",
              connectionId: account.id,
              authMethod: account.authMethod,
            });
          }}
          onReviewScopes={(account) => {
            closeAccountManager();
            setScopeReviewSelection({
              connectorSlug: managedAccountConnector.slug,
              connectionId: account.id,
              authMethod: account.authMethod,
            });
          }}
        />
      )}

      {scopeReviewSelection && (
        <ScopeReviewModal
          selection={scopeReviewSelection}
          onClose={() => {
            return setScopeReviewSelection(null);
          }}
          onReconnect={(selection) => {
            setScopeReviewSelection(null);
            const connector = allConnectors.find((connector) => {
              return connector.slug === selection.connectorSlug;
            });
            if (connector) {
              openAccountConnect(connector, {
                kind: "reconnect",
                connectionId: selection.connectionId,
                authMethod: selection.authMethod,
              });
            }
          }}
        />
      )}
      <ConnectorAccountNameDialog />

      <ManagedConnectorAccessDialog />
    </div>
  );
}
