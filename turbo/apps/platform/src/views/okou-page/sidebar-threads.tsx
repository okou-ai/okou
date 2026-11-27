import {
  draggingProjectThread$,
  endProjectThreadDrag$,
  moveDraggedProjectThread$,
  PROJECT_THREAD_DRAG_TYPE,
  projectThreadDragEventsRef$,
  startProjectThreadDrag$,
} from "../../signals/projects/project-thread-drag.ts";
import {
  ProjectCreateButton,
  ProjectRow,
  ProjectStatusRow,
  type ProjectRowLayout,
} from "../projects/project-row.tsx";
import { ProjectThreadDragHint } from "../projects/project-thread-drag-hint.tsx";
import { useProjectThreadDropTarget } from "../projects/project-thread-drop-target.tsx";
import {
  openProjectMembership$,
  projectDialog$,
  projectThreadMenuOpenChanged$,
} from "../../signals/projects/project-ui.ts";
import type {
  CSSProperties,
  ComponentProps,
  ReactNode,
  RefCallback,
} from "react";
import {
  useGet,
  useLastLoadable,
  useSet,
  useLastResolved,
  useResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Plus,
  CheckCheck,
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
  FolderInput,
  GitFork,
} from "lucide-react";
import {
  ChatThreadStateIndicator,
  ChatThreadStateText,
  useChatThreadsTitleLabels,
  useChatListFilterOptions,
} from "./sidebar-shared.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Button,
  Input,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
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
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";
import { forkChatThread$ } from "../../signals/chat-page/chat-thread-fork.ts";
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
  unreadSidebarChatThreadRows$,
  type SidebarChatThreadListSignals,
  type SidebarChatThreadRow,
  type SidebarChatThreadScrollSignals,
  getSidebarChatThreadWindow,
  type SidebarChatThreadWindow,
} from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import type { SidebarChatThreadItemSignals } from "../../signals/chat-page/sidebar-chat-thread-item.ts";
import { HoverScrollTitle } from "./hover-scroll-title.tsx";
import { ForYouChatListRow, OkouChatListRow } from "./sidebar-okou-row.tsx";
import { useTitleReveal } from "./use-title-reveal.ts";
import {
  currentChatThreadId$,
  hasCurrentChatThread$,
} from "../../signals/chat-thread-list.ts";
import {
  activeChatThreadFilter$,
  chatThreadFilter$,
  type ChatThreadFilter,
} from "../../signals/okou-page/chat-thread-filter.ts";
import { selectChatThreadFilter$ } from "../../signals/okou-page/chat-thread-filter-selection.ts";
import {
  markWorkspaceThreadsRead$,
  workspaceHasUnreadChats$,
} from "../../signals/chat-page/sidebar-unread-threads.ts";
import {
  closeRenameChatThreadDialog$,
  pendingDeleteThreadId$,
  renameDialogOpen$,
  setPendingDeleteThreadId$,
  renameDialogThreadId$,
  renameDialogInput$,
  setRenameDialogInput$,
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  threeColumnSearchOpen$,
} from "../../signals/okou-page/sidebar-state.ts";
import { setThreadListNumberShortcutRoot$ } from "../../signals/okou-page/thread-list-number-shortcuts.ts";
import { ThreadNumberShortcutHint } from "./thread-number-shortcut-hint.tsx";
import { Link } from "../router/link.tsx";
import { OverlayScrollArea } from "./sidebar-scroll.tsx";
import { ThreadPinMoveMenuItems } from "./sidebar-thread-reorder.tsx";
import { ChatThreadMenuShortcut } from "./chat-thread-menu-shortcut.tsx";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";

// The row glyphs draw at 17px, which the shared button base (`[&_svg]:size-4`)
// would otherwise clamp to 16px. Dimming stays on the individual glyphs so the
// state indicators keep their own contrast.
const CHAT_THREAD_ROW_ICON_CLASS = "[&_svg]:size-[17px]";

// Labels never wrap: the menu grows past its minimum when a label shares its
// row with a long shortcut such as Ctrl+Shift+X.
function chatThreadMenuContentClassName(touch: boolean) {
  return cn(
    "min-w-56 whitespace-nowrap",
    touch && "[&_[role=menuitem]]:min-h-11 [&_[role=menuitemradio]]:min-h-11",
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
      <MessageSquareDot size={16} />
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
        GLOBAL_KEYBOARD_SHORTCUTS.toggleArchive.ariaKeyShortcuts
      }
      onClick={() => {
        detach(toggleArchived(pageSignal), Reason.DomCallback);
      }}
    >
      {archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
      {label}
      <ChatThreadMenuShortcut
        shortcut={GLOBAL_KEYBOARD_SHORTCUTS.toggleArchive.binding}
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
      {muted ? <Bell size={16} /> : <BellOff size={16} />}
      {label}
    </DropdownMenuItem>
  );
}

function ChatThreadArchiveMenuSection({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
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
        {isPinned ? <PinOff size={16} /> : <Pin size={16} />}
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
    return $.chat.actions.rename;
  });

  return (
    <DropdownMenuItem
      aria-label={label}
      aria-keyshortcuts={GLOBAL_KEYBOARD_SHORTCUTS.rename.ariaKeyShortcuts}
      onClick={() => {
        detach(openRename(pageSignal), Reason.DomCallback);
      }}
    >
      <Pencil size={16} />
      {label}
      <ChatThreadMenuShortcut
        shortcut={GLOBAL_KEYBOARD_SHORTCUTS.rename.binding}
      />
    </DropdownMenuItem>
  );
}

type ChatThreadMenuProps = {
  signals: SidebarChatThreadItemSignals;
  rowIndex: number;
  touch?: boolean;
};

function ChatThreadMenuButton({
  signals,
  touch = false,
  className,
  ...props
}: ComponentProps<typeof Button> &
  Pick<ChatThreadMenuProps, "signals" | "touch">) {
  const { t } = useTranslation();
  const isPinned = useGet(signals.pinned$);
  const indicatorState = useLastResolved(signals.indicatorState$) ?? null;
  const hasRestingIndicator = indicatorState !== null || isPinned;

  return (
    <Button
      {...props}
      type="button"
      variant="quiet"
      size="icon-2xs"
      className={cn(
        `group/thread-menu pointer-events-auto absolute left-1 top-1 rounded-md ${touch ? "min-h-11 min-w-11" : ""} ${
          hasRestingIndicator
            ? ""
            : "md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
        } ${CHAT_THREAD_ROW_ICON_CLASS}`,
        className,
      )}
      aria-label={t(($) => {
        return $.chat.sidebar.openChatMenu;
      })}
      data-testid="chat-thread-menu-trigger"
      data-pinned={isPinned ? "true" : "false"}
    />
  );
}

function ChatThreadMenuGlyph({
  signals,
  rowIndex,
  className,
  ...props
}: ComponentProps<"span"> & Pick<ChatThreadMenuProps, "signals" | "rowIndex">) {
  const isPinned = useGet(signals.pinned$);
  const indicatorState = useLastResolved(signals.indicatorState$) ?? null;

  const showStateIndicator = indicatorState !== null;
  const showPinIndicator = isPinned && indicatorState === null;
  const hasRestingIndicator = showStateIndicator || showPinIndicator;

  return (
    <span
      {...props}
      data-testid={
        showPinIndicator ? "chat-thread-pinned-indicator" : undefined
      }
      className={cn("flex items-center justify-center", className)}
    >
      {hasRestingIndicator ? (
        <>
          <span
            aria-hidden="true"
            data-testid="chat-thread-state-indicator"
            className="flex items-center justify-center md:group-hover:hidden group-focus-visible/thread-menu:hidden md:group-data-[popup-open]/thread-menu:hidden"
          >
            {showStateIndicator ? (
              <ChatThreadStateIndicator
                state={indicatorState}
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
  );
}

function ChatThreadMenuTrigger({
  signals,
  rowIndex,
  touch = false,
}: ChatThreadMenuProps) {
  const { t } = useTranslation();

  return (
    <DropdownMenuTrigger
      render={<ChatThreadMenuButton signals={signals} touch={touch} />}
    >
      <Tooltip>
        <TooltipTrigger
          render={<ChatThreadMenuGlyph signals={signals} rowIndex={rowIndex} />}
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
  const move = useSet(openProjectMembership$);
  const fork = useSet(forkChatThread$);
  const pageSignal = useGet(pageSignal$);
  const forkEnabled =
    useResolved(featureSwitches$)?.[FeatureSwitchKey.ChatThreadFork];

  return (
    <>
      <ChatThreadPinMenuItems signals={signals} />
      <ChatThreadMarkUnreadMenuItem signals={signals} />
      <ChatThreadMuteMenuItem signals={signals} />
      <ChatThreadArchiveMenuSection signals={signals} />
      {forkEnabled && (
        <DropdownMenuItem
          onClick={() => {
            detach(fork(signals.threadId, pageSignal), Reason.DomCallback);
          }}
        >
          <GitFork size={16} />
          {t(($) => {
            return $.chat.fork.action;
          })}
        </DropdownMenuItem>
      )}
      <ChatThreadRenameMenuItem signals={signals} />
      <DropdownMenuItem
        onClick={() => {
          move(signals.threadId);
        }}
      >
        <FolderInput size={16} />
        {t(($) => {
          return $.projects.move;
        })}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          requestDelete();
        }}
        className="text-destructive focus:text-destructive"
      >
        <Trash size={16} />
        {t(($) => {
          return $.chat.actions.delete;
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
  const projectDialog = useGet(projectDialog$);

  const menuOpenChanged = useSet(projectThreadMenuOpenChanged$);
  return (
    <TooltipProvider delay={200}>
      <DropdownMenu
        onOpenChange={(open, details) => {
          menuOpenChanged(signals.threadId, open, details.trigger);
        }}
      >
        <ChatThreadMenuTrigger
          signals={signals}
          rowIndex={rowIndex}
          touch={touch}
        />
        <DropdownMenuContent
          align="end"
          className={chatThreadMenuContentClassName(touch)}
          // The Project picker/editor owns focus after this menu hands it off.
          finalFocus={projectDialog ? false : undefined}
          data-chat-thread-menu-thread-id={signals.threadId}
        >
          <ChatThreadMenuItems signals={signals} />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

function ChatThreadItemStateText({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const indicatorState = useLastResolved(signals.indicatorState$) ?? null;
  const isPinned = useGet(signals.pinned$);
  return (
    <ChatThreadStateText
      state={indicatorState ?? (isPinned ? "pinned" : null)}
    />
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
  const select = useSet(signals.select$);
  const renaming = useGet(signals.inlineRenaming$);
  const startInlineRename = useSet(signals.startInlineRename$);

  const draggingThread = useGet(draggingProjectThread$);
  const startDrag = useSet(startProjectThreadDrag$);
  const endDrag = useSet(endProjectThreadDrag$);
  const draggable = !touch && !renaming;
  const titleReveal = useTitleReveal();

  return (
    <Link
      {...titleReveal}
      pathname="/chats/:threadId"
      options={{
        pathParams: { threadId: signals.threadId },
      }}
      aria-current={isCurrentPage ? "page" : undefined}
      data-sidebar-chat-thread-id={signals.threadId}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable || !startDrag(signals.threadId)) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.clearData();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(PROJECT_THREAD_DRAG_TYPE, signals.threadId);
      }}
      onDragEnd={endDrag}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          return;
        }
        if (select(e.altKey ? "sidebar" : "main")) {
          e.preventDefault();
        }
      }}
      onDoubleClick={(e) => {
        // Modified clicks open tabs or the side pane; renaming on top
        // of them would act twice for one gesture.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
          return;
        }
        startInlineRename();
      }}
      className={`col-span-2 col-start-1 row-start-1 grid grid-cols-subgrid items-center rounded-lg text-left leading-5 motion-safe:transition-colors motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${touch ? "h-14 pl-3 text-base" : "h-8 pl-2 text-sm"} ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${draggingThread?.id === signals.threadId ? "opacity-40" : ""} ${
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
        <ChatThreadItemStateText signals={signals} />
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

function ChatThreadFilterAction({
  filter,
  label,
}: {
  readonly filter: ChatThreadFilter;
  readonly label: string;
}) {
  const selectFilter = useSelectChatThreadFilter();

  return (
    <div className="flex flex-col gap-2.5 pb-1 pt-2.5">
      <div aria-hidden="true" className="mx-2 h-px bg-divider" />
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="w-full justify-start px-2 font-normal leading-5 pointer-coarse:min-h-11 text-nav-copy-muted hover:text-nav-copy active:text-nav-copy/80 focus-visible:ring-inset focus-visible:ring-offset-0"
        onClick={() => {
          selectFilter(filter);
        }}
      >
        {label}
      </Button>
    </div>
  );
}

function ShowAllChatsRow() {
  const { showAll } = useChatListFilterOptions();
  return (
    <div data-testid="sidebar-chat-show-all-row">
      <ChatThreadFilterAction {...showAll} />
    </div>
  );
}

function ChatThreadListEmptyState({
  message,
  action,
}: {
  message: string;
  action?: { readonly filter: ChatThreadFilter; readonly label: string };
}) {
  return (
    <div className="w-full">
      <p className="px-2 py-2 text-sm leading-5 text-nav-copy-muted">
        {message}
      </p>
      {action ? <ChatThreadFilterAction {...action} /> : null}
    </div>
  );
}

/** The inbox is empty only when it lists neither Projects nor chats. */
function InboxEmptyState({
  listSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
}) {
  const { t } = useTranslation();
  const { emptyUnarchivedLabel, showWithArchived } = useChatListFilterOptions();
  const hasHiddenArchivedThreads =
    useLastResolved(listSignals.hasHiddenArchivedThreads$) ?? false;

  if (hasHiddenArchivedThreads) {
    return (
      <ChatThreadListEmptyState
        message={emptyUnarchivedLabel}
        action={showWithArchived}
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

function VirtualizedChatThreads({
  listSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
}) {
  const setShortcutRoot = useSet(setThreadListNumberShortcutRoot$);
  const searchOpen = useGet(threeColumnSearchOpen$);

  // Only list rows have a fixed height. Keep the filter action in normal flow
  // so its divider and spacing remain reachable at the end of a long list.
  return (
    <div ref={setShortcutRoot} className="w-full">
      <ChatThreadListRows
        listSignals={listSignals}
        rowHeight={CHAT_THREAD_VIRTUAL_ROW_HEIGHT}
        touch={false}
        layout="sidebar"
        shortcuts={!searchOpen}
      />
      {listSignals.showAllChatsRow ? <ShowAllChatsRow /> : null}
    </div>
  );
}

function ChatThreads({
  listSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
}) {
  const { t } = useTranslation();
  const filter = useResolved(activeChatThreadFilter$);
  const { showAll } = useChatListFilterOptions();
  const rowCount = useLastResolved(listSignals.count$);
  if (rowCount === undefined) {
    return null;
  }

  if (rowCount === 0) {
    if (filter === "muted") {
      return (
        <ChatThreadListEmptyState
          message={t(($) => {
            return $.chat.sidebar.noMuted;
          })}
          action={showAll}
        />
      );
    }
    if (filter === "archived") {
      return (
        <ChatThreadListEmptyState
          message={t(($) => {
            return $.chat.sidebar.noArchived;
          })}
          action={showAll}
        />
      );
    }
    return <InboxEmptyState listSignals={listSignals} />;
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
  const createNewChat = useSet(createNewChatThread$);
  const rootSignal = useGet(rootSignal$);
  const newChatDisabled = useGet(newChatThreadDisabled$);

  function onSelect(pane: NewChatThreadPane) {
    detach(createNewChat({}, pane, rootSignal), Reason.DomCallback);
  }

  return {
    disabled: newChatDisabled,
    onSelect,
  };
}

function useMarkAllReadMenuAction(showMarkAllRead: boolean) {
  const [markReadLoadable, markWorkspaceThreadsRead] = useLoadableSet(
    markWorkspaceThreadsRead$,
  );
  const pageSignal = useGet(pageSignal$);

  function onSelect() {
    detach(markWorkspaceThreadsRead(pageSignal), Reason.DomCallback);
  }

  return {
    disabled: markReadLoadable.state === "loading",
    onSelect,
    visible: showMarkAllRead,
  };
}

function MarkAllReadMenuItem({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("common");
  const hasUnread = useLastResolved(workspaceHasUnreadChats$) ?? false;

  return (
    <DropdownMenuItem onClick={onSelect} disabled={disabled || !hasUnread}>
      <CheckCheck size={16} />
      {t(($) => {
        return $.sidebar.markAllRead;
      })}
    </DropdownMenuItem>
  );
}

function ChatThreadFilterMenuItems() {
  const { t } = useTranslation();
  const filter = useGet(chatThreadFilter$);
  const { unarchivedLabel, withArchivedLabel } = useChatListFilterOptions();
  const selectFilter = useSelectChatThreadFilter();

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>
        {t(($) => {
          return $.chat.sidebar.filter;
        })}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={filter}
        onValueChange={(next: ChatThreadFilter) => {
          selectFilter(next);
        }}
      >
        <DropdownMenuRadioItem value="unarchived" closeOnClick>
          {unarchivedLabel}
          <DropdownMenuRadioItemIndicator />
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          value="unread"
          closeOnClick
          aria-keyshortcuts={
            GLOBAL_KEYBOARD_SHORTCUTS.toggleUnreadOnly.ariaKeyShortcuts
          }
        >
          {t(($) => {
            return $.chat.sidebar.unreadOnly;
          })}
          <ChatThreadMenuShortcut
            shortcut={GLOBAL_KEYBOARD_SHORTCUTS.toggleUnreadOnly.binding}
          />
          <DropdownMenuRadioItemIndicator className="ml-0" />
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="muted" closeOnClick>
          {t(($) => {
            return $.chat.sidebar.muted;
          })}
          <DropdownMenuRadioItemIndicator />
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="withArchived" closeOnClick>
          {withArchivedLabel}
          <DropdownMenuRadioItemIndicator />
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
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
          <ChatThreadFilterMenuItems />
          {markAllReadAction.visible ? (
            <>
              <DropdownMenuSeparator />
              <MarkAllReadMenuItem {...markAllReadAction} />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

/** Only non-default filters add a label to the chat list title. */
export function useChatThreadsFilterLabel(): string | null {
  const { t } = useTranslation();
  const { withArchivedLabel } = useChatListFilterOptions();
  const filter = useGet(chatThreadFilter$);
  switch (filter) {
    case "unread": {
      return t(($) => {
        return $.chat.sidebar.unreadOnly;
      });
    }
    case "withArchived": {
      return withArchivedLabel;
    }
    case "muted": {
      return t(($) => {
        return $.chat.sidebar.muted;
      });
    }
    case "unarchived": {
      return null;
    }
  }
}

function useChatThreadsFilteredTitleLabel() {
  const { t } = useTranslation();
  const { titleLabel } = useChatThreadsTitleLabels();
  const filterLabel = useChatThreadsFilterLabel();
  if (filterLabel === null) {
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

function ChatThreadsTitle({ showMarkAllRead }: { showMarkAllRead: boolean }) {
  const titleLabel = useChatThreadsFilteredTitleLabel();

  return (
    <div className="group flex h-8 shrink-0 items-center justify-between rounded-lg pr-0 hover:bg-state-hover transition-colors">
      <span className="min-w-0 flex-1 truncate px-2 text-[13px] font-medium leading-4 text-nav-copy-muted">
        {titleLabel}
      </span>
      <div className="flex items-center gap-0.5">
        <ProjectCreateButton />
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
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
}) {
  const stylesheetLoaded = useLastResolved(mainStylesheetLoaded$);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {stylesheetLoaded ? (
        <ExpandedChatThreadsContent
          scrollSignals={scrollSignals}
          contentClassName={contentClassName}
        />
      ) : null}
    </div>
  );
}

function UnreadChatThreadScrollMarker({
  rows,
  scrollSignals,
}: {
  rows: readonly SidebarChatThreadRow[];
  scrollSignals: SidebarChatThreadScrollSignals;
}) {
  const currentThreadId = useGet(currentChatThreadId$);
  const scrollCurrentChatThreadOnRef = useSet(
    scrollSignals.scrollCurrentChatThreadOnRef$,
  );
  const listed = rows.some((row) => {
    return row.kind === "thread" && row.threadId === currentThreadId;
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
  const { showAll } = useChatListFilterOptions();
  const rows = useLastLoadable(unreadSidebarChatThreadRows$);
  const setShortcutRoot = useSet(setThreadListNumberShortcutRoot$);
  const searchOpen = useGet(threeColumnSearchOpen$);

  if (rows.state === "loading") {
    return (
      <div className="flex flex-col gap-1">
        <ChatThreadsSkeleton />
      </div>
    );
  }
  if (rows.state === "hasError") {
    return null;
  }
  if (rows.data.length === 0) {
    return (
      <ChatThreadListEmptyState
        message={t(($) => {
          return $.chat.sidebar.noUnread;
        })}
        action={showAll}
      />
    );
  }

  return (
    <div ref={setShortcutRoot} className="w-full">
      <UnreadChatThreadScrollMarker
        rows={rows.data}
        scrollSignals={scrollSignals}
      />
      <ChatThreadListRowsView
        rows={rows.data}
        startIndex={0}
        rowHeight={null}
        touch={false}
        layout="sidebar"
        shortcuts={!searchOpen}
      />
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

interface CurrentChatThreadScrollMarkerProps {
  listSignals: SidebarChatThreadListSignals;
  scrollSignals: SidebarChatThreadScrollSignals;
}

function CurrentChatThreadScrollMarker(
  props: CurrentChatThreadScrollMarkerProps,
) {
  const currentMainThreadId = useGet(currentChatThreadId$);
  return currentMainThreadId ? (
    <ListedChatThreadScrollMarker
      {...props}
      currentMainThreadId={currentMainThreadId}
    />
  ) : null;
}

function ListedChatThreadScrollMarker({
  listSignals,
  scrollSignals,
  currentMainThreadId,
}: CurrentChatThreadScrollMarkerProps & { currentMainThreadId: string }) {
  const currentMainThreadListed = useLastResolved(
    listSignals.currentThreadListed$,
  );
  const scrollCurrentChatThreadOnRef = useSet(
    scrollSignals.scrollCurrentChatThreadOnRef$,
  );

  return currentMainThreadListed ? (
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
  const [moving, move] = useLoadableSet(moveDraggedProjectThread$);
  const signal = useGet(rootSignal$);
  const drop = useProjectThreadDropTarget({
    projectId: null,
    touch: false,
    moving: moving.state === "loading",
    moveHere(projectId) {
      detach(move(projectId, signal), Reason.DomCallback);
    },
  });

  return (
    <div {...drop.props} className="mt-1 flex min-h-0 flex-1 flex-col">
      <OverlayScrollArea
        scrollSignals={scrollSignals}
        className="min-h-0 flex-1"
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
      {moving.state === "hasError" && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {t(($) => {
            return $.projects.moveError;
          })}
        </p>
      )}
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
  const unreadOnly = useGet(chatThreadFilter$) === "unread";

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
  showTitle = true,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
  showMarkAllRead?: boolean;
  /** False when the surrounding header already carries the title actions. */
  showTitle?: boolean;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", showTitle && "mt-4")}>
      {showTitle ? (
        <div className={contentClassName}>
          <ChatThreadsTitle showMarkAllRead={showMarkAllRead} />
        </div>
      ) : null}
      {/* Okou's entry leads the list and stays outside its scroll viewport,
          whose virtual rows start at the viewport's top. */}
      <div className={cn("flex flex-col gap-1 empty:hidden", contentClassName)}>
        <OkouChatListRow />
        <ForYouChatListRow />
      </div>
      <ChatThreadsContent
        scrollSignals={scrollSignals}
        contentClassName={contentClassName}
      />
    </div>
  );
}

function ChatThreadListRowContent({
  row,
  index,
  touch,
  layout,
  shortcuts,
}: {
  row: SidebarChatThreadRow;
  index: number;
  touch: boolean;
  layout: ProjectRowLayout;
  shortcuts: boolean;
}) {
  if (row.kind === "project") {
    return (
      <ProjectRow row={row} rowIndex={index} touch={touch} layout={layout} />
    );
  }
  if (row.kind !== "thread") {
    return <ProjectStatusRow row={row} layout={layout} />;
  }
  return (
    <ChatThreadItem
      signals={row.signals}
      rowIndex={index}
      // Number shortcuts address the chats outside Projects.
      shortcutNumber={
        shortcuts && row.listIndex !== null && row.listIndex < 9
          ? row.listIndex + 1
          : undefined
      }
      touch={touch}
    />
  );
}

function ChatThreadListRowFrame({
  row,
  index,
  rowHeight,
  touch,
  moving,
  moveHere,
  children,
}: {
  row: SidebarChatThreadRow;
  index: number;
  /** Virtual rows keep their fixed geometry while stacking in normal flow. */
  rowHeight: number | null;
  touch: boolean;
  moving: boolean;
  moveHere: (projectId: string | null) => void;
  children: ReactNode;
}) {
  const drop = useProjectThreadDropTarget({
    projectId: row.projectId,
    touch,
    moving,
    moveHere,
  });
  return (
    <div
      {...drop.props}
      data-index={index}
      data-testid={
        rowHeight === null ? undefined : "sidebar-chat-thread-virtual-row"
      }
      data-project-row-id={row.projectId ?? undefined}
      data-project-drop-target={drop.targeted ? "" : undefined}
      className={cn(
        "w-full pb-1",
        row.projectId !== null && row.kind !== "project" && "pl-6",
        drop.targeted && "bg-state-hover",
        drop.targeted && row.projectId === null && "rounded-lg",
        drop.targeted && row.kind === "project" && "rounded-t-lg",
        drop.targeted && row.projectEnd && "rounded-b-lg",
      )}
      style={rowHeight === null ? undefined : { height: rowHeight }}
    >
      {children}
    </div>
  );
}

interface RenderedChatThreadGroup {
  readonly key: string;
  readonly projectId: string | null;
  readonly rows: {
    readonly row: SidebarChatThreadRow;
    readonly index: number;
  }[];
}

/** Keep each visible child slice under the same parent before/during motion. */
function groupRenderedChatRows(
  rows: readonly SidebarChatThreadRow[],
  startIndex: number,
  indexes?: readonly number[],
) {
  const groups: RenderedChatThreadGroup[] = [];
  for (const [offset, row] of rows.entries()) {
    const index = indexes?.[offset] ?? startIndex + offset;
    const projectId = row.kind !== "project" ? row.projectId : null;
    const previous = groups.at(-1);
    if (projectId !== null && previous?.projectId === projectId) {
      previous.rows.push({ row, index });
    } else {
      groups.push({
        key: projectId === null ? row.key : `project-children:${projectId}`,
        projectId,
        rows: [{ row, index }],
      });
    }
  }
  return groups;
}

interface ChatThreadListRowsOptions {
  touch: boolean;
  layout: ProjectRowLayout;
  shortcuts: boolean;
}

function ChatThreadListRowGroup({
  group,
  rowHeight,
  touch,
  layout,
  shortcuts,
  moving,
  moveHere,
  motion,
}: ChatThreadListRowsOptions & {
  group: RenderedChatThreadGroup;
  rowHeight: number | null;
  moving: boolean;
  moveHere: (projectId: string | null) => void;
  motion?: SidebarChatThreadWindow["motion"];
}) {
  const active = motion?.projectId === group.projectId ? motion : undefined;
  const content = group.rows.map(({ row, index }) => {
    return (
      <ChatThreadListRowFrame
        key={row.key}
        row={row}
        index={index}
        rowHeight={rowHeight}
        touch={touch}
        moving={moving}
        moveHere={moveHere}
      >
        <ChatThreadListRowContent
          row={row}
          index={index}
          touch={touch}
          layout={layout}
          shortcuts={shortcuts}
        />
      </ChatThreadListRowFrame>
    );
  });
  return group.projectId === null ? (
    content[0]
  ) : (
    <div
      data-project-children-id={group.projectId}
      data-project-fold-id={active?.id}
      data-project-fold-state={
        active ? (active.running ? "running" : "prepared") : undefined
      }
      inert={active?.geometry.toHeight === 0}
      aria-hidden={active?.geometry.toHeight === 0 ? true : undefined}
      className={cn(
        "w-full transition-none",
        active && "h-(--okou-project-fold-height) overflow-hidden",
      )}
      style={
        active
          ? {
              paddingTop: active.range.childStart * (rowHeight ?? 0),
            }
          : undefined
      }
    >
      {content}
    </div>
  );
}

/**
 * Projects with their expanded chats, then the chats outside Projects. Every
 * row of a Project accepts a dragged chat for that Project.
 */
function ChatThreadListRowsView({
  rows,
  startIndex,
  rowHeight,
  height,
  motion,
  indexes,
  motionHostRef,
  touch,
  layout,
  shortcuts,
  children,
}: ChatThreadListRowsOptions & {
  rows: readonly SidebarChatThreadRow[];
  startIndex: number;
  rowHeight: number | null;
  height?: number;
  motion?: SidebarChatThreadWindow["motion"];
  indexes?: readonly number[];
  motionHostRef?: RefCallback<HTMLDivElement>;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [moving, move] = useLoadableSet(moveDraggedProjectThread$);
  const signal = useGet(rootSignal$);
  const dragEventsRef = useSet(projectThreadDragEventsRef$);
  function moveHere(projectId: string | null) {
    detach(move(projectId, signal), Reason.DomCallback);
  }
  const listStyle:
    (CSSProperties & { "--okou-project-fold-height"?: string }) | undefined =
    height === undefined
      ? undefined
      : motion
        ? {
            height: `calc(${height - motion.geometry.toHeight}px + var(--okou-project-fold-height))`,
            "--okou-project-fold-height": `${motion.running ? motion.geometry.toHeight : motion.geometry.fromHeight}px`,
          }
        : { height };

  return (
    <>
      <div
        ref={motionHostRef ?? (touch ? undefined : dragEventsRef)}
        className={cn(
          "w-full [overflow-anchor:none]",
          rowHeight !== null && "relative",
          motion?.running
            ? "motion-safe:transition-[--okou-project-fold-height] motion-safe:duration-200 motion-safe:ease-out"
            : "transition-none",
        )}
        data-testid={
          rowHeight === null ? undefined : "sidebar-chat-threads-virtual-list"
        }
        data-project-fold-id={motion?.id}
        data-project-fold-state={
          motion ? (motion.running ? "running" : "prepared") : undefined
        }
        style={listStyle}
      >
        <div
          ref={motionHostRef && !touch ? dragEventsRef : undefined}
          className={cn(
            "w-full",
            rowHeight !== null && "absolute left-0 top-0",
          )}
          style={
            rowHeight === null
              ? undefined
              : { transform: `translateY(${startIndex * rowHeight}px)` }
          }
        >
          {groupRenderedChatRows(rows, startIndex, indexes).map((group) => {
            return (
              <ChatThreadListRowGroup
                key={group.key}
                group={group}
                rowHeight={rowHeight}
                touch={touch}
                layout={layout}
                shortcuts={shortcuts}
                moving={moving.state === "loading"}
                moveHere={moveHere}
                motion={motion}
              />
            );
          })}
          {children}
        </div>
      </div>
      {moving.state === "hasError" && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {t(($) => {
            return $.projects.moveError;
          })}
        </p>
      )}
      {!touch && <ProjectThreadDragHint />}
    </>
  );
}

/** The chat list's virtual window, at one fixed row height. */
export function ChatThreadListRows({
  listSignals,
  rowHeight,
  children,
  ...options
}: ChatThreadListRowsOptions & {
  listSignals: SidebarChatThreadListSignals;
  rowHeight: number;
  /** Trailing visible rows that stack inside the same virtual window. */
  children?: ReactNode | ((showAllChatsRow: boolean) => ReactNode);
}) {
  const rows = useLastResolved(listSignals.rows$);
  const metrics = useGet(listSignals.scrollMetrics$);
  const motion = useGet(listSignals.motion$);
  const motionHostRef = useSet(listSignals.motionHostRef$);
  if (!rows) {
    return null;
  }
  const window = getSidebarChatThreadWindow(
    rows,
    metrics,
    motion,
    listSignals.showAllChatsRow,
    rowHeight,
  );
  return (
    <ChatThreadListRowsView
      {...options}
      rows={window.rows}
      startIndex={window.startIndex}
      indexes={window.indexes}
      motion={window.motion}
      motionHostRef={motionHostRef}
      rowHeight={rowHeight}
      height={
        (rows.length + (options.touch && listSignals.showAllChatsRow ? 1 : 0)) *
        rowHeight
      }
    >
      {typeof children === "function"
        ? children(window.showAllChatsRow)
        : children}
    </ChatThreadListRowsView>
  );
}
