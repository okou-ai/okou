import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import type { ComponentProps, ReactNode } from "react";
import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  LayoutGrid,
  Package,
  Route,
  Users,
  Edit,
  MessageCircle,
  ChevronRight,
  PanelLeftClose,
  Plug,
  Search,
} from "lucide-react";
import {
  Button,
  ShortcutTooltipGroup,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  sidebarOff$,
  toggleSidebarOff$,
  sidebarExpanded$,
  setSidebarExpanded$,
  handleNavSelect$,
  handleAccountAction$,
  type SidebarNavId,
} from "../../signals/okou-page/nav.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { ROUTES, type RouteKey } from "../../signals/route-paths.ts";
import { defaultAgentId$, defaultAgentName$ } from "../../signals/agent.ts";
import { assistantName$ } from "../../signals/branding.ts";
import {
  manageSectionCollapsed$,
  setManageSectionCollapsed$,
  openThreeColumnSearchDialog$,
  setThreeColumnSearchOpen$,
  threeColumnSearchOpen$,
} from "../../signals/okou-page/sidebar-state.ts";
import { OrgSwitcher, OrgSwitcherCompact } from "./org-switcher.tsx";
import { Link } from "../router/link.tsx";
import { slackOrgScopeMismatch$ } from "../../signals/okou-page/slack.ts";
import { AccountDropdown } from "./sidebar-account.tsx";
import { ChatThreadDialogs, ChatThreadsSection } from "./sidebar-threads.tsx";
import {
  responsiveSidebarChatThreadScrollSignals,
  threeColumnSidebarChatThreadScrollSignals,
} from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import {
  PinAgentDialogContainer,
  PinnedAgentListSection,
} from "./sidebar-pinned.tsx";
import { ThreeColumnSearchDialog } from "./sidebar-dialogs.tsx";
import { SidebarUpgradeCard } from "./sidebar-upgrade.tsx";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { InstatusStatusNotice } from "../components/instatus-status-notice.tsx";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;

const slackIcon = settingsIconAssetUrl("slack");

type ManageNavId = "agents" | "artifacts" | "connectors" | "workflows";

interface ManageNavItem {
  readonly id: ManageNavId;
  readonly activeKeys: readonly RouteKey[];
  readonly pathname: string;
  readonly icon: NavIcon;
}

const MANAGE_NAV: readonly ManageNavItem[] = [
  {
    id: "agents",
    activeKeys: ["agents", "agentDetail", "agentPermissions"],
    pathname: "/agents",
    icon: Users as NavIcon,
  },
  {
    id: "workflows",
    activeKeys: [
      "workflows",
      "workflowDetail",
      "workflowDetailAutomations",
      "workflowDetailInstructions",
      "workflowDetailInfo",
    ],
    pathname: "/workflows",
    icon: Route as NavIcon,
  },
  {
    id: "connectors",
    activeKeys: ["connectors", "connectorSsh"],
    pathname: "/connectors",
    icon: Plug as NavIcon,
  },
  {
    id: "artifacts",
    activeKeys: ["artifacts"],
    pathname: "/artifacts",
    icon: Package as NavIcon,
  },
];

interface FooterNavItem {
  readonly id: "works";
  readonly activeKeys: readonly RouteKey[];
  readonly pathname: string;
  readonly icon: NavIcon;
  readonly iconImg: string | undefined;
}

const FOOTER_NAV = [
  {
    id: "works",
    activeKeys: ["works"],
    pathname: "/works",
    icon: LayoutGrid as NavIcon,
    iconImg: slackIcon,
  },
] as const satisfies readonly FooterNavItem[];

// Shared subscription hooks. Each sibling component pulls its own state from
// signals via these instead of receiving anything from a parent through props.

function useResolvedNavItems() {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const defaultDisplayName =
    useLastResolved(defaultAgentName$) ?? assistantName;
  const manageLabel = (id: ManageNavId): string => {
    switch (id) {
      case "agents": {
        return t(($) => {
          return $.appShell.sidebar.navigation.agents;
        });
      }
      case "artifacts": {
        return t(($) => {
          return $.appShell.sidebar.navigation.artifacts;
        });
      }
      case "connectors": {
        return t(($) => {
          return $.appShell.sidebar.navigation.connectors;
        });
      }
      case "workflows": {
        return t(($) => {
          return $.appShell.sidebar.navigation.workflows;
        });
      }
    }
  };
  const manageNav = MANAGE_NAV.map((item) => {
    return { ...item, label: manageLabel(item.id) };
  });
  const footerNav = FOOTER_NAV.map((item) => {
    return {
      ...item,
      label: t(
        ($) => {
          return $.appShell.sidebar.navigation.works;
        },
        { agentName: defaultDisplayName },
      ),
    };
  });
  return { manageNav, footerNav };
}

function useNavSelect() {
  const rawOnSelect = useSet(handleNavSelect$);
  const setExpanded = useSet(setSidebarExpanded$);
  return (id: SidebarNavId) => {
    rawOnSelect(id);
    setExpanded(false);
  };
}

function useSidebarCollapseToggle() {
  const toggleOff = useSet(toggleSidebarOff$);
  const setExpanded = useSet(setSidebarExpanded$);
  return () => {
    setExpanded(false);
    toggleOff();
  };
}

// Wraps AccountDropdown with the handler subscription so siblings don't have
// to thread onAccountAction through props.
function AccountDropdownContainer({
  collapsed = false,
  renderCodexResetDialog = true,
}: {
  collapsed?: boolean;
  renderCodexResetDialog?: boolean;
}) {
  const onAccountAction = useSet(handleAccountAction$);
  return (
    <AccountDropdown
      onAccountAction={onAccountAction}
      collapsed={collapsed}
      renderCodexResetDialog={renderCodexResetDialog}
    />
  );
}

// --- Expanded mobile drawer ---

function ExpandedSidebar() {
  const expanded = useGet(sidebarExpanded$);
  const { t } = useTranslation();
  return (
    <aside
      data-sidebar-expanded={expanded || undefined}
      aria-label={t(($) => {
        return $.appShell.sidebar.ariaLabel;
      })}
      className={cn(
        "okou-nav okou-mobile-sidebar okou-mobile-fixed-safe-area h-full w-[300px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:h-auto max-md:shadow-xl",
        "hidden data-[sidebar-expanded]:max-md:flex md:hidden",
      )}
    >
      <ExpandedHeader />
      <ExpandedMainNav />
      <InstatusStatusNotice placement="sidebar" />
      <ExpandedUpgradeSection />
      <ExpandedFooter />
    </aside>
  );
}

function ExpandedHeader() {
  const onCollapse = useSidebarCollapseToggle();
  const { t } = useTranslation();
  const collapseLabel = t(($) => {
    return $.appShell.sidebar.collapse;
  });
  return (
    <div className="okou-sidebar-header shrink-0 px-2 pb-0">
      <div className="okou-desktop-titlebar-drag-region" aria-hidden="true" />
      <div className="okou-desktop-no-drag flex items-center justify-between gap-2 rounded-lg py-0.5">
        <div className="min-w-0 flex-1">
          <OrgSwitcher />
        </div>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="quiet"
                size="icon-sm"
                iconSize="md"
                className="shrink-0"
                onClick={onCollapse}
                aria-label={collapseLabel}
              >
                <PanelLeftClose className="opacity-50" size={18} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{collapseLabel}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

function ExpandedMainNav() {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t(($) => {
        return $.appShell.sidebar.ariaLabel;
      })}
      className="flex-1 flex flex-col min-h-0 overflow-hidden px-2 pt-1"
    >
      <ExpandedManageSection />
      <ExpandedSidebarSections />
    </nav>
  );
}

function ExpandedManageSection() {
  const activeId = useGet(activeRoute$);
  const onSelect = useNavSelect();
  const { manageNav } = useResolvedNavItems();
  const manageCollapsed = useGet(manageSectionCollapsed$);
  const setManageCollapsed = useSet(setManageSectionCollapsed$);
  const { t } = useTranslation();
  return (
    <div className="shrink-0">
      <div
        className="group flex h-8 shrink-0 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-state-hover transition-colors"
        onClick={() => {
          return setManageCollapsed(!manageCollapsed);
        }}
      >
        <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-[color:var(--nav-copy-muted,color-mix(in_oklab,var(--color-sidebar-foreground)_50%,transparent))] group-hover:text-nav-copy transition-colors">
          {t(($) => {
            return $.appShell.sidebar.manage;
          })}
          <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <ChevronRight
              className={`opacity-35 ${manageCollapsed ? "" : "rotate-90"}`}
              size={12}
            />
          </span>
        </span>
      </div>
      {!manageCollapsed && (
        <div className="flex flex-col gap-1">
          {manageNav.map(
            ({ id, activeKeys, pathname: navPath, label, icon: Icon }) => {
              const isActive =
                activeId !== null &&
                (activeKeys as readonly RouteKey[]).includes(activeId);
              return (
                <Link
                  key={id}
                  pathname={navPath as Parameters<typeof Link>[0]["pathname"]}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) {
                      return;
                    }
                    e.preventDefault();
                    onSelect(id);
                  }}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                    isActive
                      ? "bg-state-selected text-sidebar-foreground font-medium"
                      : "text-sidebar-foreground hover:bg-state-hover"
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="text-[color:var(--nav-copy,inherit)] truncate">
                    {label}
                  </span>
                </Link>
              );
            },
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedSidebarSections() {
  return (
    <div className="flex-1 min-h-0 -mx-2 mt-2 pt-2 flex flex-col overflow-hidden">
      <div className="px-2">
        <PinnedAgentListSection />
      </div>
      <ChatThreadsSection
        scrollSignals={responsiveSidebarChatThreadScrollSignals}
        contentClassName="px-2"
        showMarkAllRead
      />
    </div>
  );
}

function ExpandedUpgradeSection() {
  // The nav above has no bottom padding, so the card carries its own top gap.
  // Collapses to nothing when SidebarUpgradeCard renders null.
  return (
    <div className="px-2 pt-2 empty:hidden">
      <SidebarUpgradeCard />
    </div>
  );
}

function ExpandedFooter() {
  const activeId = useGet(activeRoute$);
  const onSelect = useNavSelect();
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$) ?? false;
  const { footerNav } = useResolvedNavItems();
  return (
    <div className="p-2">
      <div className="flex flex-col gap-1">
        {footerNav.map(
          ({
            id,
            activeKeys,
            pathname: navPath,
            label,
            icon: Icon,
            iconImg,
          }) => {
            const isActive =
              activeId !== null &&
              (activeKeys as readonly RouteKey[]).includes(activeId);
            return (
              <Link
                key={id}
                pathname={navPath as Parameters<typeof Link>[0]["pathname"]}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) {
                    return;
                  }
                  e.preventDefault();
                  onSelect(id);
                }}
                className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                  isActive
                    ? "bg-state-selected text-sidebar-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-state-hover"
                }`}
              >
                {iconImg ? (
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden">
                    <img
                      src={iconImg}
                      alt=""
                      className="h-3.5 w-3.5 scale-[2.2]"
                      width={14}
                      height={14}
                    />
                  </span>
                ) : (
                  <Icon size={16} className="shrink-0" />
                )}
                <span className="text-[color:var(--nav-copy,inherit)] flex-1 truncate">
                  {label}
                </span>
                {id === "works" && slackScopeMismatch && (
                  <span
                    data-testid="slack-scope-mismatch-indicator"
                    className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                  />
                )}
              </Link>
            );
          },
        )}
        <div className="h-px bg-divider/30 mx-1 my-1" />
        {/* The always-mounted rail owns the shared reset dialog controller. */}
        <AccountDropdownContainer renderCodexResetDialog={false} />
      </div>
    </div>
  );
}

// --- Three-column (Slack-style) layout ---

/* Everything in the rail is a 36px square, so centring it in the 72px column
   leaves 18px down either side. The vertical padding matches that, which is
   what puts the workspace logo and the account mark the same distance from
   the corner they sit in as from the edge beside them. */
const RAIL_FRAME =
  "okou-nav okou-nav-rail hidden md:flex h-full w-[72px] shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar-rail px-1.5 py-[18px]";

function LabeledRailLink({
  id,
  navPath,
  navOptions,
  label,
  icon: Icon,
  iconImg,
  isActive,
  showBadge,
  onSelect,
}: {
  id: SidebarNavId;
  navPath: string;
  navOptions?: Parameters<typeof Link>[0]["options"];
  label: string;
  icon: NavIcon;
  iconImg?: string | undefined;
  isActive: boolean;
  showBadge?: boolean;
  onSelect: (id: SidebarNavId) => void;
}) {
  const { t } = useTranslation();
  const caption = (() => {
    switch (id) {
      case "chat": {
        return t(($) => {
          return $.appShell.sidebar.chat;
        });
      }
      case "workflows": {
        return t(($) => {
          return $.appShell.sidebar.rail.workflows;
        });
      }
      case "works": {
        return t(($) => {
          return $.appShell.sidebar.rail.works;
        });
      }
      default: {
        return label;
      }
    }
  })();
  return (
    <Link
      pathname={navPath as Parameters<typeof Link>[0]["pathname"]}
      options={navOptions}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          return;
        }
        e.preventDefault();
        onSelect(id);
      }}
      aria-label={label}
      aria-current={isActive ? "page" : undefined}
      title={caption}
      className="group flex w-full flex-col items-center gap-0.5 no-underline"
    >
      <span
        className={`relative inline-flex size-9 items-center justify-center rounded-lg transition-colors duration-200 ${
          isActive
            ? "bg-state-selected text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-state-hover group-hover:bg-state-hover"
        }`}
      >
        {iconImg ? (
          <span className="inline-flex h-4 w-4 items-center justify-center overflow-hidden">
            <img
              src={iconImg}
              alt=""
              className="h-4 w-4 scale-[2.2]"
              width={16}
              height={16}
            />
          </span>
        ) : (
          <Icon size={19} className="shrink-0 opacity-70" />
        )}
        {showBadge && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500" />
        )}
      </span>
      <span
        className={`max-w-full truncate px-0.5 text-[10px] font-medium leading-[14px] ${
          isActive
            ? "text-nav-copy"
            : "text-[color:var(--nav-copy-muted,color-mix(in_oklab,var(--color-sidebar-foreground)_70%,transparent))]"
        }`}
      >
        {caption}
      </span>
    </Link>
  );
}

function ThreeColumnChatListToggle({
  hidden,
  ...props
}: ComponentProps<typeof Button> & {
  hidden: boolean;
}) {
  const onToggle = useSidebarCollapseToggle();

  return (
    <Button
      {...props}
      type="button"
      onClick={onToggle}
      aria-keyshortcuts={
        GLOBAL_KEYBOARD_SHORTCUTS.toggleChatList.ariaKeyShortcuts
      }
      variant="quiet"
      size="icon-sm"
      iconSize="md"
    >
      <PanelLeftClose
        size={18}
        className={cn(
          "transition-transform duration-200",
          hidden && "rotate-180",
        )}
      />
    </Button>
  );
}

function LabeledNavRail() {
  const chatListHidden = useGet(sidebarOff$);
  const activeId = useGet(activeRoute$);
  const defaultAgentId = useLastResolved(defaultAgentId$) ?? null;
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$) ?? false;
  const onNavSelect = useNavSelect();
  const navigate = useSet(detachedNavigateTo$);
  const { manageNav, footerNav } = useResolvedNavItems();
  const { t } = useTranslation();
  const navItems: {
    id: SidebarNavId;
    activeKeys: readonly RouteKey[];
    pathname: string;
    options?: Parameters<typeof Link>[0]["options"];
    label: string;
    icon: NavIcon;
    iconImg?: string | undefined;
  }[] = [
    {
      id: "chat",
      activeKeys: ["home", "agentChat", "agentIdeas", "chat"],
      pathname: defaultAgentId ? ROUTES.agentChat : ROUTES.home,
      options: defaultAgentId
        ? { pathParams: { agentId: defaultAgentId } }
        : undefined,
      label: t(($) => {
        return $.appShell.sidebar.chat;
      }),
      icon: MessageCircle as NavIcon,
    },
    ...manageNav,
    ...footerNav,
  ];
  const onSelect = (id: SidebarNavId) => {
    if (id === "chat") {
      if (!defaultAgentId) {
        return;
      }
      navigate(ROUTES.agentChat, {
        pathParams: { agentId: defaultAgentId },
      });
      return;
    }
    onNavSelect(id);
  };
  return (
    <aside data-testid="labeled-nav-rail" className={RAIL_FRAME}>
      <div className="okou-desktop-titlebar-drag-region" aria-hidden="true" />
      <div className="mb-3 shrink-0">
        <OrgSwitcherCompact />
      </div>
      {chatListHidden && (
        <div className="mb-3 shrink-0">
          <ShortcutTooltipGroup
            side="right"
            items={[
              {
                shortcut: GLOBAL_KEYBOARD_SHORTCUTS.toggleChatList.binding,
                trigger: (
                  <ThreeColumnChatListToggle
                    hidden
                    aria-label={t(($) => {
                      return $.appShell.sidebar.showChatList;
                    })}
                  />
                ),
              },
            ]}
          />
        </div>
      )}
      <nav
        aria-label={t(($) => {
          return $.appShell.sidebar.ariaLabel;
        })}
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto pb-2"
      >
        {navItems.map((item) => {
          const isActive =
            activeId !== null && item.activeKeys.includes(activeId);
          return (
            <LabeledRailLink
              key={item.id}
              id={item.id}
              navPath={item.pathname}
              navOptions={item.options}
              label={item.label}
              icon={item.icon}
              iconImg={item.iconImg}
              isActive={isActive}
              showBadge={item.id === "works" && slackScopeMismatch}
              onSelect={onSelect}
            />
          );
        })}
      </nav>
      <div className="flex w-full shrink-0 flex-col items-center gap-2 pt-1">
        <AccountDropdownContainer collapsed />
      </div>
    </aside>
  );
}

function ThreeColumnSearchDialogContainer() {
  const open = useGet(threeColumnSearchOpen$);
  const onOpenChange = useSet(setThreeColumnSearchOpen$);
  const navigate = useSet(detachedNavigateTo$);

  if (!open) {
    return null;
  }

  return (
    <ThreeColumnSearchDialog
      open
      onOpenChange={onOpenChange}
      onSelectChatThread={(threadId) => {
        navigate("/chats/:threadId", {
          pathParams: { threadId },
        });
      }}
      onSelectAgent={(agentId) => {
        navigate("/agents/:agentId/chat", {
          pathParams: { agentId },
        });
      }}
      onSelectWorkflow={(workflowId) => {
        navigate("/workflows/:workflowId", {
          pathParams: { workflowId },
        });
      }}
      onSelectArtifact={(artifact) => {
        const searchParams = new URLSearchParams({
          artifact: artifact.id,
        });
        if (artifact.kind !== "presentation") {
          searchParams.set("tab", artifact.kind);
        }
        navigate("/artifacts", { searchParams });
      }}
    />
  );
}

const CHAT_LIST_INSET = "px-3";

function ChatListColumn() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$) ?? null;
  const navigate = useSet(detachedNavigateTo$);
  const openThreeColumnSearch = useSet(openThreeColumnSearchDialog$);
  const { t } = useTranslation();
  const searchLabel = t(($) => {
    return $.appShell.sidebar.searchWorkspace;
  });
  const newChatLabel = t(($) => {
    return $.chat.newChat;
  });
  const onNewChat = () => {
    if (!currentChatAgentId) {
      return;
    }
    navigate(ROUTES.agentChat, {
      pathParams: { agentId: currentChatAgentId },
    });
  };
  return (
    <aside
      data-testid="chat-list-column"
      className="okou-nav hidden md:flex h-full w-[300px] shrink-0 flex-col bg-sidebar"
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 pb-2 pt-3",
          CHAT_LIST_INSET,
        )}
      >
        <span className="flex-1 pl-2 text-[15px] font-semibold text-nav-copy">
          {t(($) => {
            return $.appShell.sidebar.chat;
          })}
        </span>
        <ShortcutTooltipGroup
          items={[
            {
              shortcut: GLOBAL_KEYBOARD_SHORTCUTS.searchWorkspace.binding,
              trigger: (
                <Button
                  type="button"
                  onClick={() => {
                    openThreeColumnSearch();
                  }}
                  aria-label={searchLabel}
                  aria-keyshortcuts={
                    GLOBAL_KEYBOARD_SHORTCUTS.searchWorkspace.ariaKeyShortcuts
                  }
                  variant="quiet"
                  size="icon-sm"
                  iconSize="md"
                >
                  <Search size={18} />
                </Button>
              ),
            },
            {
              shortcut: GLOBAL_KEYBOARD_SHORTCUTS.newChat.binding,
              trigger: (
                <Button
                  type="button"
                  onClick={onNewChat}
                  disabled={!currentChatAgentId}
                  aria-label={newChatLabel}
                  aria-keyshortcuts={
                    GLOBAL_KEYBOARD_SHORTCUTS.newChat.ariaKeyShortcuts
                  }
                  variant="quiet"
                  size="icon-sm"
                  iconSize="md"
                >
                  <Edit size={18} />
                </Button>
              ),
            },
            {
              shortcut: GLOBAL_KEYBOARD_SHORTCUTS.toggleChatList.binding,
              trigger: (
                <ThreeColumnChatListToggle
                  hidden={false}
                  aria-label={t(($) => {
                    return $.appShell.sidebar.hideChatList;
                  })}
                />
              ),
            },
          ]}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-1">
        <div className={CHAT_LIST_INSET}>
          <PinnedAgentListSection layout="horizontal" />
        </div>
        <ChatThreadsSection
          scrollSignals={threeColumnSidebarChatThreadScrollSignals}
          contentClassName={CHAT_LIST_INSET}
          showMarkAllRead
        />
      </div>
      {/* Collapses to nothing when SidebarUpgradeCard renders null, so the
          thread list reaches the column bottom instead of clipping its last
          row above a reserved strip. */}
      <div className={cn("pb-3 empty:hidden", CHAT_LIST_INSET)}>
        <SidebarUpgradeCard />
      </div>
    </aside>
  );
}

function ThreeColumnNav() {
  const chatListHidden = useGet(sidebarOff$);
  return withChatScrollLayout(
    <>
      <LabeledNavRail />
      {!chatListHidden && <ChatListColumn />}
    </>,
  );
}

export function Sidebar({ isDesktop }: { isDesktop: boolean }) {
  return (
    <>
      {isDesktop ? <ThreeColumnNav /> : <ExpandedSidebar />}
      <ThreeColumnSearchDialogContainer />
      <PinAgentDialogContainer />
      <ChatThreadDialogs />
    </>
  );
}
