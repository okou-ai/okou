import type { ReactNode } from "react";
import {
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
