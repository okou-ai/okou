import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useSet,
  useLastResolved,
} from "ccstate-react";
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
  Archive,
  ArchiveRestore,
  BellOff,
  Bell,
} from "lucide-react";
import {
  ChatThreadStateText,
  useChatThreadsTitleLabels,
} from "./sidebar-shared.tsx";
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
import { deleteChatThread$ } from "../../signals/chat-page/chat-event.ts";
import { renameChatThreadFromInput$ } from "../../signals/chat-page/chat-thread-rename.ts";
import {
  createNewChatThread$,
  newChatThreadDisabled$,
  type NewChatThreadPane,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import {
  unreadSidebarChatThreadList$,
  type SidebarChatThreadListSignals,
  type SidebarChatThreadScrollSignals,
  type SidebarChatThreadWindow,
} from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import type { SidebarChatThreadItemSignals } from "../../signals/chat-page/sidebar-chat-thread-item.ts";
import { HoverScrollTitle } from "./hover-scroll-title.tsx";
import {
  currentChatAgentScope$,
  currentChatAgentId$,
  currentChatThreadId$,
  hasCurrentChatThread$,
} from "../../signals/agent-chat.ts";
import { setSidebarExpanded$ } from "../../signals/okou-page/nav.ts";
import { chatThreadOnlyArchived$ } from "../../signals/chat-page/chat-thread-only-archived.ts";
import { chatThreadOnlyMuted$ } from "../../signals/chat-page/chat-thread-only-muted.ts";
import { chatThreadOnlyUnread$ } from "../../signals/chat-page/chat-thread-only-unread.ts";
import {
  selectChatThreadFilter$,
  type ChatThreadFilter,
} from "../../signals/okou-page/chat-thread-filter-selection.ts";
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
import { ChatThreadMenuShortcut } from "./chat-thread-menu-shortcut.tsx";
import { equalArrays, equalSets } from "../../lib/equality.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

// The row glyphs draw at 17px, which the shared button base (`[&_svg]:size-4`)
// would otherwise clamp to 16px. Dimming stays on the individual glyphs so the
// state indicators keep their own contrast.
const CHAT_THREAD_ROW_ICON_CLASS = "[&_svg]:size-[17px]";
// One spatial cycle spans 12 rows: 200ms per row at the existing 2.4s cadence.
const RUNNING_INDICATOR_WAVE_ROWS = 12;
const CHAT_THREADS_CONTENT_ID = "sidebar-chat-threads-content";

// Labels never wrap: the menu grows past its minimum when a label shares its
// row with a long shortcut such as Ctrl+Shift+X.
function chatThreadMenuContentClassName(touch: boolean) {
  return cn(
    "min-w-56 whitespace-nowrap",
    touch && "[&_[role=menuitem]]:min-h-11",
  );
}

function equalSidebarChatThreadWindows(
  previous: SidebarChatThreadWindow,
  next: SidebarChatThreadWindow,
): boolean {
  return (
    previous.startIndex === next.startIndex &&
    previous.showAllChatsRow === next.showAllChatsRow &&
    equalArrays(previous.items, next.items, (left, right) => {
      return left === right;
    })
  );
}

function SessionStateIndicator({
  signals,
  rowIndex,
}: {
  signals: SidebarChatThreadItemSignals;
  rowIndex: number;
}) {
  const state = useLastResolved(signals.indicatorState$) ?? null;
  if (state === null) {
    return null;
  }
  if (state === "running") {
    return (
      <RunningIndicator phaseOffset={rowIndex / RUNNING_INDICATOR_WAVE_ROWS} />
    );
  }
  if (state === "muted") {
    return <BellOff size={16} className="opacity-35" />;
  }
  if (state === "unread") {
    return <span className="h-2 w-2 rounded-full bg-sky-600" />;
  }
  return (
    <span className="flex items-center justify-center text-sidebar-foreground">
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

function ChatThreadMarkUnreadMenuItem({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const muted = useGet(signals.muted$);
  const markUnread = useSet(signals.markUnread$);
  const pageSignal = useGet(pageSignal$);
  // A muted chat never shows as unread, so the action would change nothing.
  if (muted) {
    return null;
  }

  return (
    <DropdownMenuItem
      onClick={() => {
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

function ChatThreadArchiveMenuItem({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const archived = useGet(signals.archived$);
  const toggleArchived = useSet(signals.toggleArchived$);
  const pageSignal = useGet(pageSignal$);
  const label = archived
    ? t(($) => {
        return $.chat.sidebar.unarchive;
      })
    : t(($) => {
        return $.chat.sidebar.archive;
      });

  return (
    <DropdownMenuItem
      aria-label={label}
      aria-keyshortcuts={
        GLOBAL_KEYBOARD_SHORTCUTS.toggleChatArchive.ariaKeyShortcuts
      }
      onClick={() => {
        detach(toggleArchived(pageSignal), Reason.DomCallback);
      }}
    >
      {archived ? (
        <ArchiveRestore size={16} className="mr-2" />
      ) : (
        <Archive size={16} className="mr-2" />
      )}
      {label}
      <ChatThreadMenuShortcut
        shortcut={GLOBAL_KEYBOARD_SHORTCUTS.toggleChatArchive.binding}
      />
    </DropdownMenuItem>
  );
}

function ChatThreadMuteMenuItem({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const muted = useGet(signals.muted$);
  const toggleMuted = useSet(signals.toggleMuted$);
  const pageSignal = useGet(pageSignal$);
  const enabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadMuting] === true;
  // The API keeps suppressing a chat muted before the switch went off, so
  // unmuting stays available for as long as one exists.
  if (!enabled && !muted) {
    return null;
  }
  const label = muted
    ? t(($) => {
        return $.chat.sidebar.unmute;
      })
    : t(($) => {
        return $.chat.sidebar.mute;
      });
  return (
    <DropdownMenuItem
      aria-label={label}
      onClick={() => {
        detach(toggleMuted(pageSignal), Reason.DomCallback);
      }}
    >
      {muted ? (
        <Bell size={16} className="mr-2" />
      ) : (
        <BellOff size={16} className="mr-2" />
      )}
      {label}
    </DropdownMenuItem>
  );
}

function ChatThreadArchiveMenuSection({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const archiveEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] === true;
  if (!archiveEnabled) {
    return null;
  }
  return (
    <>
      <ChatThreadArchiveMenuItem signals={signals} />
      <DropdownMenuSeparator />
    </>
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
        onClick={() => {
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

function ChatThreadRenameMenuItem({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const openRename = useSet(signals.openRename$);
  const pageSignal = useGet(pageSignal$);
  const label = t(($) => {
    return $.chat.sidebar.rename;
  });

  return (
    <DropdownMenuItem
      aria-label={label}
      aria-keyshortcuts={GLOBAL_KEYBOARD_SHORTCUTS.renameChat.ariaKeyShortcuts}
      onClick={() => {
        detach(openRename(pageSignal), Reason.DomCallback);
      }}
    >
      <Pencil size={16} className="mr-2" />
      {label}
      <ChatThreadMenuShortcut
        shortcut={GLOBAL_KEYBOARD_SHORTCUTS.renameChat.binding}
      />
    </DropdownMenuItem>
  );
}

type ChatThreadMenuProps = {
  signals: SidebarChatThreadItemSignals;
  rowIndex: number;
  touch?: boolean;
};

function ChatThreadMenuTrigger({
  signals,
  rowIndex,
  touch = false,
}: ChatThreadMenuProps) {
  const { t } = useTranslation();
  const isPinned = useGet(signals.pinned$);
  const indicatorState = useLastResolved(signals.indicatorState$) ?? null;

  const showStateIndicator = indicatorState !== null;
  const showPinIndicator = isPinned && indicatorState === null;
  const hasRestingIndicator = showStateIndicator || showPinIndicator;

  return (
    <DropdownMenuTrigger
      render={
        <Button
          type="button"
          variant="quiet"
          size="icon-2xs"
          className={`group/thread-menu pointer-events-auto absolute left-1 top-1 cursor-pointer rounded-md ${touch ? "min-h-11 min-w-11" : ""} ${
            hasRestingIndicator
              ? ""
              : "md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
          } ${CHAT_THREAD_ROW_ICON_CLASS}`}
          aria-label={t(($) => {
            return $.chat.sidebar.openChatMenu;
          })}
          data-testid="chat-thread-menu-trigger"
          data-pinned={isPinned ? "true" : "false"}
        />
      }
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-testid={
                showPinIndicator ? "chat-thread-pinned-indicator" : undefined
              }
              className="flex items-center justify-center"
            >
              {hasRestingIndicator ? (
                <>
                  <span
                    aria-hidden="true"
                    data-testid="chat-thread-state-indicator"
                    className="flex items-center justify-center md:group-hover:hidden group-focus-visible/thread-menu:hidden md:group-data-[popup-open]/thread-menu:hidden"
                  >
                    {showStateIndicator ? (
                      <SessionStateIndicator
                        signals={signals}
                        rowIndex={rowIndex}
                      />
                    ) : (
                      <Pin size={17} className="opacity-70" />
                    )}
                  </span>
                  <Ellipsis
                    size={17}
                    className="hidden opacity-70 md:group-hover:block group-focus-visible/thread-menu:block md:group-data-[popup-open]/thread-menu:block"
                  />
                </>
              ) : (
                <Ellipsis size={17} className="opacity-70" />
              )}
            </span>
          }
        />
        <TooltipContent side="bottom">
          <p className="text-xs">
            {t(($) => {
              return $.chat.actions.more;
            })}
          </p>
        </TooltipContent>
      </Tooltip>
    </DropdownMenuTrigger>
  );
}

function ChatThreadMenuItems({
  signals,
}: Pick<ChatThreadMenuProps, "signals">) {
  const { t } = useTranslation();
  const requestDelete = useSet(signals.requestDelete$);

  return (
    <>
      <ChatThreadPinMenuItems signals={signals} />
      <ChatThreadMarkUnreadMenuItem signals={signals} />
      <ChatThreadMuteMenuItem signals={signals} />
      <ChatThreadArchiveMenuSection signals={signals} />
      <ChatThreadRenameMenuItem signals={signals} />
      <DropdownMenuItem
        onClick={() => {
          requestDelete();
        }}
        className="text-destructive focus:text-destructive"
      >
        <Trash size={16} className="mr-2" />
        {t(($) => {
          return $.chat.sidebar.delete;
        })}
      </DropdownMenuItem>
    </>
  );
}

function ChatThreadMenu({
  signals,
  rowIndex,
  touch = false,
}: ChatThreadMenuProps) {
  return (
    <TooltipProvider delay={200}>
      <DropdownMenu>
        <ChatThreadMenuTrigger
          signals={signals}
          rowIndex={rowIndex}
          touch={touch}
        />
        <DropdownMenuContent
          align="end"
          className={chatThreadMenuContentClassName(touch)}
          data-chat-thread-menu-thread-id={signals.threadId}
        >
          <ChatThreadMenuItems signals={signals} />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

function ChatThreadItemLink({
  signals,
  shortcutNumber,
  touch,
}: {
  signals: SidebarChatThreadItemSignals;
  shortcutNumber: number | undefined;
  touch: boolean;
}) {
  const { t } = useTranslation();
  const title = useGet(signals.title$);
  const isCurrentPage = useGet(signals.currentPage$);
  const isHighlighted = useGet(signals.highlighted$);
  const isUnread = useLastResolved(signals.unread$) ?? false;
  const indicatorState = useLastResolved(signals.indicatorState$) ?? null;
  const isPinned = useGet(signals.pinned$);
  const select = useSet(signals.select$);
  const inlineRenameEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadInlineRename] === true;
  const renaming = useGet(signals.inlineRenaming$);
  const startInlineRename = useSet(signals.startInlineRename$);

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
      onDoubleClick={
        inlineRenameEnabled
          ? (e) => {
              // Modified clicks open tabs or the side pane; renaming on top
              // of them would act twice for one gesture.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
                return;
              }
              startInlineRename();
            }
          : undefined
      }
      className={`col-span-2 col-start-1 row-start-1 grid grid-cols-subgrid items-center rounded-lg text-left leading-5 motion-safe:transition-colors motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${touch ? "h-14 pl-3 text-base" : "h-8 pl-2 text-sm"} ${
        isHighlighted
          ? "bg-state-selected text-sidebar-foreground font-medium"
          : isUnread
            ? "text-sidebar-foreground font-medium hover:bg-state-hover"
            : "text-sidebar-foreground hover:bg-state-hover"
      }`}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-2",
          touch ? "pr-12" : "pr-8",
          renaming && "invisible",
        )}
      >
        <ChatThreadListPaneIcon signals={signals} />
        <HoverScrollTitle
          data-slot="sidebar-thread-title"
          className="text-[color:var(--nav-copy,inherit)]"
          title={
            title ??
            t(($) => {
              return $.chat.newChat;
            })
          }
        />
        <ChatThreadStateText
          state={indicatorState ?? (isPinned ? "pinned" : null)}
        />
      </span>
      <span
        className={cn(
          "flex items-center pr-2 empty:hidden",
          renaming && "invisible",
        )}
      >
        <ThreadNumberShortcutHint shortcutNumber={shortcutNumber} />
      </span>
    </Link>
  );
}

function ChatThreadItemRename({
  signals,
  touch,
}: {
  signals: SidebarChatThreadItemSignals;
  touch: boolean;
}) {
  const renaming = useGet(signals.inlineRenaming$);
  return renaming ? (
    <ChatThreadItemRenameForm signals={signals} touch={touch} />
  ) : null;
}

/**
 * The row's title, edited where it stands. It lies over the link, which stays
 * mounted with its content hidden: the link keeps the row's background, and
 * Enter or Escape can hand focus back to it the way a dialog returns focus to
 * its trigger. The text keeps the title's x and weight, so entering the field
 * moves nothing; the ring is the row's own keyboard focus ring.
 */
function ChatThreadItemRenameForm({
  signals,
  touch,
}: {
  signals: SidebarChatThreadItemSignals;
  touch: boolean;
}) {
  const { t } = useTranslation();
  const title = useGet(signals.title$);
  const isHighlighted = useGet(signals.highlighted$);
  const isUnread = useLastResolved(signals.unread$) ?? false;
  const commitInlineRename = useSet(signals.commitInlineRename$);
  const cancelInlineRename = useSet(signals.cancelInlineRename$);
  const inlineRenameInputRef = useSet(signals.inlineRenameInputRef$);
  // The blur that commits is often the press of a click that opens another
  // chat, and that navigation aborts the page signal before the request can
  // be sent.
  const rootSignal = useGet(rootSignal$);

  // Enter and Escape both hand focus back to the row, so leaving the field is
  // the one place an edit is committed; Escape clears the edit first.
  function returnFocusToRow(form: HTMLFormElement) {
    form.parentElement
      ?.querySelector<HTMLElement>("[data-sidebar-chat-thread-id]")
      ?.focus();
  }

  return (
    <form
      className={cn(
        "col-span-2 col-start-1 row-start-1 flex min-w-0 items-center gap-2 rounded-lg text-sidebar-foreground ring-2 ring-inset ring-ring",
        touch ? "h-14 pl-3 pr-12 text-base" : "h-8 pl-2 pr-8 text-sm",
        (isHighlighted || isUnread) && "font-medium",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        returnFocusToRow(event.currentTarget);
      }}
      onKeyDown={(event) => {
        // The input method owns Enter and Escape while it composes. Safari can
        // end composition before the confirming keydown, which keyCode 229
        // still marks, so that Enter must not submit the half-typed title.
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
          if (event.key === "Enter") {
            event.preventDefault();
          }
          return;
        }
        if (event.key === "Escape") {
          cancelInlineRename();
          returnFocusToRow(event.currentTarget);
        }
      }}
    >
      <ChatThreadListPaneIcon signals={signals} />
      <input
        ref={inlineRenameInputRef}
        name="title"
        type="text"
        aria-label={t(($) => {
          return $.chat.sidebar.rename;
        })}
        placeholder={t(($) => {
          return $.chat.sidebar.titlePlaceholder;
        })}
        defaultValue={title ?? ""}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent p-0 leading-5 text-[color:var(--nav-copy,inherit)] outline-none placeholder:text-muted-foreground"
        onBlur={(event) => {
          detach(
            commitInlineRename(event.currentTarget.value, rootSignal),
            Reason.DomCallback,
          );
        }}
      />
    </form>
  );
}

export function ChatThreadItem({
  signals,
  shortcutNumber,
  rowIndex,
  touch = false,
}: {
  signals: SidebarChatThreadItemSignals;
  shortcutNumber: number | undefined;
  rowIndex: number;
  touch?: boolean;
}) {
  return (
    <div
      data-sidebar-chat-thread-row-id={signals.threadId}
      className="group relative grid grid-cols-[minmax(0,1fr)_auto] items-center"
    >
      <ChatThreadItemLink
        signals={signals}
        shortcutNumber={shortcutNumber}
        touch={touch}
      />
      <ChatThreadItemRename signals={signals} touch={touch} />
      <div
        className={cn(
          "pointer-events-none relative col-start-1 row-start-1 flex items-center justify-center justify-self-end",
          touch ? "h-14 w-12" : "h-8 w-8",
        )}
      >
        <ChatThreadMenu signals={signals} rowIndex={rowIndex} touch={touch} />
      </div>
    </div>
  );
}

function ChatThreadRenameDialog() {
  const renameDialogOpen = useGet(renameDialogOpen$);
  const closeRenameChatThreadDialog = useSet(closeRenameChatThreadDialog$);

  return (
    <Dialog
      open={renameDialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeRenameChatThreadDialog();
        }
      }}
    >
      <DialogContent finalFocus={false}>
        <ChatThreadRenameDialogBody />
      </DialogContent>
    </Dialog>
  );
}

function ChatThreadRenameDialogBody() {
  const { t } = useTranslation();
  const renameDialogThreadId = useGet(renameDialogThreadId$);
  const renameDialogAgentId = useGet(renameDialogAgentId$);
  const renameDialogInput = useGet(renameDialogInput$);
  const closeRenameChatThreadDialog = useSet(closeRenameChatThreadDialog$);
  const setRenameDialogInput = useSet(setRenameDialogInput$);
  const renameChatThreadFromInput = useSet(renameChatThreadFromInput$);
  const pageSignal = useGet(pageSignal$);

  function closeRenameDialog() {
    closeRenameChatThreadDialog();
  }

  function handleRename() {
    if (!renameDialogThreadId || !renameDialogInput.trim()) {
      return;
    }
    detach(
      renameChatThreadFromInput(
        {
          threadId: renameDialogThreadId,
          input: renameDialogInput,
          agentId: renameDialogAgentId,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
    closeRenameDialog();
  }

  return (
    <>
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
    </>
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
    <>
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
    </>
  );
}

function DeleteChatThreadDialog() {
  const pendingDeleteThreadId = useGet(pendingDeleteThreadId$);
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);

  return (
    <Dialog
      open={pendingDeleteThreadId !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPendingDeleteThreadId(null);
        }
      }}
    >
      <DialogContent>
        <DeleteChatThreadDialogBody />
      </DialogContent>
    </Dialog>
  );
}

function DeleteChatThreadDialogBody() {
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
    <DeleteChatThreadDialogContent
      onCancel={cancelDelete}
      onConfirm={confirmDelete}
    />
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

function useSelectChatThreadFilter() {
  const selectFilter = useSet(selectChatThreadFilter$);
  const pageSignal = useGet(pageSignal$);

  return (filter: ChatThreadFilter) => {
    detach(selectFilter(filter, pageSignal), Reason.DomCallback);
  };
}

// Switching filters is a secondary action, so it reads as neutral text rather
// than the brand link colour.
const CHAT_THREAD_FILTER_ACTION_CLASS_NAME =
  "font-normal text-nav-copy hover:text-nav-copy active:text-nav-copy/80 focus-visible:ring-inset focus-visible:ring-offset-0";

function ShowAllChatsRow() {
  const { t } = useTranslation();
  const selectFilter = useSelectChatThreadFilter();

  return (
    <div data-testid="sidebar-chat-show-all-row" className="pb-1">
      <Button
        type="button"
        variant="link"
        size="sm"
        className={cn(
          "w-full justify-start px-2 leading-5",
          CHAT_THREAD_FILTER_ACTION_CLASS_NAME,
        )}
        onClick={() => {
          selectFilter("all");
        }}
      >
        {t(($) => {
          return $.chat.sidebar.showAllChats;
        })}
      </Button>
    </div>
  );
}

// An empty list is one centred group: what is missing, then the way back.
function ChatThreadListEmptyState({
  message,
  action,
}: {
  message: string;
  action?: { readonly filter: ChatThreadFilter; readonly label: string };
}) {
  const selectFilter = useSelectChatThreadFilter();

  return (
    <div className="flex w-full flex-col items-center gap-1 px-4 py-4 text-center text-[13px] leading-5">
      <p className="text-nav-copy-muted">{message}</p>
      {action ? (
        <Button
          type="button"
          variant="link"
          className={cn(
            "h-auto p-0 text-[13px] leading-5",
            CHAT_THREAD_FILTER_ACTION_CLASS_NAME,
          )}
          onClick={() => {
            selectFilter(action.filter);
          }}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

function VirtualizedChatThreads({
  listSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
}) {
  const setShortcutRoot = useSet(setThreadListNumberShortcutRoot$);
  const searchOpen = useGet(threeColumnSearchOpen$);
  const rowCount = useGet(listSignals.rowCount$);
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
      style={{ height: rowCount * CHAT_THREAD_VIRTUAL_ROW_HEIGHT }}
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
              rowIndex={index}
              shortcutNumber={!searchOpen && index < 9 ? index + 1 : undefined}
            />
          </div>
        );
      })}
      {window.showAllChatsRow ? (
        <div
          data-index={rowCount - 1}
          data-testid="sidebar-chat-show-all-virtual-row"
          className="absolute left-0 top-0 w-full"
          style={{
            transform: `translateY(${
              (rowCount - 1) * CHAT_THREAD_VIRTUAL_ROW_HEIGHT
            }px)`,
          }}
        >
          <ShowAllChatsRow />
        </div>
      ) : null}
    </div>
  );
}

function ChatThreads({
  listSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
}) {
  const { t } = useTranslation();
  const archiveEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] === true;
  const archivedOnly = useGet(chatThreadOnlyArchived$);
  const mutedOnly = useGet(chatThreadOnlyMuted$);
  const threadCount = useGet(listSignals.count$);
  const hasHiddenArchivedThreads = useGet(
    listSignals.hasHiddenArchivedThreads$,
  );

  if (threadCount === 0) {
    const showAllChats = {
      filter: "all",
      label: t(($) => {
        return $.chat.sidebar.showAllChats;
      }),
    } as const;
    if (mutedOnly) {
      return (
        <ChatThreadListEmptyState
          message={t(($) => {
            return $.chat.sidebar.noMuted;
          })}
          action={showAllChats}
        />
      );
    }
    if (archiveEnabled && archivedOnly) {
      return (
        <ChatThreadListEmptyState
          message={t(($) => {
            return $.chat.sidebar.noArchived;
          })}
          action={showAllChats}
        />
      );
    }
    if (hasHiddenArchivedThreads) {
      return (
        <ChatThreadListEmptyState
          message={t(($) => {
            return $.chat.sidebar.inboxEmpty;
          })}
          action={{
            filter: "archived",
            label: t(($) => {
              return $.chat.sidebar.showArchivedChats;
            }),
          }}
        />
      );
    }
    return (
      <ChatThreadListEmptyState
        message={t(($) => {
          return $.chat.sidebar.empty;
        })}
      />
    );
  }
  return <VirtualizedChatThreads listSignals={listSignals} />;
}

function ChatThreadsListMenuTooltip() {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span>
            <Ellipsis size={18} />
          </span>
        }
      />
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
  const unreadAgentIds = useLastResolved(unreadAgentIds$, {
    equalityFn: equalSets,
  });
  const [markReadLoadable, markAgentThreadsRead] = useLoadableSet(
    markAgentThreadsRead$,
  );
  const pageSignal = useGet(pageSignal$);
  const markingRead = markReadLoadable.state === "loading";
  const visible = showMarkAllRead && currentChatAgentId !== null;
  // Keep the item mounted and toggle availability so the menu layout does
  // not jump when the unread state changes.
  const hasUnread =
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

  return { disabled: markingRead || !hasUnread, onSelect, visible };
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
    <DropdownMenuItem onClick={onSelect} disabled={disabled}>
      <CheckCheck size={16} className="mr-2" />
      {t(($) => {
        return $.sidebar.markAllRead;
      })}
    </DropdownMenuItem>
  );
}

function ChatThreadFilterMenuItems() {
  const { t } = useTranslation();
  const unreadOnly = useGet(chatThreadOnlyUnread$);
  const archivedOnly = useGet(chatThreadOnlyArchived$);
  const mutedOnly = useGet(chatThreadOnlyMuted$);
  const muteEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadMuting] === true;
  const selectFilter = useSelectChatThreadFilter();
  const archiveEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] === true;

  return (
    <>
      <DropdownMenuItem
        onClick={() => {
          selectFilter("all");
        }}
      >
        <Check
          size={16}
          className={`mr-2 ${unreadOnly || archivedOnly || mutedOnly ? "invisible" : ""}`}
        />
        {archiveEnabled
          ? t(($) => {
              return $.chat.sidebar.inbox;
            })
          : t(($) => {
              return $.chat.sidebar.allChats;
            })}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          selectFilter("unread");
        }}
        aria-keyshortcuts={
          GLOBAL_KEYBOARD_SHORTCUTS.toggleUnreadOnly.ariaKeyShortcuts
        }
      >
        <Check size={16} className={`mr-2 ${unreadOnly ? "" : "invisible"}`} />
        {t(($) => {
          return $.chat.sidebar.unreadOnly;
        })}
        <ChatThreadMenuShortcut
          shortcut={GLOBAL_KEYBOARD_SHORTCUTS.toggleUnreadOnly.binding}
        />
      </DropdownMenuItem>
      {archiveEnabled ? (
        <DropdownMenuItem
          onClick={() => {
            selectFilter("archived");
          }}
        >
          <Check
            size={16}
            className={`mr-2 ${archivedOnly ? "" : "invisible"}`}
          />
          {t(($) => {
            return $.chat.sidebar.archived;
          })}
        </DropdownMenuItem>
      ) : null}
      {muteEnabled ? (
        <DropdownMenuItem
          onClick={() => {
            selectFilter("muted");
          }}
        >
          <Check size={16} className={`mr-2 ${mutedOnly ? "" : "invisible"}`} />
          {t(($) => {
            return $.chat.sidebar.muted;
          })}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

export function ChatThreadsListMenu({
  showMarkAllRead,
  touch = false,
}: {
  showMarkAllRead: boolean;
  touch?: boolean;
}) {
  const { t } = useTranslation();
  const markAllReadAction = useMarkAllReadMenuAction(showMarkAllRead);
  return (
    <TooltipProvider delay={200}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              iconSize="md"
              className={cn("shrink-0", touch && "min-h-11 min-w-11")}
              aria-label={t(($) => {
                return $.chat.sidebar.openListMenu;
              })}
            />
          }
        >
          <ChatThreadsListMenuTooltip />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={chatThreadMenuContentClassName(touch)}
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

// With archiving on, a non-default filter names itself in the title so the list
// never looks like the inbox while it shows archived, unread, or muted chats.
function useChatThreadsFilteredTitleLabel() {
  const { t } = useTranslation();
  const { titleLabel } = useChatThreadsTitleLabels();
  const unreadOnly = useGet(chatThreadOnlyUnread$);
  const archivedOnly = useGet(chatThreadOnlyArchived$);
  const mutedOnly = useGet(chatThreadOnlyMuted$);
  const archiveEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadArchiving] === true;
  const filterLabel = unreadOnly
    ? t(($) => {
        return $.chat.sidebar.unreadOnly;
      })
    : archivedOnly
      ? t(($) => {
          return $.chat.sidebar.archived;
        })
      : mutedOnly
        ? t(($) => {
            return $.chat.sidebar.muted;
          })
        : null;
  if (!archiveEnabled || filterLabel === null) {
    return titleLabel;
  }
  return t(
    ($) => {
      return $.chat.sidebar.filteredTitle;
    },
    { filter: filterLabel, title: titleLabel },
  );
}

function NewChatThreadButton() {
  const { t } = useTranslation();
  const newChatAction = useNewChatAction();
  const newChatLabel = t(($) => {
    return $.chat.newChat;
  });

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              onClick={() => {
                newChatAction.onSelect("main");
              }}
              disabled={newChatAction.disabled}
              variant="quiet"
              size="icon-sm"
              iconSize="md"
              className="shrink-0"
              aria-label={newChatLabel}
            >
              <Plus size={18} />
            </Button>
          }
        />
        <TooltipContent side="bottom">
          <p className="text-xs">{newChatLabel}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ChatThreadsTitle({
  showMarkAllRead,
  contentId,
  collapsible,
}: {
  showMarkAllRead: boolean;
  contentId: string;
  collapsible: boolean;
}) {
  const titleLabel = useChatThreadsFilteredTitleLabel();
  const setCollapsed = useSet(setSessionListCollapsed$);
  const collapsed = useGet(sessionListCollapsed$);

  return (
    <div className="group flex h-8 shrink-0 items-center justify-between rounded-lg pr-0 hover:bg-state-hover transition-colors">
      {collapsible ? (
        <Button
          type="button"
          variant="quiet"
          size="sm"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={() => {
            setCollapsed(!collapsed);
          }}
          className="h-8 min-w-0 flex-1 cursor-pointer justify-start gap-1 px-2 text-[13px] leading-4 text-nav-copy-muted hover:bg-transparent hover:text-nav-copy active:bg-transparent group-hover:text-nav-copy [&_svg]:size-3"
        >
          <span className="min-w-0 truncate">{titleLabel}</span>
          <span className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <ChevronRight
              className={`opacity-35 ${collapsed ? "" : "rotate-90"}`}
            />
          </span>
        </Button>
      ) : (
        <span className="min-w-0 flex-1 truncate px-2 text-[13px] leading-4 text-nav-copy-muted">
          {titleLabel}
        </span>
      )}
      <div className="flex items-center gap-0.5">
        <NewChatThreadButton />
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
  contentId,
  stylesheetLoaded,
  collapsible,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
  contentId: string;
  stylesheetLoaded: boolean;
  collapsible: boolean;
}) {
  const savedCollapsed = useGet(sessionListCollapsed$);
  const collapsed = collapsible && savedCollapsed;

  // The region stays mounted so the title's `aria-controls` always resolves.
  // The attribute carries the collapsed state to assistive technology; the
  // display utility owns the cascade, because an author `display: flex` would
  // otherwise beat the user-agent `[hidden]` rule while expanded.
  return (
    <div
      id={contentId}
      hidden={collapsed}
      className={cn("min-h-0 flex-1 flex-col", collapsed ? "hidden" : "flex")}
    >
      {!collapsed && stylesheetLoaded ? (
        <ExpandedChatThreadsContent
          scrollSignals={scrollSignals}
          contentClassName={contentClassName}
        />
      ) : null}
    </div>
  );
}

function UnreadChatThreadScrollMarker({
  items,
  scrollSignals,
}: {
  items: readonly SidebarChatThreadItemSignals[];
  scrollSignals: SidebarChatThreadScrollSignals;
}) {
  const currentThreadId = useGet(currentChatThreadId$);
  const scrollCurrentChatThreadOnRef = useSet(
    scrollSignals.scrollCurrentChatThreadOnRef$,
  );
  const listed = items.some((item) => {
    return item.threadId === currentThreadId;
  });

  return currentThreadId && listed ? (
    <span
      ref={scrollCurrentChatThreadOnRef}
      data-chat-thread-id={currentThreadId}
      hidden
    />
  ) : null;
}

function UnreadChatThreadsContent({
  scrollSignals,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
}) {
  const { t } = useTranslation();
  const list = useLastLoadable(unreadSidebarChatThreadList$);
  const setShortcutRoot = useSet(setThreadListNumberShortcutRoot$);
  const searchOpen = useGet(threeColumnSearchOpen$);

  if (list.state === "loading") {
    return (
      <div className="flex flex-col gap-1">
        <ChatThreadsSkeleton />
      </div>
    );
  }
  if (list.state === "hasError") {
    return null;
  }
  if (list.data.items.length === 0) {
    return (
      <ChatThreadListEmptyState
        message={t(($) => {
          return $.chat.sidebar.noUnread;
        })}
        action={{
          filter: "all",
          label: t(($) => {
            return $.chat.sidebar.showAllChats;
          }),
        }}
      />
    );
  }

  return (
    <div ref={setShortcutRoot} className="w-full">
      <UnreadChatThreadScrollMarker
        items={list.data.items}
        scrollSignals={scrollSignals}
      />
      {list.data.items.map((signals, index) => {
        return (
          <div key={signals.threadId} className="pb-1">
            <ChatThreadItem
              signals={signals}
              rowIndex={index}
              shortcutNumber={!searchOpen && index < 9 ? index + 1 : undefined}
            />
          </div>
        );
      })}
      <ShowAllChatsRow />
    </div>
  );
}

function AllChatThreadsContent({
  scrollSignals,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
}) {
  const listLoadable = useLastLoadable(scrollSignals.list$);

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
      listSignals={listLoadable.data}
      scrollSignals={scrollSignals}
    />
  );
}

function CurrentChatThreadScrollMarker({
  listSignals,
  scrollSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
  scrollSignals: SidebarChatThreadScrollSignals;
}) {
  const currentMainThreadId = useGet(currentChatThreadId$);
  const currentMainThreadListed = useGet(listSignals.currentThreadListed$);
  const scrollCurrentChatThreadOnRef = useSet(
    scrollSignals.scrollCurrentChatThreadOnRef$,
  );

  return currentMainThreadId && currentMainThreadListed ? (
    <span
      ref={scrollCurrentChatThreadOnRef}
      data-chat-thread-id={currentMainThreadId}
      hidden
    />
  ) : null;
}

function ResolvedAgentChatThreadsContent({
  listSignals,
  scrollSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
  scrollSignals: SidebarChatThreadScrollSignals;
}) {
  return (
    <div className="flex flex-col gap-1">
      <CurrentChatThreadScrollMarker
        listSignals={listSignals}
        scrollSignals={scrollSignals}
      />
      <ChatThreads listSignals={listSignals} />
    </div>
  );
}

function ChatThreadsViewport({
  scrollSignals,
  contentClassName,
  children,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const isScrolled = useGet(scrollSignals.isScrolled$);
  const hasCurrentChatThread = useGet(hasCurrentChatThread$);

  return (
    <OverlayScrollArea
      scrollSignals={scrollSignals}
      className="mt-1 min-h-0 flex-1"
      // Keep the viewport's previous shadow precedence when it receives focus.
      viewportClassName={
        isScrolled
          ? "[box-shadow:0_-1px_0_0_hsl(var(--border)/0.4)]!"
          : "[box-shadow:none]!"
      }
      contentClassName={contentClassName}
      aria-label={t(($) => {
        return $.chat.sidebar.chatThreads;
      })}
      data-testid="sidebar-scroll-area"
      tabIndex={hasCurrentChatThread ? 0 : undefined}
    >
      {children}
    </OverlayScrollArea>
  );
}

function ExpandedChatThreadsContent({
  scrollSignals,
  contentClassName,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
}) {
  const unreadOnly = useGet(chatThreadOnlyUnread$);

  return (
    <ChatThreadsViewport
      scrollSignals={scrollSignals}
      contentClassName={contentClassName}
    >
      {unreadOnly ? (
        <UnreadChatThreadsContent scrollSignals={scrollSignals} />
      ) : (
        <AllChatThreadsContent scrollSignals={scrollSignals} />
      )}
    </ChatThreadsViewport>
  );
}
export function ChatThreadsSection({
  scrollSignals,
  contentClassName,
  showMarkAllRead = false,
  collapsible = true,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
  showMarkAllRead?: boolean;
  collapsible?: boolean;
}) {
  const agentScope = useGet(currentChatAgentScope$);
  const mainStylesheetLoaded = useLastResolved(mainStylesheetLoaded$);

  return (
    <div className="mt-4 flex flex-col min-h-0 flex-1">
      <div className={contentClassName}>
        <ChatThreadsTitle
          key={agentScope ?? "no-agent"}
          showMarkAllRead={showMarkAllRead}
          contentId={CHAT_THREADS_CONTENT_ID}
          collapsible={collapsible}
        />
      </div>
      <ChatThreadsContent
        scrollSignals={scrollSignals}
        contentClassName={contentClassName}
        contentId={CHAT_THREADS_CONTENT_ID}
        stylesheetLoaded={mainStylesheetLoaded === true}
        collapsible={collapsible}
      />
    </div>
  );
}
