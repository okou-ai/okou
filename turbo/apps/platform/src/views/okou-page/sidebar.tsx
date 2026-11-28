import { ProjectCreateButton } from "../projects/project-row.tsx";
import { Collapsible } from "@base-ui/react/collapsible";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Package, Route, PanelLeftClose, Plug, Search } from "lucide-react";
import { BrandSlack, Button, ShortcutTooltipGroup, cn } from "@okouai/ui";
import {
  sidebarOff$,
  toggleSidebarOff$,
  handleAccountAction$,
} from "../../signals/okou-page/nav.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { ROUTES, type RouteKey } from "../../signals/route-paths.ts";
import { assistantName$ } from "../../signals/branding.ts";
import {
  openThreeColumnSearchDialog$,
  setThreeColumnSearchOpen$,
  threeColumnSearchOpen$,
} from "../../signals/okou-page/sidebar-state.ts";
import { OrgSwitcherCompact } from "./org-switcher.tsx";
import { OkouLogomark } from "../components/okou-logomark.tsx";
import { Link } from "../router/link.tsx";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { showChatThreadInbox$ } from "../../signals/okou-page/chat-thread-filter-selection.ts";
import { slackOrgScopeMismatch$ } from "../../signals/okou-page/slack.ts";
import { AccountDropdown } from "./sidebar-account.tsx";
import {
  ChatThreadDialogs,
  ChatThreadsListMenu,
  ChatThreadsSection,
  useChatThreadsFilterLabel,
} from "./sidebar-threads.tsx";
import { threeColumnSidebarChatThreadScrollSignals } from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";

import { ThreeColumnSearchDialog } from "./sidebar-dialogs.tsx";
import { SidebarUpgradeCard } from "./sidebar-upgrade.tsx";
import { ResizeSeam } from "./resize-seam.tsx";
import {
  CHAT_LIST_MAX_WIDTH,
  CHAT_LIST_MIN_WIDTH,
  chatListResizeHandleRef$,
  chatListResizing$,
  chatListWidth$,
} from "../../signals/okou-page/unified-chat-workspace.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { workspaceResizing$ } from "../../signals/chat-page/workspace-resize.ts";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;

type ManageNavId = "artifacts" | "connectors" | "workflows";
type SidebarNavId = ManageNavId | "chat" | "works";

interface ManageNavItem {
  readonly id: ManageNavId;
  readonly activeKeys: readonly RouteKey[];
  readonly pathname: string;
  readonly icon: NavIcon;
}

const MANAGE_NAV: readonly ManageNavItem[] = [
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
    activeKeys: ["connectors"],
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
}

const FOOTER_NAV: readonly FooterNavItem[] = [
  {
    id: "works",
    activeKeys: ["works"],
    pathname: "/works",
    icon: BrandSlack as NavIcon,
  },
];

// Shared subscription hooks. Each sibling component pulls its own state from
// signals via these instead of receiving anything from a parent through props.

function useManageNavItems() {
  const { t } = useTranslation();

  const manageLabel = (id: ManageNavId): string => {
    switch (id) {
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
  return MANAGE_NAV.map((item) => {
    return { ...item, label: manageLabel(item.id) };
  });
}

function useFooterNavItems() {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  return FOOTER_NAV.map((item) => {
    return {
      ...item,
      label: t(
        ($) => {
          return $.appShell.sidebar.navigation.works;
        },
        { assistantName },
      ),
    };
  });
}

// Wraps AccountDropdown with the handler subscription so siblings don't have
// to thread onAccountAction through props.
function AccountDropdownContainer() {
  const onAccountAction = useSet(handleAccountAction$);
  return (
    <AccountDropdown
      onAccountAction={onAccountAction}
      showSubscriptionEntry
      showKeyboardShortcuts
    />
  );
}

// --- Three-column (Slack-style) layout ---

/* Everything in the rail is a 36px square, so centring it in the 72px column
   leaves 18px down either side. The vertical padding matches that, which is
   what puts the workspace logo and the account mark the same distance from
   the corner they sit in as from the edge beside them. */
const RAIL_FRAME =
  "hidden md:flex h-full w-[72px] shrink-0 flex-col items-center py-[18px]";

function LabeledRailLink({
  id,
  navPath,
  label,
  icon: Icon,
  isActive,
  showBadge,
  onNavigate,
}: {
  id: SidebarNavId;
  navPath: string;
  label: string;
  icon: NavIcon;
  isActive: boolean;
  showBadge?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const caption = (() => {
    switch (id) {
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
      onClick={(event) => {
        // Only a click that navigates here, not one opening a new tab.
        if (onNavigate && shouldHandleLinkClick(event)) {
          onNavigate();
        }
      }}
      aria-label={label}
      aria-current={isActive ? "page" : undefined}
      className="group flex w-full shrink-0 scroll-my-1 flex-col items-center gap-0.5 rounded-lg no-underline outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={`relative inline-flex size-9 items-center justify-center rounded-lg transition-colors duration-200 ${
          isActive
            ? "bg-state-selected text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-state-hover group-hover:bg-state-hover"
        }`}
      >
        <Icon size={19} className="shrink-0 opacity-70" />
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
  size = "icon-sm",
  ...props
}: ComponentProps<typeof Button> & {
  hidden: boolean;
}) {
  const onToggle = useSet(toggleSidebarOff$);

  return (
    <Button
      {...props}
      type="button"
      onClick={() => {
        onToggle();
      }}
      aria-keyshortcuts={
        GLOBAL_KEYBOARD_SHORTCUTS.toggleChatList.ariaKeyShortcuts
      }
      variant="quiet"
      size={size}
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

/** Sized to the visible glyph of the rail's 19px stroke icons. */
function OkouRailIcon({ className }: { className?: string }) {
  return <OkouLogomark className={cn("size-4", className)} />;
}

function LabeledChatRailLink() {
  const activeId = useGet(activeRoute$);

  const assistantName = useGet(assistantName$);
  const showInbox = useSet(showChatThreadInbox$);
  return (
    <LabeledRailLink
      id="chat"
      navPath={ROUTES.home}
      label={assistantName}
      icon={OkouRailIcon}
      isActive={
        activeId === "home" || activeId === "chat" || activeId === "project"
      }
      showBadge={false}
      onNavigate={showInbox}
    />
  );
}

function LabeledManageRailLinks() {
  const activeId = useGet(activeRoute$);
  const manageNav = useManageNavItems();
  return manageNav.map((item) => {
    return (
      <LabeledRailLink
        key={item.id}
        id={item.id}
        navPath={item.pathname}
        label={item.label}
        icon={item.icon}
        isActive={activeId !== null && item.activeKeys.includes(activeId)}
        showBadge={false}
      />
    );
  });
}

function LabeledFooterRailLinks() {
  const activeId = useGet(activeRoute$);
  const footerNav = useFooterNavItems();
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$) ?? false;
  return footerNav.map((item) => {
    return (
      <LabeledRailLink
        key={item.id}
        id={item.id}
        navPath={item.pathname}
        label={item.label}
        icon={item.icon}
        isActive={activeId !== null && item.activeKeys.includes(activeId)}
        showBadge={slackScopeMismatch}
      />
    );
  });
}

function LabeledNavRail() {
  // Each link group owns its navigation inputs. Workspace/account menus keep
  // their element identity when only a destination, label or badge changes.
  return (
    <LabeledNavRailFrame
      workspaceSwitcher={<OrgSwitcherCompact />}
      accountMenu={<AccountDropdownContainer />}
    />
  );
}

function LabeledNavRailFrame({
  workspaceSwitcher,
  accountMenu,
}: {
  readonly workspaceSwitcher: ReactNode;
  readonly accountMenu: ReactNode;
}) {
  const chatListHidden = useGet(sidebarOff$);
  const { t } = useTranslation();
  return (
    <aside
      data-testid="labeled-nav-rail"
      // The rail is part of the page ground the sheet floats on, so it takes
      // no fill or edge of its own.
      className={RAIL_FRAME}
    >
      <div className="mb-3 shrink-0">{workspaceSwitcher}</div>
      {chatListHidden && (
        <div className="mb-3 shrink-0">
          <ShortcutTooltipGroup
            side="right"
            items={[
              {
                shortcut: GLOBAL_KEYBOARD_SHORTCUTS.toggleChatList.binding,
                // Match the rail's 36px nav chips, not the header's 32px.
                trigger: (
                  <ThreeColumnChatListToggle
                    hidden
                    size="icon"
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
      {/* Keep focus-ring clearance inside the scrollport. The top margin
          preserves the first item's position while adding room for its ring. */}
      <nav
        aria-label={t(($) => {
          return $.appShell.sidebar.ariaLabel;
        })}
        className="-mt-1 flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto px-1.5 pb-2 pt-1"
      >
        <LabeledChatRailLink />
        <LabeledManageRailLinks />
        <LabeledFooterRailLinks />
      </nav>
      <div className="flex w-full shrink-0 flex-col items-center gap-2 px-1.5 pt-1">
        {accountMenu}
      </div>
    </aside>
  );
}

export function ThreeColumnSearchDialogContainer() {
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
    />
  );
}

const CHAT_LIST_INSET = "px-3";

function ChatListHeader() {
  const openThreeColumnSearch = useSet(openThreeColumnSearchDialog$);
  const { t } = useTranslation();
  // My Okou has a single chat list, so the header carries the list's actions
  // instead of a title, and New chat leads the list itself. An active filter
  // still names itself beside the toggle so a filtered list never looks like
  // the inbox.
  const filterLabel = useChatThreadsFilterLabel();
  const searchLabel = t(($) => {
    return $.appShell.sidebar.searchWorkspace;
  });
  const searchItem = {
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
  };
  const toggleItem = {
    shortcut: GLOBAL_KEYBOARD_SHORTCUTS.toggleChatList.binding,
    trigger: (
      <ThreeColumnChatListToggle
        hidden={false}
        aria-label={t(($) => {
          return $.appShell.sidebar.hideChatList;
        })}
      />
    ),
  };
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 pb-2 pt-3",
        CHAT_LIST_INSET,
      )}
    >
      <>
        <ShortcutTooltipGroup items={[toggleItem]} />
        <span className="min-w-0 flex-1 truncate pl-1 text-[15px] font-semibold text-nav-copy">
          {filterLabel}
        </span>
        <ShortcutTooltipGroup items={[searchItem]} />
        <ProjectCreateButton />
        <ChatThreadsListMenu showMarkAllRead />
      </>
    </div>
  );
}

function ChatListResizeSeam() {
  const { t } = useTranslation();
  const width = useGet(chatListWidth$);
  const resizing = useGet(chatListResizing$);
  const ref = useSet(chatListResizeHandleRef$);
  const hidden = useGet(sidebarOff$);
  return (
    <ResizeSeam
      ref={ref}
      label={t(($) => {
        return $.appShell.sidebar.resizeChatList;
      })}
      valueMin={hidden ? 0 : CHAT_LIST_MIN_WIDTH}
      valueMax={CHAT_LIST_MAX_WIDTH}
      valueNow={hidden ? 0 : width}
      resizing={resizing}
      // In flow between the list and the workspace, the divider's own hairline
      // is the line. Its 12px target reaches into the later workspace, so it
      // paints one step above it; shared modal/menu portals still paint above
      // the shell. Collapsed, it drops its hairline so the workspace meets the
      // sheet's own edge, which is then the line, and the list can only grow.
      // It then spans only that edge's straight run: inset by the sheet's
      // corner radius at both ends, its line and target stop where the
      // corners begin to curve.
      className="z-1 border-l border-border group-data-[chat-list=collapsed]/workspace-sheet:my-(--radius-2xl) group-data-[chat-list=collapsed]/workspace-sheet:cursor-e-resize group-data-[chat-list=collapsed]/workspace-sheet:border-l-0"
    />
  );
}

function ChatListColumn() {
  const width = useGet(chatListWidth$);
  return (
    <aside
      data-testid="chat-list-column"
      className={cn(
        "hidden md:flex shrink-0 flex-col",
        // The list is the leading part of the workspace sheet, which owns the
        // frame. It sits half a step toward the ground, so it reads below the
        // content without leaving the sheet.
        "relative rounded-l-2xl bg-workspace-canvas-recessed",
      )}
      style={{ width }}
    >
      <ChatListHeader />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-1">
        <ChatThreadsSection
          scrollSignals={threeColumnSidebarChatThreadScrollSignals}
          contentClassName={CHAT_LIST_INSET}
          showMarkAllRead
          showTitle={false}
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

/** The chat list and its divider: the leading part of the workspace sheet. */
export function ChatListPane() {
  const hidden = useGet(sidebarOff$);
  const width = useGet(chatListWidth$);
  const resizing = useGet(workspaceResizing$);
  return (
    <Collapsible.Root open={!hidden} className="hidden shrink-0 md:flex">
      <Collapsible.Panel
        render={(props, state) => {
          return (
            <div
              {...props}
              data-sidebar-layout-owner="chat-list"
              data-sidebar-layout-resizing={resizing ? "true" : undefined}
              data-sidebar-layout-starting={
                state.transitionStatus === "starting" ? "" : undefined
              }
            />
          );
        }}
        inert={hidden}
        className={cn(
          "flex overflow-hidden w-[var(--chat-list-width)] data-[starting-style]:w-0 data-[ending-style]:w-0",
          resizing
            ? "transition-none"
            : "motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out",
        )}
        style={
          {
            "--chat-list-width": `${String(width)}px`,
          } as CSSProperties
        }
      >
        <ChatListColumn />
      </Collapsible.Panel>
      <ChatListResizeSeam />
    </Collapsible.Root>
  );
}

/** The nav rail and the dialogs it opens; the chat list lives in the sheet. */
export function Sidebar() {
  return (
    <>
      <LabeledNavRail />
      <ThreeColumnSearchDialogContainer />

      <ChatThreadDialogs />
    </>
  );
}
