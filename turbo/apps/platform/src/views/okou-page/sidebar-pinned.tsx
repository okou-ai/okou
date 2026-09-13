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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Skeleton,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import {
  isChatRoute,
  setSidebarExpanded$,
} from "../../signals/okou-page/nav.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { pathParams$ } from "../../signals/route.ts";
import {
  agentCardCollapsed$,
  setAgentCardCollapsed$,
  openPinAgentDialog$,
  pinAgentDialogOpen$,
  setPinAgentDialogOpen$,
  draggingPinnedAgentId$,
  pinnedAgentDropTargetId$,
  startPinnedAgentDrag$,
  setPinnedAgentDropTarget$,
  endPinnedAgentDrag$,
} from "../../signals/okou-page/sidebar-state.ts";
import { subagents$, defaultAgentId$ } from "../../signals/agent.ts";
import {
  displayedPinnedAgents$,
  setAgentPinned$,
  movePinnedAgent$,
  pinnedAgents$,
} from "../../signals/okou-page/pinned-agents.ts";
import { unreadAgentIds$ } from "../../signals/chat-page/chat-thread-indicators-from-worker.ts";
import { markAgentThreadsRead$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
import { refreshSidebarChatThreadLayoutOnRef$ } from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { equalSets } from "../../lib/equality.ts";
import { AgentAvatarImg } from "./sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { PinAgentDialog } from "./sidebar-dialogs.tsx";
import {
  AgentUnreadIndicator,
  AgentRowContextActions,
  AgentRowSideActions,
  type AgentRowMenuAction,
} from "./sidebar-agent-row-actions.tsx";

const pinnedAgentGridCardFrameClassName =
  "flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg p-1.5";
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

interface PinnedAgentActionProps {
  readonly agentId: string;
  readonly isDefaultAgent: boolean;
  readonly isPinned: boolean;
  readonly hasUnread: boolean;
}

function usePinnedAgentMenuActions({
  agentId,
  isDefaultAgent,
  isPinned,
  hasUnread,
}: PinnedAgentActionProps): AgentRowMenuAction[] {
  const { t } = useTranslation("agents");
  const [pinLoadable, saveAgentPinned] = useLoadableSet(setAgentPinned$);
  const [markReadLoadable, markAgentThreadsRead] = useLoadableSet(
    markAgentThreadsRead$,
  );
  const savingPinned = pinLoadable.state === "loading";
  const markingRead = markReadLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  function unpinAgent() {
    detach(
      saveAgentPinned({ agentId, pinned: false }, pageSignal),
      Reason.DomCallback,
    );
  }

  function pinAgent() {
    detach(
      saveAgentPinned({ agentId, pinned: true }, pageSignal),
      Reason.DomCallback,
    );
  }

  function markAllRead() {
    detach(
      markAgentThreadsRead(agentId, pageSignal),
      Reason.DomCallback,
      "markAgentThreadsRead",
    );
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

function PinnedAgentSideDecorator({
  isPrimarySelected,
  ...actionProps
}: PinnedAgentActionProps & {
  readonly isPrimarySelected: boolean;
}) {
  const actions = usePinnedAgentMenuActions(actionProps);

  return (
    <AgentRowSideActions
      variant="sidebar"
      isPrimarySelected={isPrimarySelected}
      hasUnread={actionProps.hasUnread}
      actions={actions}
    />
  );
}

function PinnedAgentContextDecorator({
  children,
  ...actionProps
}: PinnedAgentActionProps & {
  readonly children: ReactNode;
}) {
  const actions = usePinnedAgentMenuActions(actionProps);
  return (
    <AgentRowContextActions actions={actions}>
      {children}
    </AgentRowContextActions>
  );
}

interface PinnedGridAgent {
  readonly agentId: string;
  readonly displayName?: string | null;
}

/** Which side of the hovered card the dragged agent lands on. */
type PinnedDropSide = "before" | "after";

/**
 * A grid tile is only a fifth of the sidebar wide, so almost every agent name
 * is truncated down to a few characters. The tile carries a hover tooltip with
 * the full name — a native `title` is too slow and too easy to miss for a label
 * that is unreadable by default. The tooltip is disabled while a reorder drag
 * is in flight so it never floats over the drop carets.
 */
function PinnedAgentGridCard({
  agent,
  isPrimarySelected,
  hasUnread,
  isDefaultAgent,
  isReorderable,
  dropSide,
}: {
  readonly agent: PinnedGridAgent;
  readonly isPrimarySelected: boolean;
  readonly hasUnread: boolean;
  readonly isDefaultAgent: boolean;
  readonly isReorderable: boolean;
  readonly dropSide: PinnedDropSide | null;
}) {
  const pageSignal = useGet(pageSignal$);
  const draggingAgentId = useGet(draggingPinnedAgentId$);
  const dropTargetAgentId = useGet(pinnedAgentDropTargetId$);
  const startDrag = useSet(startPinnedAgentDrag$);
  const setDropTarget = useSet(setPinnedAgentDropTarget$);
  const endDrag = useSet(endPinnedAgentDrag$);
  const [, moveAgent] = useLoadableSet(movePinnedAgent$);
  const refreshLayoutRef = useSet(refreshSidebarChatThreadLayoutOnRef$);
  const displayName = agent.displayName ?? agent.agentId;

  const isDragging = draggingAgentId === agent.agentId;
  const isDragInFlight = draggingAgentId !== null;
  const acceptsDrop =
    isReorderable &&
    draggingAgentId !== null &&
    draggingAgentId !== agent.agentId;

  const card = (
    <Link
      ref={refreshLayoutRef}
      pathname="/agents/:agentId/chat"
      options={{ pathParams: { agentId: agent.agentId } }}
      data-testid="pinned-agent-card"
      aria-current={isPrimarySelected ? "page" : undefined}
      draggable={isReorderable}
      onDragStart={(e) => {
        e.dataTransfer.clearData();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(
          "application/x-okou-pinned-agent",
          agent.agentId,
        );
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
        startDrag(agent.agentId);
      }}
      onDragEnd={() => {
        endDrag();
      }}
      onDragOver={(e) => {
        if (draggingAgentId === null) {
          return;
        }
        e.preventDefault();
        if (!acceptsDrop) {
          return;
        }
        e.dataTransfer.dropEffect = "move";
        setDropTarget(agent.agentId);
      }}
      onDragLeave={() => {
        if (dropTargetAgentId === agent.agentId) {
          setDropTarget(null);
        }
      }}
      onDrop={(e) => {
        if (draggingAgentId === null) {
          return;
        }
        e.preventDefault();
        if (!acceptsDrop) {
          return;
        }
        detach(
          moveAgent(
            { agentId: draggingAgentId, targetAgentId: agent.agentId },
            pageSignal,
          ),
          Reason.DomCallback,
        );
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
        <AgentAvatarImg
          name={agent.agentId}
          alt=""
          preserveChinBaseline
          className={`block h-full w-full object-cover object-top ${
            isDefaultAgent ? "" : "rounded-full"
          }`}
        />
        {hasUnread && (
          <span className="absolute -right-0.5 -top-0.5 flex">
            <AgentUnreadIndicator />
          </span>
        )}
      </span>
      <span
        data-testid="pinned-agent-label-frame"
        className={`text-[color:var(--nav-copy,inherit)] ${pinnedAgentGridLabelFrameClassName} w-full truncate text-center text-[11px] ${
          isPrimarySelected ? "font-medium" : ""
        } ${isDragging ? "opacity-0" : ""}`}
      >
        {displayName}
      </span>
    </Link>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip disabled={isDragInFlight}>
        <TooltipTrigger asChild>{card}</TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs">{displayName}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Which edge of `agentId` the insertion caret sits on. `movePinnedAgent$`
 * splices the dragged agent into the target's index, so a drag that travels
 * backwards lands before the target and a forwards drag lands after it.
 */
function resolveDropSide({
  agents,
  draggingAgentId,
  dropTargetAgentId,
  agentId,
}: {
  readonly agents: readonly PinnedGridAgent[];
  readonly draggingAgentId: string | null;
  readonly dropTargetAgentId: string | null;
  readonly agentId: string;
}): PinnedDropSide | null {
  if (draggingAgentId === null || dropTargetAgentId !== agentId) {
    return null;
  }
  const from = agents.findIndex((a) => {
    return a.agentId === draggingAgentId;
  });
  const to = agents.findIndex((a) => {
    return a.agentId === agentId;
  });
  if (from === -1 || to === -1 || from === to) {
    return null;
  }
  return from > to ? "before" : "after";
}

export function PinAgentDialogContainer() {
  const open = useGet(pinAgentDialogOpen$);
  const onOpenChange = useSet(setPinAgentDialogOpen$);
  const subagents = useLastResolved(subagents$) ?? [];
  const pageSignal = useGet(pageSignal$);
  const [pinLoadable, saveAgentPinned] = useLoadableSet(setAgentPinned$);

  if (!open) {
    return null;
  }

  return (
    <PinAgentDialog
      open
      onOpenChange={onOpenChange}
      subagents={subagents}
      saving={pinLoadable.state === "loading"}
      onSetAgentPinned={(agentId, pinned) => {
        return saveAgentPinned({ agentId, pinned }, pageSignal);
      }}
    />
  );
}

export function PinnedAgentListSection({
  layout = "vertical",
}: {
  layout?: "vertical" | "horizontal";
}) {
  const refreshLayoutRef = useSet(refreshSidebarChatThreadLayoutOnRef$);
  const { t } = useTranslation("agents");
  const activeRoute = useGet(activeRoute$);
  const pathParams = useGet(pathParams$);
  const routeAgentId =
    typeof pathParams?.agentId === "string" ? pathParams.agentId : null;
  const sidebarAgentId = useLastResolved(currentChatAgentId$) ?? null;
  const pinnedAgentsLoadable = useLastLoadable(pinnedAgents$);
  const displayedPinnedAgentsLoadable = useLastLoadable(displayedPinnedAgents$);
  const unreadAgentIds = useLastResolved(unreadAgentIds$, {
    equalityFn: equalSets,
  });

  const openPinAgentDialog = useSet(openPinAgentDialog$);
  const setExpanded = useSet(setSidebarExpanded$);
  const collapsed = useGet(agentCardCollapsed$);
  const setCollapsed = useSet(setAgentCardCollapsed$);
  const draggingAgentId = useGet(draggingPinnedAgentId$);
  const dropTargetAgentId = useGet(pinnedAgentDropTargetId$);
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const pinnedAgents =
    pinnedAgentsLoadable.state === "hasData" ? pinnedAgentsLoadable.data : [];
  const pinnedAgentIds = new Set(
    pinnedAgents.map((agent) => {
      return agent.agentId;
    }),
  );
  const displayedPinnedAgents =
    displayedPinnedAgentsLoadable.state === "hasData"
      ? displayedPinnedAgentsLoadable.data
      : pinnedAgents;

  const selectedAgentId = routeAgentId ?? sidebarAgentId;

  if (layout === "horizontal") {
    const horizontalPinnedAgents =
      pinnedAgentsLoadable.state === "loading" ? null : displayedPinnedAgents;
    const pinnedAgentCards =
      horizontalPinnedAgents === null
        ? [<PinnedAgentGridSkeletonCard key="loading" />]
        : horizontalPinnedAgents.map((agent) => {
            const isPrimarySelected =
              isChatRoute(activeRoute) && selectedAgentId === agent.agentId;
            const hasUnread = unreadAgentIds?.has(agent.agentId) ?? false;
            const isPinned = pinnedAgentIds.has(agent.agentId);
            const isDefaultAgent = agent.agentId === defaultAgentId;
            return (
              <PinnedAgentContextDecorator
                key={agent.agentId}
                agentId={agent.agentId}
                isDefaultAgent={isDefaultAgent}
                isPinned={isPinned}
                hasUnread={hasUnread}
              >
                <PinnedAgentGridCard
                  agent={agent}
                  isPrimarySelected={isPrimarySelected}
                  hasUnread={hasUnread}
                  isDefaultAgent={isDefaultAgent}
                  isReorderable={isPinned && !isDefaultAgent}
                  dropSide={resolveDropSide({
                    agents: horizontalPinnedAgents,
                    draggingAgentId,
                    dropTargetAgentId,
                    agentId: agent.agentId,
                  })}
                />
              </PinnedAgentContextDecorator>
            );
          });

    return (
      <div className="shrink-0" data-testid="pinned-agents-horizontal">
        <span className="flex h-8 items-center pl-2 text-[13px] font-medium leading-4 text-nav-copy-muted">
          {t(($) => {
            return $.sidebar.pinnedAgents;
          })}
        </span>
        <div
          className="grid min-w-0 grid-cols-5 items-start gap-x-1 gap-y-2.5"
          data-testid="pinned-agents-grid"
        >
          {pinnedAgentCards.slice(0, 4)}
          {horizontalPinnedAgents !== null && (
            <button
              type="button"
              onClick={() => {
                openPinAgentDialog();
              }}
              aria-label={t(($) => {
                return $.sidebar.pinAgent;
              })}
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
          {pinnedAgentCards.slice(4)}
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0">
      <div
        className="group flex h-8 cursor-pointer items-center rounded-lg px-2 hover:bg-state-hover transition-colors"
        data-testid="pinned-section-header"
        onClick={() => {
          return setCollapsed(!collapsed);
        }}
      >
        <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-nav-copy-muted group-hover:text-nav-copy transition-colors">
          {t(($) => {
            return $.sidebar.pinned;
          })}
          <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <ChevronRight
              className={`opacity-35 ${collapsed ? "" : "rotate-90"}`}
              size={12}
            />
          </span>
        </span>
      </div>
      {!collapsed && (
        <div ref={refreshLayoutRef} className="flex flex-col gap-0.5 mt-1">
          {pinnedAgentsLoadable.state === "loading" && (
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
          {pinnedAgentsLoadable.state === "hasData" &&
            displayedPinnedAgents.map((agent) => {
              const isPrimarySelected =
                isChatRoute(activeRoute) && selectedAgentId === agent.agentId;
              const isFromChat = sidebarAgentId === agent.agentId;
              const isPinned = pinnedAgentIds.has(agent.agentId);
              const hasUnread = unreadAgentIds?.has(agent.agentId) ?? false;
              const isDefaultAgent = agent.agentId === defaultAgentId;
              const hasSideActions = hasUnread || (!isDefaultAgent && isPinned);
              return (
                <div
                  key={agent.agentId}
                  ref={refreshLayoutRef}
                  className="group relative"
                  data-testid="pinned-agent-card"
                >
                  <Link
                    pathname="/agents/:agentId/chat"
                    options={{ pathParams: { agentId: agent.agentId } }}
                    aria-current={isPrimarySelected ? "page" : undefined}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) {
                        return;
                      }
                      setExpanded(false);
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
                    <AgentAvatarImg
                      name={agent.agentId}
                      alt={agent.displayName ?? agent.agentId}
                      className="h-5 w-5 shrink-0 rounded-md object-cover object-top"
                    />
                    <span className="text-[color:var(--nav-copy,inherit)] truncate">
                      {agent.displayName ?? agent.agentId}
                    </span>
                  </Link>
                  {hasSideActions ? (
                    <PinnedAgentSideDecorator
                      agentId={agent.agentId}
                      isDefaultAgent={isDefaultAgent}
                      isPinned={isPinned}
                      isPrimarySelected={isPrimarySelected}
                      hasUnread={hasUnread}
                    />
                  ) : null}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
