import type { MouseEvent } from "react";
import { useGet, useLoadable, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Check,
  CheckCheck,
  ChevronRight,
  Trash,
  Pencil,
  Ellipsis,
  MessageSquareDot,
  Pin,
  PinOff,
} from "lucide-react";
import { useChatThreadsTitleLabels } from "./sidebar-shared.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Button,
  Input,
  RunningIndicator,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  getShortcutLabel,
  cn,
} from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@okouai/ui/components/ui/dialog";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { mainStylesheetLoaded$ } from "../../signals/app-skeleton.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  deleteChatThread$,
  renameChatThread$,
} from "../../signals/chat-page/chat-event.ts";
import { chatThreadContainerElement$ } from "../../signals/chat-page/chat-keyboard.ts";
import {
  createNewChatThread$,
  newChatThreadDisabled$,
  type NewChatThreadPane,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import type {
  SidebarChatThreadListSignals,
  SidebarChatThreadScrollSignals,
  SidebarChatThreadWindow,
} from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import type { SidebarChatThreadItemSignals } from "../../signals/chat-page/sidebar-chat-thread-item.ts";
import { sidebarThreadTitleOverflowRef$ } from "../../signals/chat-page/sidebar-thread-title.ts";
import {
  currentChatAgentScope$,
  currentChatAgentId$,
  currentChatThreadId$,
} from "../../signals/agent-chat.ts";
import { setSidebarExpanded$ } from "../../signals/okou-page/nav.ts";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
import {
  chatThreadOnlyUnread$,
  setChatThreadOnlyUnread$,
} from "../../signals/chat-page/chat-thread-only-unread.ts";
import { unreadAgentIds$ } from "../../signals/chat-page/chat-thread-indicators-from-worker.ts";
import { markAgentThreadsRead$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
import {
  closeRenameChatThreadDialog$,
  pendingDeleteThreadId$,
  renameDialogAgentId$,
  renameDialogOpen$,
  setPendingDeleteThreadId$,
  renameDialogThreadId$,
  renameDialogInput$,
  setRenameDialogInput$,
  sessionListCollapsed$,
  setSessionListCollapsed$,
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  threeColumnSearchOpen$,
} from "../../signals/okou-page/sidebar-state.ts";
import { setThreadListNumberShortcutRoot$ } from "../../signals/okou-page/thread-list-number-shortcuts.ts";
import { ThreadNumberShortcutHint } from "./thread-number-shortcut-hint.tsx";
import { Link } from "../router/link.tsx";
import { OverlayScrollArea } from "./sidebar-scroll.tsx";
import { ThreadPinMoveMenuItems } from "./sidebar-thread-reorder.tsx";
import { equalArrays } from "../../lib/equality.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";

// The row glyphs draw at 17px, which the shared button base (`[&_svg]:size-4`)
// would otherwise clamp to 16px. Dimming stays on the individual glyphs so the
// state indicators keep their own contrast.
const CHAT_THREAD_ROW_ICON_CLASS = "[&_svg]:size-[17px]";

function ChatThreadMenuShortcut({ shortcut }: { readonly shortcut: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="ml-auto shrink-0 whitespace-nowrap pl-4 font-sans text-xs opacity-70"
    >
      {getShortcutLabel(shortcut)}
    </kbd>
  );
}

function equalSidebarChatThreadWindows(
  previous: SidebarChatThreadWindow,
  next: SidebarChatThreadWindow,
): boolean {
  return (
    previous.startIndex === next.startIndex &&
    equalArrays(previous.items, next.items, (left, right) => {
      return left === right;
    })
  );
}

function SessionStateIndicator({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const state = useLastResolved(signals.indicatorState$) ?? null;
  if (state === null) {
    return null;
  }
  if (state === "running") {
    return <RunningIndicator />;
  }
  if (state === "unread") {
    return (
      <span
        role="img"
        aria-label={t(($) => {
          return $.chat.sidebar.unread;
        })}
        className="h-2 w-2 rounded-full bg-sky-600"
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={t(($) => {
        return $.chat.sidebar.draft;
      })}
      className="flex items-center justify-center text-sidebar-foreground"
    >
      <Pencil className="opacity-35" size={16} />
    </span>
  );
}

function ChatThreadListPaneIcon({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const pane = useGet(signals.paneIndicator$);
  if (pane === null) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      data-testid={`chat-thread-list-pane-icon-${pane}`}
      className="grid h-3 w-4 shrink-0 grid-cols-2 overflow-hidden rounded-[2px] border border-current"
    >
      <span className={pane === "main" ? "bg-current" : "bg-transparent"} />
      <span className={pane === "sidebar" ? "bg-current" : "bg-transparent"} />
    </span>
  );
}

function preventChatThreadMenuNavigation(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

function ChatThreadMarkUnreadMenuItem({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const markUnread = useSet(signals.markUnread$);
  const pageSignal = useGet(pageSignal$);

  return (
    <DropdownMenuItem
      onSelect={() => {
        detach(markUnread(pageSignal), Reason.DomCallback);
      }}
    >
      <MessageSquareDot size={16} className="mr-2" />
      {t(($) => {
        return $.chat.sidebar.markUnread;
      })}
    </DropdownMenuItem>
  );
}

function ChatThreadPinMenuItems({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const isPinned = useGet(signals.pinned$);
  const togglePinned = useSet(signals.togglePinned$);
  const pageSignal = useGet(pageSignal$);
  const label = isPinned
    ? t(($) => {
        return $.chat.sidebar.unpin;
      })
    : t(($) => {
        return $.chat.sidebar.pin;
      });
  return (
    <>
      <DropdownMenuItem
        aria-label={label}
        aria-keyshortcuts={
          GLOBAL_KEYBOARD_SHORTCUTS.toggleChatPin.ariaKeyShortcuts
        }
        onSelect={() => {
          detach(togglePinned(pageSignal), Reason.DomCallback);
        }}
      >
        {isPinned ? (
          <PinOff size={16} className="mr-2" />
        ) : (
          <Pin size={16} className="mr-2" />
        )}
        {label}
        <ChatThreadMenuShortcut
          shortcut={GLOBAL_KEYBOARD_SHORTCUTS.toggleChatPin.binding}
        />
      </DropdownMenuItem>
      <ThreadPinMoveMenuItems signals={signals} />
    </>
  );
}

function ChatThreadMenu({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const isPinned = useGet(signals.pinned$);
  const indicatorState = useLastResolved(signals.indicatorState$) ?? null;
  const openRename = useSet(signals.openRename$);
  const requestDelete = useSet(signals.requestDelete$);
  const pageSignal = useGet(pageSignal$);
  const renameLabel = t(($) => {
    return $.chat.sidebar.rename;
  });

  function openRenameDialog() {
    detach(openRename(pageSignal), Reason.DomCallback);
  }

  const showStateIndicator = indicatorState !== null;
  const showPinIndicator = isPinned && indicatorState === null;
  const hasRestingIndicator = showStateIndicator || showPinIndicator;

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            onClick={preventChatThreadMenuNavigation}
            variant="quiet"
            size="icon-2xs"
            className={`group/thread-menu pointer-events-auto absolute left-1 top-1 cursor-pointer rounded-md transition-opacity duration-150 ${
              hasRestingIndicator
                ? ""
                : "md:invisible md:group-hover:visible md:data-popup-open:visible"
            } ${CHAT_THREAD_ROW_ICON_CLASS}`}
            aria-label={t(($) => {
              return $.chat.sidebar.openChatMenu;
            })}
            data-testid="chat-thread-menu-trigger"
            data-pinned={isPinned ? "true" : "false"}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label={
                    showPinIndicator
                      ? t(($) => {
                          return $.chat.sidebar.pinned;
                        })
                      : undefined
                  }
                  data-testid={
                    showPinIndicator
                      ? "chat-thread-pinned-indicator"
                      : undefined
                  }
                  className="flex items-center justify-center"
                >
                  {hasRestingIndicator ? (
                    <>
                      <span className="flex items-center justify-center md:group-hover:hidden md:group-data-[popup-open]/thread-menu:hidden">
                        {showStateIndicator ? (
                          <SessionStateIndicator signals={signals} />
                        ) : (
                          <Pin size={17} className="opacity-70" />
                        )}
                      </span>
                      <Ellipsis
                        size={17}
                        className="hidden opacity-70 md:group-hover:block md:group-data-[popup-open]/thread-menu:block"
                      />
                    </>
                  ) : (
                    <Ellipsis size={17} className="opacity-70" />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">
                  {t(($) => {
                    return $.chat.actions.more;
                  })}
                </p>
              </TooltipContent>
            </Tooltip>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-56"
          data-chat-thread-menu-thread-id={signals.threadId}
        >
          <ChatThreadPinMenuItems signals={signals} />
          <ChatThreadMarkUnreadMenuItem signals={signals} />
          <DropdownMenuModalItem
            aria-label={renameLabel}
            aria-keyshortcuts={
              GLOBAL_KEYBOARD_SHORTCUTS.renameChat.ariaKeyShortcuts
            }
            onModalSelect={openRenameDialog}
          >
            <Pencil size={16} className="mr-2" />
            {renameLabel}
            <ChatThreadMenuShortcut
              shortcut={GLOBAL_KEYBOARD_SHORTCUTS.renameChat.binding}
            />
          </DropdownMenuModalItem>
          <DropdownMenuModalItem
            onModalSelect={() => {
              requestDelete();
            }}
            className="text-destructive focus:text-destructive"
          >
            <Trash size={16} className="mr-2" />
            {t(($) => {
              return $.chat.sidebar.delete;
            })}
          </DropdownMenuModalItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

/**
 * A title that does not fit fades out instead of ending in an ellipsis, and
 * hovering or focusing its row scrolls the text to its end and stops there.
 *
 * `--okou-nav-title-overflow` is the only measured input; the mask and the
 * travel are both derived from it, which is what makes an edge fade exactly
 * when content is cut off at it. `--okou-nav-title-shift` is registered in the
 * App stylesheet, because a transition cannot interpolate a length that is not,
 * and `inherits: true` is what carries the animated value to the text span.
 *
 * The state variant spells the row's `data-sidebar-chat-thread-id` out rather
 * than reaching for `group-hover`, and spells it out twice rather than hoisting
 * it into a constant: Tailwind wraps `group-hover` in `@media (hover: hover)`
 * while this affordance has always run on coarse pointers too, and Tailwind's
 * scanner is text-based, so an interpolated variant would generate no CSS.
 */
function ChatThreadItemTitle({ title }: { title: string }) {
  const measureTitle = useSet(sidebarThreadTitleOverflowRef$);

  return (
    <span
      data-slot="sidebar-thread-title"
      ref={measureTitle}
      className={cn(
        "text-[color:var(--nav-copy,inherit)] flex-1 min-w-0 overflow-hidden",
        // `sidebarThreadTitleOverflowRef$` overwrites the first two inline as
        // soon as it has measured; these are the values before it runs.
        "[--okou-nav-title-overflow:0px] [--okou-nav-title-duration:780ms] [--okou-nav-title-fade:24px]",
        // At rest only the right edge is masked, at the end of the travel only
        // the left one, and a title that fits gets neither.
        "[mask-image:linear-gradient(90deg,transparent_0,#000_clamp(0px,calc(-1*var(--okou-nav-title-shift)),var(--okou-nav-title-fade)),#000_calc(100%_-_clamp(0px,calc(var(--okou-nav-title-overflow)_+_var(--okou-nav-title-shift)),var(--okou-nav-title-fade))),transparent_100%)]",
        "mask-no-repeat [mask-size:100%_100%]",
        // Returning has no delay, so the title snaps back under the next row.
        "[transition:--okou-nav-title-shift_660ms_cubic-bezier(0.4,0,0.2,1)]",
        // The delay keeps a pointer sweeping down the list from setting every
        // row in motion.
        "[:is([data-sidebar-chat-thread-id]:hover,[data-sidebar-chat-thread-id]:focus-visible)_&]:[transition:--okou-nav-title-shift_var(--okou-nav-title-duration)_cubic-bezier(0.33,0,0.2,1)_750ms]",
        // `motion-safe` leaves the shift at its registered `0px`, which is the
        // value reduced motion has always resolved to.
        "motion-safe:[:is([data-sidebar-chat-thread-id]:hover,[data-sidebar-chat-thread-id]:focus-visible)_&]:[--okou-nav-title-shift:calc(-1*var(--okou-nav-title-overflow))]",
      )}
    >
      <span className="block w-max whitespace-nowrap [transform:translateX(var(--okou-nav-title-shift))]">
        {title}
      </span>
    </span>
  );
}

function ChatThreadItemLink({
  signals,
  shortcutNumber,
}: {
  signals: SidebarChatThreadItemSignals;
  shortcutNumber: number | undefined;
}) {
  const { t } = useTranslation();
  const title = useGet(signals.title$);
  const isCurrentPage = useGet(signals.currentPage$);
  const isHighlighted = useGet(signals.highlighted$);
  const isUnread = useLastResolved(signals.unread$) ?? false;
  const select = useSet(signals.select$);
  const openRename = useSet(signals.openRename$);
  const pageSignal = useGet(pageSignal$);

  return (
    <Link
      pathname="/chats/:threadId"
      options={{ pathParams: { threadId: signals.threadId } }}
      aria-current={isCurrentPage ? "page" : undefined}
      data-sidebar-chat-thread-id={signals.threadId}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          return;
        }
        if (select(e.altKey ? "sidebar" : "main")) {
          e.preventDefault();
        }
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        detach(openRename(pageSignal), Reason.DomCallback);
      }}
      className={`col-span-2 col-start-1 row-start-1 grid h-8 grid-cols-subgrid items-center rounded-lg pl-2 text-left text-sm leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
        isHighlighted
          ? "bg-state-selected text-sidebar-foreground font-medium"
          : isUnread
            ? "text-sidebar-foreground font-medium hover:bg-state-hover"
            : "text-sidebar-foreground hover:bg-state-hover"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2 pr-8">
        <ChatThreadListPaneIcon signals={signals} />
        <ChatThreadItemTitle
          title={
            title ??
            t(($) => {
              return $.chat.newChat;
            })
          }
        />
      </span>
      <span className="flex items-center pr-2 empty:hidden">
        <ThreadNumberShortcutHint shortcutNumber={shortcutNumber} />
      </span>
    </Link>
  );
}

function ChatThreadItem({
  signals,
  shortcutNumber,
}: {
  signals: SidebarChatThreadItemSignals;
  shortcutNumber: number | undefined;
}) {
  return (
    <div className="group relative grid grid-cols-[minmax(0,1fr)_auto] items-center">
      <ChatThreadItemLink signals={signals} shortcutNumber={shortcutNumber} />
      <div className="pointer-events-none relative col-start-1 row-start-1 flex h-8 w-8 items-center justify-center justify-self-end">
        <ChatThreadMenu signals={signals} />
      </div>
    </div>
  );
}

function ChatThreadRenameDialog() {
  const { t } = useTranslation();
  const renameDialogOpen = useGet(renameDialogOpen$);
  const renameDialogThreadId = useGet(renameDialogThreadId$);
  const renameDialogAgentId = useGet(renameDialogAgentId$);
  const renameDialogInput = useGet(renameDialogInput$);
  const closeRenameChatThreadDialog = useSet(closeRenameChatThreadDialog$);
  const setRenameDialogInput = useSet(setRenameDialogInput$);
  const renameChatThread = useSet(renameChatThread$);
  const chatThreadContainerElement = useSet(chatThreadContainerElement$);
  const pageSignal = useGet(pageSignal$);

  function closeRenameDialog() {
    closeRenameChatThreadDialog();
  }

  function handleRename() {
    if (!renameDialogThreadId || !renameDialogInput.trim()) {
      return;
    }
    const threadId = renameDialogThreadId;
    const agentId = renameDialogAgentId;
    const title = renameDialogInput.trim();
    detach(
      (async () => {
        await renameChatThread({ threadId, title, agentId }, pageSignal);
      })(),
      Reason.DomCallback,
    );
    closeRenameDialog();
  }

  return (
    <Dialog
      open={renameDialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeRenameDialog();
        }
      }}
    >
      <DialogContent
        finalFocus={() => {
          return renameDialogThreadId
            ? chatThreadContainerElement(renameDialogThreadId)
            : null;
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.chat.sidebar.rename;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.chat.sidebar.renameDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleRename();
          }}
        >
          <div className="py-2">
            <Input
              type="text"
              autoFocus
              value={renameDialogInput}
              onChange={(e) => {
                return setRenameDialogInput(e.target.value);
              }}
              placeholder={t(($) => {
                return $.chat.sidebar.titlePlaceholder;
              })}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                closeRenameDialog();
              }}
            >
              {t(($) => {
                return $.chat.actions.cancel;
              })}
            </Button>
            <Button type="submit" disabled={!renameDialogInput.trim()}>
              {t(($) => {
                return $.chat.actions.rename;
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteChatThreadDialogContent({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {t(($) => {
            return $.chat.sidebar.deleteTitle;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.chat.sidebar.deleteDescription;
          })}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t(($) => {
            return $.chat.actions.cancel;
          })}
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          {t(($) => {
            return $.chat.actions.delete;
          })}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function DeleteChatThreadDialog() {
  const pendingDeleteThreadId = useGet(pendingDeleteThreadId$);
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const deleteChatThread = useSet(deleteChatThread$);
  const pageSignal = useGet(pageSignal$);

  function confirmDelete() {
    if (!pendingDeleteThreadId) {
      return;
    }
    const threadId = pendingDeleteThreadId;
    setPendingDeleteThreadId(null);
    detach(deleteChatThread(threadId, pageSignal), Reason.DomCallback);
  }

  function cancelDelete() {
    setPendingDeleteThreadId(null);
  }

  return (
    <Dialog
      open={pendingDeleteThreadId !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPendingDeleteThreadId(null);
        }
      }}
    >
      <DeleteChatThreadDialogContent
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
      />
    </Dialog>
  );
}

export function ChatThreadDialogs() {
  return (
    <>
      <ChatThreadRenameDialog />
      <DeleteChatThreadDialog />
    </>
  );
}

function VirtualizedChatThreads({
  listSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
}) {
  const setShortcutRoot = useSet(setThreadListNumberShortcutRoot$);
  const searchOpen = useGet(threeColumnSearchOpen$);
  const threadCount = useGet(listSignals.count$);
  const window = useGet(listSignals.window$, {
    equalityFn: equalSidebarChatThreadWindows,
  });
  const startIndex = window.startIndex;
  const visibleItems = window.items;

  return (
    <div
      ref={setShortcutRoot}
      className="relative w-full"
      data-testid="sidebar-chat-threads-virtual-list"
      style={{ height: threadCount * CHAT_THREAD_VIRTUAL_ROW_HEIGHT }}
    >
      {visibleItems.map((signals, visibleOffset) => {
        const index = startIndex + visibleOffset;
        return (
          <div
            key={signals.threadId}
            data-index={index}
            data-testid="sidebar-chat-thread-virtual-row"
            className="absolute left-0 top-0 w-full pb-1"
            style={{
              transform: `translateY(${
                index * CHAT_THREAD_VIRTUAL_ROW_HEIGHT
              }px)`,
            }}
          >
            <ChatThreadItem
              signals={signals}
              shortcutNumber={!searchOpen && index < 9 ? index + 1 : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

function ChatThreads({
  listSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
}) {
  const { t } = useTranslation();
  const unreadOnly = useGet(chatThreadOnlyUnread$);
  const threadCount = useGet(listSignals.count$);

  if (threadCount === 0) {
    return (
      <p className="px-2 py-2 text-xs text-nav-copy-muted leading-relaxed">
        {unreadOnly
          ? t(($) => {
              return $.chat.sidebar.noUnread;
            })
          : t(($) => {
              return $.chat.sidebar.empty;
            })}
      </p>
    );
  }
  return <VirtualizedChatThreads listSignals={listSignals} />;
}

function ChatThreadsListMenuTooltip() {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Ellipsis size={18} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">
          {t(($) => {
            return $.chat.actions.more;
          })}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function useNewChatAction() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$) ?? null;
  const createNewChat = useSet(createNewChatThread$);
  const setExpanded = useSet(setSidebarExpanded$);
  const rootSignal = useGet(rootSignal$);
  const newChatDisabled = useGet(newChatThreadDisabled$);

  function onSelect(pane: NewChatThreadPane) {
    if (!currentChatAgentId) {
      return;
    }
    detach(
      createNewChat(currentChatAgentId, pane, rootSignal),
      Reason.DomCallback,
    );
    setExpanded(false);
  }

  return {
    disabled: !currentChatAgentId || newChatDisabled,
    onSelect,
  };
}

function useMarkAllReadMenuAction(showMarkAllRead: boolean) {
  const currentChatAgentId = useLastResolved(currentChatAgentId$) ?? null;
  const unreadAgentIds = useLastResolved(unreadAgentIds$);
  const [markReadLoadable, markAgentThreadsRead] = useLoadableSet(
    markAgentThreadsRead$,
  );
  const pageSignal = useGet(pageSignal$);
  const markingRead = markReadLoadable.state === "loading";
  const visible =
    showMarkAllRead &&
    currentChatAgentId !== null &&
    (unreadAgentIds?.has(currentChatAgentId) ?? false);

  function onSelect() {
    if (!currentChatAgentId) {
      return;
    }
    detach(
      markAgentThreadsRead(currentChatAgentId, pageSignal),
      Reason.DomCallback,
      "markAgentThreadsRead",
    );
  }

  return { disabled: markingRead, onSelect, visible };
}

function MarkAllReadMenuItem({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("agents");

  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled}>
      <CheckCheck size={16} className="mr-2" />
      {t(($) => {
        return $.sidebar.markAllRead;
      })}
    </DropdownMenuItem>
  );
}

function ChatThreadFilterMenuItems() {
  const { t } = useTranslation();
  const setCollapsed = useSet(setSessionListCollapsed$);
  const unreadOnly = useGet(chatThreadOnlyUnread$);
  const setUnreadOnly = useSet(setChatThreadOnlyUnread$);

  function toggleUnreadOnly(next: boolean) {
    setUnreadOnly(next);
    if (next) {
      setCollapsed(false);
    }
  }

  return (
    <>
      <DropdownMenuItem
        onSelect={() => {
          toggleUnreadOnly(false);
        }}
      >
        <Check size={16} className={`mr-2 ${unreadOnly ? "invisible" : ""}`} />
        {t(($) => {
          return $.chat.sidebar.allChats;
        })}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          toggleUnreadOnly(true);
        }}
      >
        <Check size={16} className={`mr-2 ${unreadOnly ? "" : "invisible"}`} />
        {t(($) => {
          return $.chat.sidebar.unreadOnly;
        })}
      </DropdownMenuItem>
    </>
  );
}

function ChatThreadsListMenu({
  showMarkAllRead,
}: {
  showMarkAllRead: boolean;
}) {
  const { t } = useTranslation();
  const markAllReadAction = useMarkAllReadMenuAction(showMarkAllRead);

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
            }}
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className="relative z-10 shrink-0"
            aria-label={t(($) => {
              return $.chat.sidebar.openListMenu;
            })}
          >
            <ChatThreadsListMenuTooltip />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-44"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          {markAllReadAction.visible ? (
            <>
              <MarkAllReadMenuItem {...markAllReadAction} />
              <DropdownMenuSeparator />
            </>
          ) : null}
          <ChatThreadFilterMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

function ChatThreadsTitle({ showMarkAllRead }: { showMarkAllRead: boolean }) {
  const { t } = useTranslation();
  const { titleLabel } = useChatThreadsTitleLabels();
  const newChatAction = useNewChatAction();
  const newChatLabel = t(($) => {
    return $.chat.newChat;
  });
  const setCollapsed = useSet(setSessionListCollapsed$);
  const collapsed = useGet(sessionListCollapsed$);

  return (
    <div
      className="group flex h-8 shrink-0 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-state-hover transition-colors"
      onClick={() => {
        return setCollapsed(!collapsed);
      }}
    >
      <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-nav-copy-muted group-hover:text-nav-copy transition-colors">
        {titleLabel}
        <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <ChevronRight
            className={`opacity-35 ${collapsed ? "" : "rotate-90"}`}
            size={12}
          />
        </span>
      </span>
      <div className="flex items-center gap-0.5">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  newChatAction.onSelect("main");
                }}
                disabled={newChatAction.disabled}
                variant="quiet"
                size="icon-sm"
                iconSize="md"
                className="relative z-10 shrink-0"
                aria-label={newChatLabel}
              >
                <Plus size={18} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{newChatLabel}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <ChatThreadsListMenu showMarkAllRead={showMarkAllRead} />
      </div>
    </div>
  );
}

function ChatThreadsSkeleton() {
  return (
    <>
      {["w-3/4", "w-1/2", "w-2/3"].map((w) => {
        return (
          <div
            key={w}
            data-testid="sidebar-skeleton"
            className="flex h-8 items-center rounded-lg p-2"
          >
            <Skeleton className={`h-4 ${w}`} />
          </div>
        );
      })}
    </>
  );
}

function ChatThreadsContent({
  scrollSignals,
  contentClassName,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
}) {
  const collapsed = useGet(sessionListCollapsed$);

  if (collapsed) {
    return null;
  }

  return (
    <ExpandedChatThreadsContent
      scrollSignals={scrollSignals}
      contentClassName={contentClassName}
    />
  );
}

function AgentChatThreadsContent({
  currentMainThreadId,
  scrollSignals,
}: {
  currentMainThreadId: string | null;
  scrollSignals: SidebarChatThreadScrollSignals;
}) {
  const listLoadable = useLoadable(scrollSignals.list$);

  if (listLoadable.state === "loading") {
    return (
      <div className="flex flex-col gap-1">
        <ChatThreadsSkeleton />
      </div>
    );
  }
  if (listLoadable.state === "hasError") {
    return null;
  }

  return (
    <ResolvedAgentChatThreadsContent
      currentMainThreadId={currentMainThreadId}
      listSignals={listLoadable.data}
      scrollSignals={scrollSignals}
    />
  );
}

function ResolvedAgentChatThreadsContent({
  currentMainThreadId,
  listSignals,
  scrollSignals,
}: {
  currentMainThreadId: string | null;
  listSignals: SidebarChatThreadListSignals;
  scrollSignals: SidebarChatThreadScrollSignals;
}) {
  const currentMainThreadListed = useGet(listSignals.currentThreadListed$);
  const scrollCurrentChatThreadOnRef = useSet(
    scrollSignals.scrollCurrentChatThreadOnRef$,
  );

  return (
    <div className="flex flex-col gap-1">
      {currentMainThreadId && currentMainThreadListed ? (
        <span
          ref={scrollCurrentChatThreadOnRef}
          data-chat-thread-id={currentMainThreadId}
          hidden
        />
      ) : null}
      <ChatThreads listSignals={listSignals} />
    </div>
  );
}

function ExpandedChatThreadsContent({
  scrollSignals,
  contentClassName,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
}) {
  const { t } = useTranslation();
  const isScrolled = useGet(scrollSignals.isScrolled$);
  const currentMainThreadId = useGet(currentChatThreadId$);

  return (
    <OverlayScrollArea
      scrollSignals={scrollSignals}
      className="mt-1 min-h-0 flex-1"
      contentClassName={contentClassName}
      aria-label={t(($) => {
        return $.chat.sidebar.chatThreads;
      })}
      data-testid="sidebar-scroll-area"
      tabIndex={currentMainThreadId ? 0 : undefined}
      style={{
        boxShadow: isScrolled ? "0 -1px 0 0 hsl(var(--border) / 0.4)" : "none",
      }}
    >
      <AgentChatThreadsContent
        currentMainThreadId={currentMainThreadId}
        scrollSignals={scrollSignals}
      />
    </OverlayScrollArea>
  );
}
export function ChatThreadsSection({
  scrollSignals,
  contentClassName,
  showMarkAllRead = false,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
  showMarkAllRead?: boolean;
}) {
  const agentScope = useGet(currentChatAgentScope$);
  const mainStylesheetLoaded = useLastResolved(mainStylesheetLoaded$);

  return (
    <div className="mt-4 flex flex-col min-h-0 flex-1">
      <div className={contentClassName}>
        <ChatThreadsTitle
          key={agentScope ?? "no-agent"}
          showMarkAllRead={showMarkAllRead}
        />
      </div>
      {mainStylesheetLoaded && (
        <ChatThreadsContent
          scrollSignals={scrollSignals}
          contentClassName={contentClassName}
        />
      )}
    </div>
  );
}
