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
import { Search, Plus, Filter, ChevronDown, Check } from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import type {
  PublicConnectorCatalogCategoryMetadata,
  PublicConnectorCatalogDiscoveryResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { Tabs, TabsList, TabsTrigger } from "@okouai/ui/components/ui/tabs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import {
  connectorsPageTab$,
  setConnectorsPageTab$,
  openCustomConnectorCreateDialog$,
} from "../../signals/okou-page/settings/custom-connectors.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { agents$ } from "../../signals/agent.ts";
import { CustomConnectorsPanel } from "./components/settings/custom-connectors-panel.tsx";
import { ConnectorsDirectoryContent } from "./connectors-directory-content.tsx";
import {
  connectorDirectoryCustomScope$,
  connectorsScope$,
  openConnectorDirectoryScope$,
  setConnectorsScope$,
  type ConnectorsScope,
} from "../../signals/okou-page/settings/connector-directory-route.ts";
import {
  connectorCatalogDiscovery$,
  connectConnectorOAuthAuthCode$,
  connectConnectorNoAuth$,
  connectFlowConnectorSlug$,
  runConnectorConnectSuccess$,
  connectorsSearch$,
  connectorsCategoryFilter$,
  connectorsConnectionFilter$,
  filteredConnectorCatalogItems$,
  setConnectorsCategoryFilter$,
  setConnectorsConnectionFilter$,
  setConnectorsSearch$,
  pollingOAuthAuthCodeConnectorSlug$,
  pollingOAuthDeviceAuthConnectorSlug$,
  relatedCatalogItems$,
  scopeReviewSelection$,
  setScopeReviewSelection$,
  type ConnectorsConnectionFilter,
} from "../../signals/okou-page/settings/connectors.ts";
import {
  buildConnectorShelves,
  type ConnectorShelfLayout,
} from "../../signals/okou-page/settings/connector-shelves.ts";
import {
  activeConnectorCategoryId$,
  attachConnectorCategoryScrollTracking$,
  getConnectorCategorySectionId,
  groupConnectorsByCategory,
  resetActiveConnectorCategory$,
  scrollToConnectorCategory,
  type ConnectorCategoryGroup,
  type ConnectorCategorySection,
} from "../../signals/okou-page/settings/connector-categories.ts";
import { localizeConnectorCategoryMetadata } from "./components/settings/connector-category-labels.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import {
  ConnectorCard,
  connectorAccountSummaryStatus,
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
  connectorAccountSummaryByTarget$,
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
import { SshConnectorCard } from "./components/settings/ssh-connector-card.tsx";
import { SshAccessManagementDialog } from "./components/settings/ssh-access-management-dialog.tsx";
import { SshLoadError } from "./ssh-load-error.tsx";
import { sshSummary$, sshAgentAccessRows$ } from "../../signals/ssh.ts";
import {
  filteredSshSummary$,
  REMOTE_ACCESS_CATEGORY,
} from "../../signals/okou-page/settings/ssh-connector.ts";

function withRemoteAccessCategory(
  metadata: PublicConnectorCatalogCategoryMetadata | undefined,
  label: string,
): PublicConnectorCatalogCategoryMetadata {
  return {
    categories: [
      ...(metadata?.categories ?? []),
      { id: REMOTE_ACCESS_CATEGORY, label, menuLabel: label, groupId: null },
    ],
    groups: metadata?.groups ?? [],
  };
}

type ConnectorPresentation =
  | {
      readonly kind: "catalog";
      readonly connector: PlatformConnectorCatalogStatusItem;
      readonly category: string;
      readonly popularityRank: number | undefined;
      readonly label: string;
      readonly connected: boolean;
    }
  | {
      readonly kind: "ssh";
      readonly category: string;
      readonly label: string;
      readonly connected: boolean;
      readonly configuredCount: number;
    };

// Callback ref that attaches scroll tracking while enabled. Each call returns
// a fresh ref callback; React only invokes it when the underlying element
// changes, so listeners are registered on mount and cleaned up on unmount.
function useScrollTrackingRef(
  enabled: boolean,
  attach: (el: HTMLElement) => () => void,
  resetActive: () => void,
) {
  let cleanup: (() => void) | null = null;
  return (el: HTMLDivElement | null) => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    if (el && enabled) {
      cleanup = attach(el);
    } else {
      resetActive();
    }
  };
}

function ConnectorCategoryMenu({
  activeCategoryId,
  groups,
}: {
  activeCategoryId: string | null;
  groups: readonly ConnectorCategoryGroup<ConnectorPresentation>[];
}) {
  const { t } = useTranslation();
  if (groups.length <= 1) {
    return null;
  }

  return (
    <aside className="pointer-events-none fixed right-6 top-[28vh] z-30 hidden w-44 min-[1332px]:block">
      <nav
        aria-label={t(($) => {
          return $.connectors.catalog.categoriesAria;
        })}
        className="group pointer-events-auto ml-auto flex max-h-[68vh] w-6 flex-col gap-3 overflow-x-hidden overflow-y-auto rounded-xl border border-transparent bg-transparent px-1 py-2 transition-all duration-150 hover:w-44 hover:border-border/60 hover:bg-popover hover:shadow-lg focus-within:w-44 focus-within:border-border/60 focus-within:bg-popover focus-within:shadow-lg 2xl:ml-0 2xl:w-full 2xl:overflow-y-auto 2xl:rounded-none 2xl:border-transparent 2xl:px-0 2xl:py-0 2xl:pb-3 2xl:pl-5 2xl:hover:w-full 2xl:hover:border-transparent 2xl:hover:bg-transparent 2xl:hover:shadow-none 2xl:focus-within:w-full 2xl:focus-within:border-transparent 2xl:focus-within:bg-transparent 2xl:focus-within:shadow-none"
      >
        {groups.flatMap((group) => {
          if (group.kind === "group") {
            const isActiveChild = group.sections.some((section) => {
              return activeCategoryId === section.category;
            });
            return [
              <ConnectorCategoryMenuItem
                key={group.id}
                activeState={
                  activeCategoryId === group.id
                    ? "current"
                    : isActiveChild
                      ? "ancestor"
                      : null
                }
                depth="parent"
                label={group.label}
                menuLabel={group.menuLabel}
                targetId={group.id}
                onClick={() => {
                  scrollToConnectorCategory(group.id);
                }}
              />,
              ...group.sections.map((section) => {
                return (
                  <ConnectorCategoryMenuItem
                    key={section.category}
                    activeState={
                      activeCategoryId === section.category ? "current" : null
                    }
                    depth="child"
                    label={section.label}
                    menuLabel={section.menuLabel}
                    targetId={section.category}
                    onClick={() => {
                      scrollToConnectorCategory(section.category);
                    }}
                  />
                );
              }),
            ];
          }

          const section = group.sections[0];
          return [
            <ConnectorCategoryMenuItem
              key={section.category}
              activeState={
                activeCategoryId === section.category ? "current" : null
              }
              depth="parent"
              label={section.label}
              menuLabel={section.menuLabel}
              targetId={section.category}
              onClick={() => {
                scrollToConnectorCategory(section.category);
              }}
            />,
          ];
        })}
      </nav>
    </aside>
  );
}

function ConnectorCategoryMenuItem({
  activeState,
  depth,
  label,
  menuLabel,
  targetId,
  onClick,
}: {
  activeState: "current" | "ancestor" | null;
  depth: "parent" | "child";
  label: string;
  menuLabel: string;
  targetId: string;
  onClick: () => void;
}) {
  const isChild = depth === "child";
  const lineClass =
    activeState === "current"
      ? isChild
        ? "ml-1 w-3 bg-foreground/70 group-hover/item:bg-foreground/80"
        : "w-4 bg-foreground/70 group-hover/item:bg-foreground/80"
      : activeState === "ancestor"
        ? "w-4 bg-muted-foreground/55 group-hover/item:bg-foreground/60"
        : isChild
          ? "ml-1 w-3 bg-muted-foreground/20 group-hover:bg-muted-foreground/35 group-hover/item:bg-foreground/50"
          : "w-4 bg-muted-foreground/20 group-hover:bg-muted-foreground/35 group-hover/item:bg-foreground/50";

  return (
    <button
      type="button"
      aria-label={label}
      aria-current={activeState === "current" ? "true" : undefined}
      data-testid={`connector-category-menu-${targetId}`}
      title={label}
      className={`group/item relative flex h-3 w-full items-center text-left leading-snug transition-all duration-150 group-hover:h-5 group-focus-within:h-5 2xl:group-hover:h-3 2xl:group-focus-within:h-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 ${
        activeState === "current"
          ? isChild
            ? "text-[11px] text-foreground hover:text-foreground"
            : "text-xs font-medium text-foreground hover:text-foreground"
          : isChild
            ? "text-[11px] text-muted-foreground/70 hover:text-foreground"
            : "text-xs font-medium text-muted-foreground hover:text-foreground"
      }`}
      onClick={onClick}
    >
      <span
        aria-hidden="true"
        className={`block h-0.5 rounded-sm transition-all duration-150 group-hover:opacity-0 group-focus-within:opacity-0 2xl:group-hover:opacity-100 2xl:group-focus-within:opacity-100 ${lineClass}`}
      />
      <span className="absolute left-0 top-1/2 block -translate-y-1/2 translate-x-1 whitespace-nowrap opacity-0 transition-all duration-150 group-hover:left-3 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:left-3 group-focus-within:translate-x-0 group-focus-within:opacity-100 2xl:left-7 2xl:group-hover:left-7 2xl:group-focus-within:left-7">
        {menuLabel}
      </span>
    </button>
  );
}

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

function ConnectorFilterDropdown({
  value,
  agents,
  onChange,
}: {
  readonly value: ConnectorsConnectionFilter;
  readonly agents: readonly AgentResponse[];
  readonly onChange: (value: ConnectorsConnectionFilter) => void;
}) {
  const { t } = useTranslation();
  const activeAgent =
    value.kind === "agent"
      ? agents.find((agent) => {
          return agent.agentId === value.agentId;
        })
      : undefined;
  const triggerLabel =
    value.kind === "connected"
      ? t(($) => {
          return $.connectors.catalog.filters.connected;
        })
      : value.kind === "not-connected"
        ? t(($) => {
            return $.connectors.catalog.filters.notConnected;
          })
        : value.kind === "agent" && activeAgent
          ? connectorAgentName(activeAgent)
          : t(($) => {
              return $.connectors.catalog.filters.all;
            });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="neutral"
          size="sm"
          aria-label={t(($) => {
            return $.connectors.catalog.filters.aria;
          })}
          className="hidden h-9 shrink-0 gap-1.5 rounded-lg sm:inline-flex"
        >
          <Filter size={14} className="" />
          {activeAgent && (
            <AvatarFromUrl
              avatarUrl={activeAgent.avatarUrl}
              alt={connectorAgentName(activeAgent)}
              size={16}
              className="h-4 w-4 rounded-full object-cover"
            />
          )}
          <span className="max-w-[140px] truncate">{triggerLabel}</span>
          <ChevronDown size={14} className="" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(420px,var(--available-height))] w-56 overflow-y-auto"
      >
        <ConnectorFilterOption
          active={value.kind === "all"}
          onSelect={() => {
            onChange({ kind: "all" });
          }}
        >
          {t(($) => {
            return $.connectors.catalog.filters.all;
          })}
        </ConnectorFilterOption>
        <DropdownMenuSeparator />
        <ConnectorFilterSectionLabel>
          {t(($) => {
            return $.connectors.catalog.filters.status;
          })}
        </ConnectorFilterSectionLabel>
        <ConnectorFilterOption
          active={value.kind === "connected"}
          onSelect={() => {
            onChange({ kind: "connected" });
          }}
        >
          {t(($) => {
            return $.connectors.catalog.filters.connected;
          })}
        </ConnectorFilterOption>
        <ConnectorFilterOption
          active={value.kind === "not-connected"}
          onSelect={() => {
            onChange({ kind: "not-connected" });
          }}
        >
          {t(($) => {
            return $.connectors.catalog.filters.notConnected;
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
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ConnectorsScopeBadge {
  readonly count: number;
  readonly needsAttention: boolean;
}

/** Before the summaries land the segment says nothing rather than zero. */
function connectorsScopeBadge(
  loadable: Loadable<ConnectorsScopeBadge>,
): ConnectorsScopeBadge {
  return loadable.state === "hasData"
    ? loadable.data
    : { count: 0, needsAttention: false };
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
      <SegmentControlItem value="discover">
        {t(($) => {
          return $.connectors.catalog.scope.discover;
        })}
      </SegmentControlItem>
      <SegmentControlItem value="mine" data-testid="connectors-scope-mine">
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
          return $.connectors.catalog.scope.mine;
        })}
        {badge.count > 0 && (
          // The count pairs its own line height: an arbitrary font size carries
          // none, and the segment must not take its box from an ancestor.
          <span className="text-[11px]/4 tabular-nums text-muted-foreground/70">
            {formatLocalizedNumber(badge.count)}
          </span>
        )}
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
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0 self-end gap-1.5"
          aria-label={t(($) => {
            return $.connectors.catalog.filters.aria;
          })}
        >
          <Filter size={14} aria-hidden="true" />
          {leading}
          <span className="max-w-[160px] truncate">{label}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
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
  const openScope = useSet(openConnectorDirectoryScope$);
  const active = categories.find((section) => {
    return section.category === categoryFilter;
  });
  const breadcrumb = customScope
    ? t(($) => {
        return $.connectors.catalog.directory.custom;
      })
    : active?.label;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center">
        <ConnectorsScopeSegment
          scope={scope}
          setScope={setScope}
          badge={badge}
        />
      </div>
      {breadcrumb && (
        <ConnectorsBreadcrumb
          label={breadcrumb}
          onBack={() => {
            setCategoryFilter(null);
          }}
        />
      )}
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
              return scope === "mine"
                ? $.connectors.catalog.scope.searchMine
                : $.connectors.catalog.search;
            })}
            value={search}
            onChange={(event) => {
              return setSearch(event.target.value);
            }}
            className="pl-9 pr-3"
          />
        </div>
        {scope === "mine" ? (
          <ConnectorAgentFilterMenu
            agents={agents}
            value={connectionFilter}
            onChange={setConnectionFilter}
          />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-9 shrink-0 self-end gap-1.5"
                aria-label={t(($) => {
                  return $.connectors.catalog.filters.aria;
                })}
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
              </Button>
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
              <ConnectorFilterOption
                active={customScope}
                onSelect={() => {
                  openScope({ kind: "custom" });
                }}
              >
                {t(($) => {
                  return $.connectors.catalog.directory.custom;
                })}
              </ConnectorFilterOption>
              {categories.some((section) => {
                return section.category === REMOTE_ACCESS_CATEGORY;
              }) && (
                <ConnectorFilterOption
                  active={categoryFilter === REMOTE_ACCESS_CATEGORY}
                  onSelect={() => {
                    setCategoryFilter(REMOTE_ACCESS_CATEGORY);
                  }}
                >
                  {t(($) => {
                    return $.connectors.catalog.remoteAccess;
                  })}
                </ConnectorFilterOption>
              )}
              <DropdownMenuSeparator />
              <ConnectorFilterSectionLabel>
                {t(($) => {
                  return $.connectors.catalog.filterCategory;
                })}
              </ConnectorFilterSectionLabel>
              {categories
                .filter((section) => {
                  return section.category !== REMOTE_ACCESS_CATEGORY;
                })
                .map((section) => {
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

function ConnectorsToolbarActions({
  activeTab,
  search,
  setSearch,
  showAccessManagement,
  connectionFilter,
  agents,
  setConnectionFilter,
  isAdmin,
  onCreateCustom,
}: {
  readonly activeTab: "builtin" | "custom";
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly showAccessManagement: boolean;
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly agents: readonly AgentResponse[];
  readonly setConnectionFilter: (value: ConnectorsConnectionFilter) => void;
  readonly isAdmin: boolean;
  readonly onCreateCustom: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      {activeTab === "builtin" && (
        <div className="relative w-40 sm:w-52">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          />
          <Input
            type="text"
            placeholder={t(($) => {
              return $.connectors.catalog.search;
            })}
            value={search}
            onChange={(e) => {
              return setSearch(e.target.value);
            }}
            className="pl-9 pr-3"
          />
        </div>
      )}
      {activeTab === "builtin" && showAccessManagement && (
        <ConnectorFilterDropdown
          value={connectionFilter}
          agents={agents}
          onChange={setConnectionFilter}
        />
      )}
      {activeTab === "custom" && isAdmin && (
        <Button
          variant="neutral"
          size="sm"
          className="h-9 gap-2 shrink-0 rounded-lg"
          onClick={onCreateCustom}
        >
          <Plus size={14} />
          {t(($) => {
            return $.connectors.catalog.newConnector;
          })}
        </Button>
      )}
    </div>
  );
}

function ConnectorCategoryGroupSection({
  group,
  renderCard,
}: {
  group: ConnectorCategoryGroup<ConnectorPresentation>;
  renderCard: (connector: ConnectorPresentation) => ReactNode;
}) {
  if (group.kind === "group") {
    return (
      <section
        key={group.id}
        id={getConnectorCategorySectionId(group.id)}
        className="scroll-mt-6 flex flex-col gap-4"
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
                id={getConnectorCategorySectionId(section.category)}
                className="scroll-mt-6 flex flex-col gap-3"
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
      id={getConnectorCategorySectionId(section.category)}
      className="scroll-mt-6 flex flex-col gap-3"
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
  sshAvailable,
  remoteAccessLabel,
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
  readonly sshAvailable: boolean;
  readonly remoteAccessLabel: string;
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
  const layout = buildConnectorShelves({
    // Shelves cover the whole catalog, connected included: a connector this
    // workspace already has is still the answer to "what talks to Slack", and
    // its card says so by showing the account instead of an add button.
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
  if (sshAvailable) {
    chipSections.push({
      category: REMOTE_ACCESS_CATEGORY,
      label: remoteAccessLabel,
      menuLabel: remoteAccessLabel,
      groupId: null,
      connectors: [],
    });
  }
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
    categoryCounts: sshAvailable
      ? { ...categoryCounts, [REMOTE_ACCESS_CATEGORY]: 1 }
      : categoryCounts,
  };
}

/**
 * The built-in tab. Chips first, because category is the dimension that makes
 * four thousand connectors browsable; then either the shelves or, once the
 * reader has filtered, the plain result list.
 */
function ConnectorsBuiltinPanel({
  browse,
  renderCard,
  fallback,
  remoteAccessPanel,
  directoryEnabled,
}: {
  readonly browse: ConnectorsBrowseModel;
  readonly renderCard: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ReactNode;
  readonly fallback: ReactNode;
  readonly remoteAccessPanel: ReactNode;
  readonly directoryEnabled: boolean;
}) {
  return (
    <>
      {browse.showShelves ? (
        <ConnectorShelfBrowse layout={browse.layout} renderCard={renderCard} />
      ) : browse.categoryConnectors ? (
        <div
          data-testid="connector-category-grid"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {browse.categoryConnectors.map(renderCard)}
        </div>
      ) : (
        fallback
      )}
      {!directoryEnabled && remoteAccessPanel}
    </>
  );
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

function renderBuiltinList({
  loadingState,
  grouped,
  filteredCount,
  renderCard,
  search,
  connectionFilter,
  suppressEmpty = false,
}: {
  loadingState: "loading" | "hasData" | "hasError";
  grouped: ConnectorCategoryGroup<ConnectorPresentation>[];
  filteredCount: number;
  renderCard: (connector: ConnectorPresentation) => ReactNode;
  search: string;
  connectionFilter: ConnectorsConnectionFilter;
  suppressEmpty?: boolean;
}): ReactNode {
  if (loadingState !== "hasData") {
    return <ConnectorCardSkeletons />;
  }

  if (filteredCount === 0) {
    if (suppressEmpty) {
      return null;
    }
    const trimmedSearch = search.trim();
    const base =
      connectionFilter.kind === "connected"
        ? i18n.t(($) => {
            return $.connectors.catalog.empty.connected;
          })
        : connectionFilter.kind === "not-connected"
          ? i18n.t(($) => {
              return $.connectors.catalog.empty.notConnected;
            })
          : connectionFilter.kind === "agent"
            ? i18n.t(($) => {
                return $.connectors.catalog.empty.agent;
              })
            : null;
    const message = base
      ? trimmedSearch
        ? i18n.t(
            ($) => {
              return $.connectors.catalog.empty.matching;
            },
            { message: base, search: trimmedSearch },
          )
        : base
      : trimmedSearch
        ? i18n.t(
            ($) => {
              return $.connectors.catalog.empty.search;
            },
            { search: trimmedSearch },
          )
        : null;
    if (!message) {
      return null;
    }
    return <ConnectorEmptyState message={message} />;
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
 * Which list the page body shows. The directory has two scopes and the tabs it
 * replaces have two of their own, so the choice lives here rather than as three
 * nested conditionals inside the page.
 */
function ConnectorsPagePanels({
  shelfEnabled,
  scope,
  activeTab,
  builtinPanel,
  minePanel,
  directoryPanel,
}: {
  readonly shelfEnabled: boolean;
  readonly scope: ConnectorsScope;
  readonly activeTab: "builtin" | "custom";
  readonly builtinPanel: ReactNode;
  readonly minePanel: ReactNode;
  readonly directoryPanel: ReactNode;
}) {
  if (!shelfEnabled) {
    return activeTab === "custom" ? <CustomConnectorsPanel /> : builtinPanel;
  }
  return scope === "mine" ? minePanel : directoryPanel;
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
 * The connectors this workspace already has. It is a plain grid rather than a
 * shelf view: the list is short enough to read, and the only dimension that
 * organises it -- which agent uses it -- lives in the toolbar.
 */
function ConnectorsMinePanel({
  connected,
  ready,
  connectionFilter,
  renderCard,
}: {
  readonly connected: readonly PlatformConnectorCatalogStatusItem[];
  readonly ready: boolean;
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly renderCard: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ReactNode;
}) {
  const { t } = useTranslation();
  if (!ready) {
    return <ConnectorCardSkeletons />;
  }
  if (connected.length === 0) {
    return (
      <ConnectorEmptyState
        message={t(($) => {
          // An empty list means something different under each filter: nothing
          // connected at all, nothing this agent can reach, or nothing left
          // that no agent uses.
          if (connectionFilter.kind === "agent") {
            return $.connectors.catalog.empty.agent;
          }
          return connectionFilter.kind === "unshared"
            ? $.connectors.catalog.empty.unshared
            : $.connectors.catalog.empty.connected;
        })}
      />
    );
  }
  return (
    <div
      data-testid="connectors-mine-grid"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {connected.map(renderCard)}
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

function effectiveConnectorCatalogCount(
  catalogStatusLoadable: Loadable<PublicConnectorCatalogDiscoveryResponse>,
  sshSummary: Loadable<{ readonly configuredCount: number } | null>,
): number | null {
  if (catalogStatusLoadable.state !== "hasData") {
    return null;
  }
  return (
    catalogStatusLoadable.data.totalConnectorCount +
    (sshSummary.state === "hasData" && sshSummary.data ? 1 : 0)
  );
}

interface SettingsConnectorCardProps {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly accountSummary: ConnectorAccountSummary | undefined;
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
    <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
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
  const accountSummariesLoadable = useLoadable(
    connectorAccountSummaryByTarget$,
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

function SshDirectoryLoadError() {
  const summary = useLoadable(sshSummary$);
  const filtered = useLoadable(filteredSshSummary$);
  const rows = useLoadable(sshAgentAccessRows$);
  return summary.state === "hasError" ||
    filtered.state === "hasError" ||
    rows.state === "hasError" ? (
    <SshLoadError />
  ) : null;
}

function sshSummaryData(summary: Loadable<{ configuredCount: number } | null>) {
  return summary.state === "hasData" ? summary.data : null;
}

function buildConnectorPresentation(
  connectors: readonly PlatformConnectorCatalogStatusItem[],
  sshSummary: Loadable<{ configuredCount: number } | null>,
  sshLabel: string,
) {
  const items: ConnectorPresentation[] = connectors.map((connector) => {
    return {
      kind: "catalog",
      connector,
      category: connector.category,
      popularityRank: connector.popularityRank,
      label: connector.label,
      connected: connector.connected,
    };
  });
  const ssh = sshSummaryData(sshSummary);
  if (ssh) {
    items.push({
      kind: "ssh",
      category: REMOTE_ACCESS_CATEGORY,
      label: sshLabel,
      connected: ssh.configuredCount > 0,
      configuredCount: ssh.configuredCount,
    });
  }
  return {
    items,
    // A pending SSH read must not display the empty-catalog message.
    filteredCount: items.length + (sshSummary.state === "loading" ? 1 : 0),
  };
}

function SshShelfCategory({
  enabled,
  groups,
  renderCard,
}: {
  readonly enabled: boolean;
  readonly groups: ConnectorCategoryGroup<ConnectorPresentation>[];
  readonly renderCard: (item: ConnectorPresentation) => ReactNode;
}) {
  if (!enabled) {
    return null;
  }
  return groups
    .filter((group) => {
      return group.id === REMOTE_ACCESS_CATEGORY;
    })
    .map((group) => {
      return (
        <ConnectorCategoryGroupSection
          key={group.id}
          group={group}
          renderCard={renderCard}
        />
      );
    });
}

function useFilteredCatalogItems(directoryEnabled: boolean) {
  const previousFilteredCatalogItemsLoadable = useLastLoadable(
    filteredConnectorCatalogItems$,
  );
  const currentFilteredCatalogItemsLoadable = useLoadable(
    filteredConnectorCatalogItems$,
  );
  return directoryEnabled
    ? currentFilteredCatalogItemsLoadable
    : previousFilteredCatalogItemsLoadable;
}

function builtinListData(
  directoryEnabled: boolean,
  presentation: ReturnType<typeof buildConnectorPresentation>,
  grouped: ConnectorCategoryGroup<ConnectorPresentation>[],
  metadata: PublicConnectorCatalogCategoryMetadata | undefined,
  otherLabel: string,
) {
  if (!directoryEnabled) {
    return { grouped, filteredCount: presentation.filteredCount };
  }
  const items = presentation.items.filter((item) => {
    return item.kind === "catalog";
  });
  return {
    grouped: groupConnectorsByCategory(items, metadata, otherLabel),
    filteredCount: items.length,
  };
}

export function ConnectorsPage() {
  const { t } = useTranslation();
  const shelfEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ConnectorDirectory] === true;
  const relatedCatalogItemsLoadable = useLastLoadable(relatedCatalogItems$);
  const filteredCatalogItemsLoadable = useFilteredCatalogItems(shelfEnabled);
  const sshSummary = useLoadable(sshSummary$);
  const filteredSshSummary = useLoadable(filteredSshSummary$);
  const catalogStatusLoadable = useLastLoadable(connectorCatalogDiscovery$);
  const accountSummariesLoadable = useLoadable(
    connectorAccountSummaryByTarget$,
  );
  const accountSummaryStatus = connectorAccountSummaryStatus(
    accountSummariesLoadable.state,
  );
  const finishAccountConnection = useSet(finishConnectorAccountConnection$);
  const runConnectSuccess = useSet(runConnectorConnectSuccess$);
  const managedAccountConnector = useGet(builtinAccountManager$);
  const accountConnect = useGet(builtinAccountConnectDialog$);
  const openAccountManager = useSet(openBuiltinAccountManager$);
  const closeAccountManager = useSet(closeBuiltinAccountManager$);
  const openAccountConnect = useSet(openBuiltinAccountConnectDialog$);
  const closeAccountConnect = useSet(closeBuiltinAccountConnectDialog$);
  const pollingAuthCodeSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const pollingDeviceAuthSlug = useGet(pollingOAuthDeviceAuthConnectorSlug$);
  const connectFlowSlug = useGet(connectFlowConnectorSlug$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const signal = useGet(pageSignal$);
  const scopeReviewSelection = useGet(scopeReviewSelection$);
  const setScopeReviewSelection = useSet(setScopeReviewSelection$);
  const setManagedConnectorSlug = useSet(setManagedConnectorAccessSlug$);
  const activeTab = useGet(connectorsPageTab$);
  const setActiveTab = useSet(setConnectorsPageTab$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const openCreateCustom = useSet(openCustomConnectorCreateDialog$);
  const activeCategoryId = useGet(activeConnectorCategoryId$);
  const attachScrollTracking = useSet(attachConnectorCategoryScrollTracking$);
  const resetActiveCategory = useSet(resetActiveConnectorCategory$);
  const categoryTrackingEnabled =
    !shelfEnabled &&
    activeTab === "builtin" &&
    filteredCatalogItemsLoadable.state === "hasData";
  const scrollContainerRef = useScrollTrackingRef(
    categoryTrackingEnabled,
    attachScrollTracking,
    resetActiveCategory,
  );

  const search = useGet(connectorsSearch$);
  const setSearch = useSet(setConnectorsSearch$);
  const connectionFilter = useGet(connectorsConnectionFilter$);
  const setConnectionFilter = useSet(setConnectorsConnectionFilter$);
  const categoryFilter = useGet(connectorsCategoryFilter$);
  const setCategoryFilter = useSet(setConnectorsCategoryFilter$);
  const scope = useGet(connectorsScope$);
  const setScope = useSet(setConnectorsScope$);
  const scopeBadge = connectorsScopeBadge(
    useLastLoadable(connectedConnectorsBadge$),
  );
  const agentsLoadable = useLastLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];

  const filteredConnectors =
    filteredCatalogItemsLoadable.state === "hasData"
      ? filteredCatalogItemsLoadable.data
      : [];
  const connectorCatalogCount = effectiveConnectorCatalogCount(
    catalogStatusLoadable,
    sshSummary,
  );
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
  ): Promise<void> => {
    await runConnectSuccess(
      connector.slug,
      (completedConnectionId) => {
        return finishAccountConnection(
          {
            target: { kind: "builtin", connectorSlug: connector.slug },
            connectionId: completedConnectionId,
            connectorLabel: connector.label,
            mode: { kind: "add" },
          },
          signal,
        );
      },
      connectionId,
      signal,
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
        const result = await connect(
          connector.slug,
          authMethod,
          {
            account: { intent: "add" },
            authorizeVisibleAgents: true,
            connectorLabel: connector.label,
            connectorIcon: connector.icon,
          },
          signal,
        );
        if (result) {
          await finishExplicitAccountAdd(connector, result.connectionId);
        }
        return result;
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
          await finishExplicitAccountAdd(connector, result.connectionId);
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
  const presentation = buildConnectorPresentation(
    filteredConnectors,
    filteredSshSummary,
    t(($) => {
      return $.ssh.label;
    }),
  );
  const remoteAccessLabel = t(($) => {
    return $.connectors.catalog.remoteAccess;
  });
  const grouped = groupConnectorsByCategory(
    presentation.items,
    withRemoteAccessCategory(categoryMetadata, remoteAccessLabel),
    otherCategoryLabel,
  );
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
    ready: shelfEnabled && filteredCatalogItemsLoadable.state === "hasData",
    sshAvailable: Boolean(sshSummaryData(sshSummary)),
    remoteAccessLabel,
  });

  const renderPresentationCard = (item: ConnectorPresentation) => {
    return item.kind === "ssh" ? (
      <SshConnectorCard key="ssh" configuredCount={item.configuredCount} />
    ) : (
      renderCard(item.connector)
    );
  };
  const builtinList = renderBuiltinList({
    loadingState: filteredCatalogItemsLoadable.state,
    ...builtinListData(
      shelfEnabled,
      presentation,
      grouped,
      categoryMetadata,
      otherCategoryLabel,
    ),
    renderCard: renderPresentationCard,
    search,
    connectionFilter,
    suppressEmpty: shelfEnabled,
  });
  const builtinPanel = (
    <ConnectorsBuiltinPanel
      directoryEnabled={shelfEnabled}
      browse={browse}
      renderCard={renderCard}
      fallback={builtinList}
      remoteAccessPanel={
        <>
          <SshDirectoryLoadError />
          <SshShelfCategory
            enabled={browse.showShelves}
            groups={grouped}
            renderCard={renderPresentationCard}
          />
        </>
      }
    />
  );
  return (
    <div
      ref={scrollContainerRef}
      data-testid="connectors-scroll-viewport"
      className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]"
    >
      <ConnectorCatalogHeader connectorCatalogCount={connectorCatalogCount} />

      <main
        data-testid="connectors-scroll-content"
        className="flex-1 px-4 sm:px-6 pt-3 pb-[max(4rem,var(--sab))]"
      >
        <div className="relative mx-auto w-full max-w-[900px]">
          {!shelfEnabled &&
            activeTab === "builtin" &&
            filteredCatalogItemsLoadable.state === "hasData" && (
              <ConnectorCategoryMenu
                activeCategoryId={activeCategoryId}
                groups={grouped}
              />
            )}

          <div className="min-w-0 flex w-full max-w-[900px] flex-col gap-6">
            {shelfEnabled ? (
              <ConnectorsDirectoryToolbar
                scope={scope}
                setScope={setScope}
                badge={scopeBadge}
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
            ) : (
              <div className="flex items-center justify-between gap-3">
                <Tabs
                  value={activeTab}
                  onValueChange={(v) => {
                    return setActiveTab(v === "custom" ? "custom" : "builtin");
                  }}
                >
                  <TabsList>
                    <TabsTrigger value="builtin">
                      {t(($) => {
                        return $.connectors.catalog.tabs.builtin;
                      })}
                    </TabsTrigger>
                    <TabsTrigger value="custom">
                      {t(($) => {
                        return $.connectors.catalog.tabs.custom;
                      })}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <ConnectorsToolbarActions
                  activeTab={activeTab}
                  search={search}
                  setSearch={setSearch}
                  showAccessManagement
                  connectionFilter={connectionFilter}
                  agents={agents}
                  setConnectionFilter={setConnectionFilter}
                  isAdmin={isAdmin}
                  onCreateCustom={openCreateCustom}
                />
              </div>
            )}

            <ConnectorsPagePanels
              shelfEnabled={shelfEnabled}
              scope={scope}
              activeTab={activeTab}
              builtinPanel={builtinPanel}
              minePanel={
                <ConnectorsMinePanel
                  connected={browse.connected}
                  ready={browse.ready}
                  connectionFilter={connectionFilter}
                  renderCard={renderCard}
                />
              }
              directoryPanel={
                <ConnectorsDirectoryContent
                  builtin={builtinPanel}
                  builtinState={filteredCatalogItemsLoadable.state}
                  builtinCount={filteredConnectors.length}
                  remote={
                    <>
                      <SshDirectoryLoadError />
                      <SshShelfCategory
                        enabled
                        groups={grouped}
                        renderCard={renderPresentationCard}
                      />
                    </>
                  }
                  remoteState={filteredSshSummary.state}
                  remoteCount={Number(
                    Boolean(sshSummaryData(filteredSshSummary)),
                  )}
                />
              }
            />
          </div>
        </div>
      </main>

      <SshAccessManagementDialog />

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
          onSuccess={async (connectionId) => {
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
              signal,
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
          connectionActionsEnabled
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
