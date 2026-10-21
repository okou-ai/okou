// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastResolved,
  useLastLoadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Plus, ChevronRight, Pin, PinOff, CheckCheck } from "lucide-react";
import { Button, Skeleton, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import {
  agentCardCollapsed$,
  setAgentCardCollapsed$,
  openPinAgentDialog$,
  pinAgentDialogOpen$,
  setPinAgentDialogOpen$,
  pinAgentDialogHandoff$,
  handOffPinAgentDialogToCreateAgent$,
  completePinAgentDialogClose$,
  pinAgentControl$,
  pinAgentControlRef$,
  endPinnedAgentDrag$,
} from "../../signals/okou-page/sidebar-state.ts";
import { subagents$ } from "../../signals/agent.ts";
import {
  sidebarPinnedAgentItems$,
  sidebarDisplayedPinnedAgentItems$,
  setSidebarAgentPinned$,
  type SidebarPinnedAgentSignals,
} from "../../signals/okou-page/sidebar-pinned-agent.ts";
import { refreshSidebarChatThreadLayoutOnRef$ } from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { equalArrays } from "../../lib/equality.ts";
import { AgentAvatarImg } from "./sidebar-shared.tsx";
import { HoverScrollTitle } from "./hover-scroll-title.tsx";
import { Link } from "../router/link.tsx";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { PinAgentDialog } from "./sidebar-dialogs.tsx";
import {
  AgentUnreadIndicator,
  AgentRowContextActions,
  AgentRowSideActions,
  type AgentRowMenuAction,
} from "./sidebar-agent-row-actions.tsx";

const PINNED_AGENTS_CONTENT_ID = "sidebar-pinned-agents-content";

// Four 66px tiles across the 276px column, with a 4px inline inset, leave each
// name 58px — room for most first words and a five-character Chinese name.
// Keep in step with the grid's `grid-cols-4`.
const PINNED_AGENT_GRID_COLUMNS = 4;
const pinnedAgentGridCardFrameClassName =
  "flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg px-1 py-1.5";
// `leading-tight` at 11px is 13.75px. Keep both loading and resolved labels on
// the same whole-pixel line box so swapping their DOM elements cannot round the
// baseline onto different device pixels.
const pinnedAgentGridLabelFrameClassName = "h-3.5 leading-[14px]";

function PinnedAgentGridSkeletonCard() {
  const refreshLayoutRef = useSet(refreshSidebarChatThreadLayoutOnRef$);
  return (
    <div
      ref={refreshLayoutRef}
      aria-hidden="true"
      data-testid="pinned-agent-skeleton"
      className={pinnedAgentGridCardFrameClassName}
    >
      <span className="flex h-9 w-9 shrink-0">
        <Skeleton className="h-full w-full rounded-full" />
      </span>
      <Skeleton
        data-testid="pinned-agent-label-frame"
        className={`${pinnedAgentGridLabelFrameClassName} w-10`}
      />
    </div>
  );
}

interface PinnedAgentProps {
  readonly signals: SidebarPinnedAgentSignals;
}

function usePinnedAgentMenuActions(
  signals: SidebarPinnedAgentSignals,
): AgentRowMenuAction[] {
  const { t } = useTranslation("agents");
  const isDefaultAgent = useLastResolved(signals.default$) ?? false;
  const isPinned = useLastResolved(signals.pinned$) ?? false;
  const hasUnread = useLastResolved(signals.unread$) ?? false;
  const [pinLoadable, saveAgentPinned] = useLoadableSet(signals.setPinned$);
  const [markReadLoadable, markAgentThreadsRead] = useLoadableSet(
    signals.markRead$,
  );
  const savingPinned = pinLoadable.state === "loading";
  const markingRead = markReadLoadable.state === "loading";

  function unpinAgent() {
    detach(saveAgentPinned(false), Reason.DomCallback);
  }

  function pinAgent() {
    detach(saveAgentPinned(true), Reason.DomCallback);
  }

  function markAllRead() {
    detach(markAgentThreadsRead(), Reason.DomCallback, "markAgentThreadsRead");
  }

  return [
    ...(hasUnread
      ? [
          {
            label: t(($) => {
              return $.sidebar.markAllRead;
            }),
            disabled: markingRead,
            icon: <CheckCheck size={16} />,
            onSelect: markAllRead,
          },
        ]
      : []),
    ...(!isDefaultAgent
      ? [
          isPinned
            ? {
                label: t(($) => {
                  return $.sidebar.unpin;
                }),
                disabled: savingPinned,
                icon: <PinOff size={16} />,
                onSelect: unpinAgent,
              }
            : {
                label: t(($) => {
                  return $.sidebar.pin;
                }),
                disabled: savingPinned,
                icon: <Pin size={16} />,
                onSelect: pinAgent,
              },
        ]
      : []),
  ];
}

function PinnedAgentSideDecorator({ signals }: PinnedAgentProps) {
  const actions = usePinnedAgentMenuActions(signals);
  const isPrimarySelected = useLastResolved(signals.selected$) ?? false;
  const hasUnread = useLastResolved(signals.unread$) ?? false;
  const hasSideActions = useLastResolved(signals.hasSideActions$) ?? false;

  if (!hasSideActions) {
    return null;
  }

  return (
    <AgentRowSideActions
      variant="sidebar"
      isPrimarySelected={isPrimarySelected}
      hasUnread={hasUnread}
      actions={actions}
    />
  );
}

function PinnedAgentContextDecorator({
  children,
  signals,
}: PinnedAgentProps & {
  readonly children: ReactNode;
}) {
  const actions = usePinnedAgentMenuActions(signals);
  return (
    <AgentRowContextActions actions={actions}>
      {children}
    </AgentRowContextActions>
  );
}

/**
 * A grid tile is a quarter of the sidebar wide, so a long agent name still
 * runs past its label. The label fades where it is cut and, like the thread
 * titles below it, scrolls to its end while the tile is hovered or focused, so
 * the full name never needs a tooltip floating over its neighbours.
 */
function PinnedAgentGridCard({ signals }: PinnedAgentProps) {
  const { agentId } = signals;
  const isPrimarySelected = useLastResolved(signals.selected$) ?? false;
  const hasUnread = useLastResolved(signals.unread$) ?? false;
  const isReorderable = useLastResolved(signals.reorderable$) ?? false;
  const dropSide = useLastResolved(signals.dropSide$) ?? null;
  const isDragging = useGet(signals.dragging$);
  const hasDrag = useGet(signals.hasDrag$);
  // Drag acceptance is synchronous: dragOver can immediately follow dragStart.
  const acceptsDrop = isReorderable && hasDrag && !isDragging;
  const selectPinnedAgent = useSet(signals.select$);
  const startDrag = useSet(signals.startDrag$);
  const setDropTarget = useSet(signals.dragOver$);
  const leaveDropTarget = useSet(signals.dragLeave$);
  const endDrag = useSet(endPinnedAgentDrag$);
  const [, moveAgent] = useLoadableSet(signals.moveHere$);
  const refreshLayoutRef = useSet(refreshSidebarChatThreadLayoutOnRef$);

  return (
    <Link
      ref={refreshLayoutRef}
      pathname="/agents/:agentId/chat"
      options={{ pathParams: { agentId } }}
      data-testid="pinned-agent-card"
      aria-current={isPrimarySelected ? "page" : undefined}
      draggable={isReorderable}
      onClick={(e) => {
        if (!shouldHandleLinkClick(e)) {
          return;
        }
        e.preventDefault();
        selectPinnedAgent(hasUnread);
      }}
      onDragStart={(e) => {
        e.dataTransfer.clearData();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-okou-pinned-agent", agentId);
        const dragImage = e.currentTarget.querySelector<HTMLElement>(
          '[data-slot="pinned-agent-avatar"]',
        );
        if (dragImage) {
          e.dataTransfer.setDragImage(
            dragImage,
            dragImage.offsetWidth / 2,
            dragImage.offsetHeight / 2,
          );
        }
        startDrag();
      }}
      onDragEnd={() => {
        endDrag();
      }}
      onDragOver={(e) => {
        if (!hasDrag) {
          return;
        }
        e.preventDefault();
        if (!acceptsDrop) {
          return;
        }
        e.dataTransfer.dropEffect = "move";
        setDropTarget();
      }}
      onDragLeave={leaveDropTarget}
      onDrop={(e) => {
        if (!hasDrag) {
          return;
        }
        e.preventDefault();
        if (!acceptsDrop) {
          return;
        }
        detach(moveAgent(), Reason.DomCallback);
        endDrag();
      }}
      className={`group relative ${pinnedAgentGridCardFrameClassName} no-underline transition-colors duration-200 ${
        isPrimarySelected
          ? "bg-state-selected text-sidebar-foreground"
          : "text-sidebar-foreground hover:bg-state-hover"
      } ${isReorderable ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      {dropSide && (
        <span
          aria-hidden="true"
          data-testid="pinned-agent-drop-caret"
          className={`pointer-events-none absolute inset-y-0 z-10 w-0.5 rounded-full bg-primary ${
            dropSide === "before" ? "-left-[3px]" : "-right-[3px]"
          }`}
        />
      )}
      {isDragging && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0.5 rounded-lg border border-dashed border-[hsl(var(--gray-400))] bg-state-hover"
        />
      )}
      <span
        data-slot="pinned-agent-avatar"
        className={`pointer-events-none relative flex h-9 w-9 shrink-0 ${
          isDragging ? "opacity-0" : ""
        }`}
      >
        <PinnedAgentGridAvatar signals={signals} />
        {hasUnread && (
          <span className="absolute -right-0.5 -top-0.5 flex">
            <AgentUnreadIndicator />
          </span>
        )}
      </span>
      <PinnedAgentGridTitle signals={signals} />
    </Link>
  );
}

function PinnedAgentGridAvatar({ signals }: PinnedAgentProps) {
  const isDefaultAgent = useLastResolved(signals.default$) ?? false;
  return (
    <AgentAvatarImg
      name={signals.agentId}
      alt=""
      preserveChinBaseline
      className={`block h-full w-full object-cover object-top ${
        isDefaultAgent ? "" : "rounded-full"
      }`}
    />
  );
}

function PinnedAgentGridTitle({ signals }: PinnedAgentProps) {
  const displayName = useLastResolved(signals.displayName$);
  const isPrimarySelected = useLastResolved(signals.selected$) ?? false;
  const isDragging = useGet(signals.dragging$);
  if (displayName === undefined) {
    return null;
  }
  return (
    <HoverScrollTitle
      data-slot="pinned-agent-title"
      title={displayName}
      variant="tile"
      className={cn(
        "text-[11px] text-[color:var(--nav-copy,inherit)]",
        pinnedAgentGridLabelFrameClassName,
        isPrimarySelected && "font-medium",
        isDragging && "opacity-0",
      )}
    />
  );
}

export function PinAgentDialogContainer() {
  const open = useGet(pinAgentDialogOpen$);
  const handingOff = useGet(pinAgentDialogHandoff$);
  // A dismissed popup does not end its page-owned preference mutation.
  const [pinLoadable, saveAgentPinned] = useLoadableSet(setSidebarAgentPinned$);

  // A hand-off keeps the dialog mounted through its exit, without returning
  // focus, so the create dialog opens from onOpenChangeComplete and keeps its
  // own initial focus.
  if (!open && !handingOff) {
    return null;
  }

  return (
    <PinAgentDialogSession
      open={open}
      handingOff={handingOff}
      saving={pinLoadable.state === "loading"}
      onSetAgentPinned={(agentId, pinned) => {
        return saveAgentPinned({ agentId, pinned });
      }}
    />
  );
}

function PinAgentDialogSession({
  open,
  handingOff,
  saving,
  onSetAgentPinned,
}: {
  readonly open: boolean;
  readonly handingOff: boolean;
  readonly saving: boolean;
  readonly onSetAgentPinned: (
    agentId: string,
    pinned: boolean,
  ) => Promise<void>;
}) {
  const onOpenChange = useSet(setPinAgentDialogOpen$);
  const subagents = useLastResolved(subagents$) ?? [];
  const handOffToCreateAgent = useSet(handOffPinAgentDialogToCreateAgent$);
  const completeClose = useSet(completePinAgentDialogClose$);
  const pinControl = useGet(pinAgentControl$);

  return (
    <PinAgentDialog
      open={open}
      onOpenChange={onOpenChange}
      subagents={subagents}
      saving={saving}
      onSetAgentPinned={onSetAgentPinned}
      onCreateAgent={() => {
        handOffToCreateAgent();
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          completeClose();
        }
      }}
      handingOff={handingOff}
      returnFocusTo={pinControl}
    />
  );
}

export function PinnedAgentListSection({
  layout = "vertical",
}: {
  layout?: "vertical" | "horizontal";
}) {
  return layout === "horizontal" ? (
    <HorizontalPinnedAgentSection />
  ) : (
    <VerticalPinnedAgentSection />
  );
}

/** Only order/presence and readiness cross the list boundary. */
function usePinnedAgentItems() {
  const pinned = useLastLoadable(sidebarPinnedAgentItems$, {
    equalityFn: equalArrays,
  });
  const displayed = useLastLoadable(sidebarDisplayedPinnedAgentItems$, {
    equalityFn: equalArrays,
  });
  return {
    state: pinned.state,
    items:
      displayed.state === "hasData"
        ? displayed.data
        : pinned.state === "hasData"
          ? pinned.data
          : [],
  };
}

function HorizontalPinnedAgentSection() {
  const { t } = useTranslation("agents");
  const openPinAgentDialog = useSet(openPinAgentDialog$);
  const pinControlRef = useSet(pinAgentControlRef$);
  const { state, items } = usePinnedAgentItems();
  const horizontalPinnedAgents = state === "loading" ? null : items;
  const pinnedAgentCards =
    horizontalPinnedAgents === null
      ? [<PinnedAgentGridSkeletonCard key="loading" />]
      : horizontalPinnedAgents.map((signals) => {
          return (
            <PinnedAgentContextDecorator
              key={signals.agentId}
              signals={signals}
            >
              <PinnedAgentGridCard signals={signals} />
            </PinnedAgentContextDecorator>
          );
        });

  // The pin control keeps its tile while it shares the first row with the
  // agents, and moves to the header once the agents fill that row.
  const pinControlInGrid =
    horizontalPinnedAgents !== null &&
    horizontalPinnedAgents.length < PINNED_AGENT_GRID_COLUMNS;
  const pinControlInHeader =
    horizontalPinnedAgents !== null && !pinControlInGrid;
  const pinAgentLabel = t(($) => {
    return $.sidebar.pinAgent;
  });

  return (
    <div className="shrink-0" data-testid="pinned-agents-horizontal">
      <div className="flex h-8 items-center justify-between pl-2">
        <span className="text-[13px] font-medium leading-4 text-nav-copy-muted">
          {t(($) => {
            return $.sidebar.pinnedAgents;
          })}
        </span>
        {pinControlInHeader && (
          <Button
            ref={pinControlRef}
            type="button"
            variant="quiet"
            size="icon-sm"
            showTooltip
            aria-label={pinAgentLabel}
            onClick={() => {
              openPinAgentDialog();
            }}
          >
            <Plus />
          </Button>
        )}
      </div>
      <div
        className="grid min-w-0 grid-cols-4 items-start gap-x-1 gap-y-2.5"
        data-testid="pinned-agents-grid"
      >
        {pinnedAgentCards}
        {pinControlInGrid && (
          <button
            ref={pinControlRef}
            type="button"
            onClick={() => {
              openPinAgentDialog();
            }}
            aria-label={pinAgentLabel}
            className="flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-[hsl(var(--gray-300))]">
              <Plus size={18} />
            </span>
            <span
              data-testid="pinned-agent-label-frame"
              className={`text-[color:var(--nav-copy-muted,inherit)] ${pinnedAgentGridLabelFrameClassName} text-[11px]`}
            >
              {t(($) => {
                return $.sidebar.addPin;
              })}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function VerticalPinnedAgentContent() {
  const refreshLayoutRef = useSet(refreshSidebarChatThreadLayoutOnRef$);
  const { state, items } = usePinnedAgentItems();
  return (
    <div ref={refreshLayoutRef} className="flex flex-col gap-0.5 mt-1">
      {state === "loading" && (
        <>
          <div
            ref={refreshLayoutRef}
            className="flex h-8 items-center gap-2 px-2"
          >
            <div className="h-5 w-5 shrink-0 rounded-md bg-muted animate-pulse" />
            <div className="h-3 w-20 rounded bg-muted animate-pulse" />
          </div>
          <div className="flex h-8 items-center gap-2 px-2">
            <div className="h-5 w-5 shrink-0 rounded-md bg-muted animate-pulse" />
            <div className="h-3 w-16 rounded bg-muted animate-pulse" />
          </div>
        </>
      )}
      {state === "hasData" &&
        items.map((signals) => {
          return <PinnedAgentRow key={signals.agentId} signals={signals} />;
        })}
    </div>
  );
}

function PinnedAgentRow({ signals }: PinnedAgentProps) {
  const refreshLayoutRef = useSet(refreshSidebarChatThreadLayoutOnRef$);
  return (
    <div
      ref={refreshLayoutRef}
      className="group relative"
      data-testid="pinned-agent-card"
    >
      <PinnedAgentRowLink signals={signals}>
        <PinnedAgentRowLabel signals={signals} />
      </PinnedAgentRowLink>
      <PinnedAgentSideDecorator signals={signals} />
    </div>
  );
}

function PinnedAgentRowLink({
  signals,
  children,
}: PinnedAgentProps & { readonly children: ReactNode }) {
  const isPrimarySelected = useLastResolved(signals.selected$) ?? false;
  const isFromChat = useLastResolved(signals.fromChat$) ?? false;
  const hasSideActions = useLastResolved(signals.hasSideActions$) ?? false;
  const hasUnread = useLastResolved(signals.unread$) ?? false;
  const selectPinnedAgent = useSet(signals.select$);
  return (
    <Link
      pathname="/agents/:agentId/chat"
      options={{ pathParams: { agentId: signals.agentId } }}
      aria-current={isPrimarySelected ? "page" : undefined}
      onClick={(e) => {
        if (!shouldHandleLinkClick(e)) {
          return;
        }
        e.preventDefault();
        selectPinnedAgent(hasUnread, true);
      }}
      className={`flex w-full h-8 shrink-0 items-center gap-2 rounded-lg text-left text-sm leading-5 no-underline transition-colors duration-200 ${
        hasSideActions ? "pl-2 pr-8" : "px-2"
      } ${
        isPrimarySelected
          ? "bg-state-selected text-sidebar-foreground font-medium"
          : isFromChat
            ? "border-l-2 border-[hsl(var(--gray-400))] bg-state-hover text-sidebar-foreground hover:bg-state-selected-hover"
            : "text-sidebar-foreground hover:bg-state-hover"
      }`}
    >
      {children}
    </Link>
  );
}

function PinnedAgentRowLabel({ signals }: PinnedAgentProps) {
  const displayName = useLastResolved(signals.displayName$);
  if (displayName === undefined) {
    return null;
  }
  return (
    <>
      <AgentAvatarImg
        name={signals.agentId}
        alt={displayName}
        className="h-5 w-5 shrink-0 rounded-md object-cover object-top"
      />
      <span className="text-[color:var(--nav-copy,inherit)] truncate">
        {displayName}
      </span>
    </>
  );
}

function VerticalPinnedAgentSection() {
  const { t } = useTranslation("agents");
  const collapsed = useGet(agentCardCollapsed$);
  const setCollapsed = useSet(setAgentCardCollapsed$);

  return (
    <div className="shrink-0">
      <Button
        type="button"
        variant="quiet"
        size="sm"
        aria-expanded={!collapsed}
        aria-controls={PINNED_AGENTS_CONTENT_ID}
        className="group flex h-8 w-full cursor-pointer items-center rounded-lg px-2 text-left hover:bg-state-hover active:bg-transparent transition-colors [&_svg]:size-3"
        data-testid="pinned-section-header"
        onClick={() => {
          return setCollapsed(!collapsed);
        }}
      >
        <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-nav-copy-muted group-hover:text-nav-copy group-focus-visible:text-nav-copy transition-colors">
          {t(($) => {
            return $.sidebar.pinned;
          })}
          <span className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
            <ChevronRight
              className={`opacity-35 ${collapsed ? "" : "rotate-90"}`}
              size={12}
            />
          </span>
        </span>
      </Button>
      <div id={PINNED_AGENTS_CONTENT_ID} hidden={collapsed}>
        {!collapsed && <VerticalPinnedAgentContent />}
      </div>
    </div>
  );
}
