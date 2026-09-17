import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  ContextMenu,
  ContextMenuTrigger,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

export interface AgentRowMenuAction {
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
}

export function AgentUnreadIndicator() {
  const { t } = useTranslation("agents");

  return (
    <span
      role="img"
      aria-label={t(($) => {
        return $.status.unread;
      })}
      className="h-2 w-2 rounded-full bg-sky-600"
    />
  );
}

function useAgentRowMenuCopy() {
  const { t } = useTranslation("agents");
  return {
    more: t(($) => {
      return $.sidebar.more;
    }),
    openMenu: t(($) => {
      return $.sidebar.openMenu;
    }),
  };
}

function triggerClassName(
  variant: "dialog" | "sidebar",
  isPrimarySelected: boolean,
) {
  if (variant === "sidebar") {
    return `peer pointer-events-auto absolute left-1 top-1 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md group-hover:opacity-100! focus-visible:opacity-100! data-popup-open:opacity-100! data-popup-open:bg-state-selected-hover data-popup-open:text-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
      isPrimarySelected
        ? "text-sidebar-foreground/80 hover:text-foreground hover:bg-state-selected-hover"
        : "text-sidebar-foreground/80 hover:text-foreground hover:bg-state-selected-hover"
    }`;
  }

  return "peer absolute inset-0 z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 group-hover:opacity-100! focus-visible:opacity-100! data-popup-open:opacity-100! hover:bg-muted-foreground/12 hover:text-foreground data-popup-open:bg-muted-foreground/12 data-popup-open:text-foreground dark:hover:bg-muted-foreground/18 dark:data-popup-open:bg-muted-foreground/18 disabled:cursor-not-allowed disabled:opacity-50";
}

const triggerOpacityStyle = {
  opacity: "var(--agent-row-trigger-opacity)",
} as CSSProperties;

const unreadOpacityStyle = {
  opacity: "var(--agent-row-unread-opacity)",
} as CSSProperties;

const hiddenActionStyle = {
  "--agent-row-trigger-opacity": 0,
  "--agent-row-unread-opacity": 1,
} as CSSProperties;

const actionRootSelector = "[data-agent-row-actions-root]";

function setActionVisibility(element: HTMLElement, visible: boolean) {
  element.style.setProperty("--agent-row-trigger-opacity", visible ? "1" : "0");
  element.style.setProperty("--agent-row-unread-opacity", visible ? "0" : "1");
}

function actionRootFromElement(element: Element | null): HTMLElement | null {
  const root = element?.closest(actionRootSelector);
  return root instanceof HTMLElement ? root : null;
}

function showMenuActionForTrigger(trigger: Element) {
  const root = actionRootFromElement(trigger);
  if (!root) {
    return;
  }
  root.dataset.agentRowMenuOpen = "true";
  setActionVisibility(root, true);
}

function menuTriggerIsOpen(trigger: Element): boolean {
  if (!(trigger instanceof HTMLElement)) {
    return false;
  }
  return (
    Object.hasOwn(trigger.dataset, "popupOpen") ||
    trigger.ariaExpanded === "true"
  );
}

function syncMenuActionClosedAfterTriggerClick(trigger: Element) {
  const root = actionRootFromElement(trigger);
  if (!root) {
    return;
  }
  root.dataset.agentRowMenuOpen = "false";
  setActionVisibility(root, root.matches(":hover"));
  window.requestAnimationFrame(() => {
    root.dataset.agentRowMenuOpen = "false";
    setActionVisibility(root, root.matches(":hover"));
  });
}

function markTriggerOpenStateOnPointerDown(trigger: HTMLElement) {
  const wasOpen = menuTriggerIsOpen(trigger);
  trigger.dataset.agentRowTriggerWasOpen = wasOpen ? "true" : "false";
  if (!wasOpen) {
    showMenuActionForTrigger(trigger);
  }
}

function allMenuActionsDisabled(menuActions: readonly AgentRowMenuAction[]) {
  return menuActions.every((menuAction) => {
    return menuAction.disabled;
  });
}

function AgentRowMenuItems({
  menuActions,
}: {
  readonly menuActions: readonly AgentRowMenuAction[];
}) {
  return menuActions.map((menuAction) => {
    return (
      <DropdownMenuItem
        key={menuAction.label}
        className="gap-2"
        onClick={menuAction.onSelect}
        disabled={menuAction.disabled}
      >
        {menuAction.icon}
        {menuAction.label}
      </DropdownMenuItem>
    );
  });
}

export function AgentRowContextActions({
  actions,
  children,
}: {
  readonly actions: readonly AgentRowMenuAction[];
  readonly children: ReactNode;
}) {
  const disabled = allMenuActionsDisabled(actions);

  if (actions.length === 0) {
    return <>{children}</>;
  }

  return (
    <ContextMenu disabled={disabled}>
      <ContextMenuTrigger className="w-full min-w-0">
        {children}
      </ContextMenuTrigger>
      <DropdownMenuContent className="w-44">
        <AgentRowMenuItems menuActions={actions} />
      </DropdownMenuContent>
    </ContextMenu>
  );
}

function unreadClassName(hasMenuActions: boolean): string {
  const base = "pointer-events-none flex items-center justify-center";
  return hasMenuActions
    ? `${base} group-hover:opacity-0! peer-focus-visible:opacity-0! peer-data-popup-open:opacity-0!`
    : base;
}

export function AgentRowSideActions({
  hasUnread,
  action,
  actions,
  variant = "dialog",
  isPrimarySelected = false,
}: {
  readonly hasUnread: boolean;
  readonly action?: AgentRowMenuAction | undefined;
  readonly actions?: readonly AgentRowMenuAction[] | undefined;
  readonly variant?: "dialog" | "sidebar" | undefined;
  readonly isPrimarySelected?: boolean | undefined;
}) {
  const menuCopy = useAgentRowMenuCopy();
  const menuActions = actions ?? (action ? [action] : []);
  const hasMenuActions = menuActions.length > 0;
  let rootElement: HTMLDivElement | null = null;

  if (!hasUnread && !hasMenuActions) {
    return null;
  }

  const triggerDisabled = allMenuActionsDisabled(menuActions);

  function updateMenuActionVisibility(open: boolean) {
    const root = rootElement;
    if (!root) {
      return;
    }
    root.dataset.agentRowMenuOpen = open ? "true" : "false";
    setActionVisibility(root, open || root.matches(":hover"));
  }

  function handleMenuTriggerClick(e: MouseEvent<HTMLButtonElement>) {
    const hadPointerDownState =
      "agentRowTriggerWasOpen" in e.currentTarget.dataset;
    const wasOpenOnPointerDown =
      e.currentTarget.dataset.agentRowTriggerWasOpen === "true";
    delete e.currentTarget.dataset.agentRowTriggerWasOpen;

    if (wasOpenOnPointerDown) {
      syncMenuActionClosedAfterTriggerClick(e.currentTarget);
    } else if (!hadPointerDownState || !menuTriggerIsOpen(e.currentTarget)) {
      showMenuActionForTrigger(e.currentTarget);
    }
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      ref={(element) => {
        rootElement = element;
      }}
      data-agent-row-actions-root
      data-agent-row-menu-open="false"
      onPointerEnter={(e) => {
        setActionVisibility(e.currentTarget, true);
      }}
      onPointerLeave={(e) => {
        if (e.currentTarget.dataset.agentRowMenuOpen !== "true") {
          setActionVisibility(e.currentTarget, false);
        }
      }}
      style={hasMenuActions ? hiddenActionStyle : undefined}
      className={
        variant === "sidebar"
          ? `absolute right-0 top-0 flex h-8 w-8 items-center justify-center ${
              hasMenuActions ? "" : "pointer-events-none"
            }`
          : `relative flex h-8 w-8 shrink-0 items-center justify-center ${
              hasMenuActions ? "" : "pointer-events-none"
            }`
      }
    >
      {hasMenuActions ? (
        <TooltipProvider delayDuration={200}>
          <DropdownMenu onOpenChange={updateMenuActionVisibility}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={triggerClassName(variant, isPrimarySelected)}
                style={triggerOpacityStyle}
                onPointerDownCapture={(e) => {
                  markTriggerOpenStateOnPointerDown(e.currentTarget);
                }}
                onClick={handleMenuTriggerClick}
                aria-label={menuCopy.openMenu}
                disabled={triggerDisabled}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex h-full w-full items-center justify-center">
                      <Ellipsis size={16} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side={variant === "sidebar" ? "bottom" : "right"}
                  >
                    <p className="text-xs">{menuCopy.more}</p>
                  </TooltipContent>
                </Tooltip>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <AgentRowMenuItems menuActions={menuActions} />
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      ) : null}
      {hasUnread ? (
        <span
          className={unreadClassName(hasMenuActions)}
          style={hasMenuActions ? unreadOpacityStyle : undefined}
        >
          <AgentUnreadIndicator />
        </span>
      ) : null}
    </div>
  );
}
