import { command, computed, state } from "ccstate";
import { debounceCommand } from "../command-scheduling.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { resetSignal } from "../utils.ts";
import { hideKeyboardShortcutHints$ } from "../keyboard-shortcut-hints.ts";

// ---------------------------------------------------------------------------
// Chat navigation search query
// ---------------------------------------------------------------------------
const internalChatListQuery$ = state("");
const internalDebouncedChatListQuery$ = state(Promise.resolve(""));
const resetChatListQueryDebounce$ = resetSignal();
const CHAT_LIST_QUERY_DEBOUNCE_MS = 300;

export const chatListQuery$ = computed((get) => {
  return get(internalChatListQuery$);
});

export const debouncedChatListQuery$ = computed((get) => {
  return get(internalDebouncedChatListQuery$);
});

const readChatListQuery$ = command(({ get }, _signal: AbortSignal) => {
  return get(chatListQuery$).trim().toLowerCase();
});
const debounceChatListQuery$ = debounceCommand(
  readChatListQuery$,
  CHAT_LIST_QUERY_DEBOUNCE_MS,
);

export const setChatListQuery$ = command(
  ({ set }, query: string, signal: AbortSignal) => {
    set(internalChatListQuery$, query);
    const debounceSignal = set(resetChatListQueryDebounce$, signal);
    const debouncedQuery = query.trim()
      ? set(debounceChatListQuery$, debounceSignal)
      : Promise.resolve("");
    set(internalDebouncedChatListQuery$, debouncedQuery);
    return debouncedQuery;
  },
);

export const clearChatListQuery$ = command(({ set }) => {
  set(resetChatListQueryDebounce$);
  set(internalDebouncedChatListQuery$, Promise.resolve(""));
  set(internalChatListQuery$, "");
});

// ---------------------------------------------------------------------------
// Delete confirmation dialog state (RecentChatList)
// ---------------------------------------------------------------------------
const internalPendingDeleteThreadId$ = state<string | null>(null);
export const pendingDeleteThreadId$ = computed((get) => {
  return get(internalPendingDeleteThreadId$);
});
export const setPendingDeleteThreadId$ = command(
  ({ set }, id: string | null) => {
    set(internalPendingDeleteThreadId$, id);
  },
);

// ---------------------------------------------------------------------------
// Rename dialog state (RecentChatList)
// ---------------------------------------------------------------------------
const internalRenameDialogOpen$ = state(false);
export const renameDialogOpen$ = computed((get) => {
  return get(internalRenameDialogOpen$);
});

const internalRenameDialogThreadId$ = state<string | null>(null);
export const renameDialogThreadId$ = computed((get) => {
  return get(internalRenameDialogThreadId$);
});

const internalRenameDialogAgentId$ = state<string | null>(null);
export const renameDialogAgentId$ = computed((get) => {
  return get(internalRenameDialogAgentId$);
});

const internalRenameDialogInput$ = state("");
export const renameDialogInput$ = computed((get) => {
  return get(internalRenameDialogInput$);
});
export const setRenameDialogInput$ = command(({ set }, input: string) => {
  set(internalRenameDialogInput$, input);
});

export const openRenameChatThreadDialog$ = command(
  (
    { set },
    {
      threadId,
      title,
      agentId,
    }: {
      threadId: string;
      title: string | null | undefined;
      agentId?: string | null | undefined;
    },
  ) => {
    set(internalRenameDialogInput$, title?.trim() ?? "");
    set(internalRenameDialogAgentId$, agentId?.trim() || null);
    set(internalRenameDialogThreadId$, threadId);
    set(internalRenameDialogOpen$, true);
  },
);

export const closeRenameChatThreadDialog$ = command(({ set }) => {
  set(internalRenameDialogOpen$, false);
});

// ---------------------------------------------------------------------------
// Emoji picker menu state (chat header)
// ---------------------------------------------------------------------------
const internalEmojiMenuThreadId$ = state<string | null>(null);
export const emojiMenuThreadId$ = computed((get) => {
  return get(internalEmojiMenuThreadId$);
});

const internalEmojiMenuTitle$ = state<string | null>(null);
export const emojiMenuTitle$ = computed((get) => {
  return get(internalEmojiMenuTitle$);
});

export const openChatThreadEmojiMenu$ = command(
  (
    { set },
    { threadId, title }: { threadId: string; title: string | null | undefined },
  ) => {
    set(internalEmojiMenuTitle$, title?.trim() || null);
    set(internalEmojiMenuThreadId$, threadId);
  },
);

export const closeChatThreadEmojiMenu$ = command(({ set }) => {
  set(internalEmojiMenuThreadId$, null);
  set(internalEmojiMenuTitle$, null);
});

// ---------------------------------------------------------------------------
// Session list collapse state (RecentChatSection)
// ---------------------------------------------------------------------------
const sessionListCollapsedStorage = localStorageSignals(
  "sidebar-session-list-collapsed",
);
export const sessionListCollapsed$ = computed((get) => {
  return get(sessionListCollapsedStorage.get$) === "true";
});
export const setSessionListCollapsed$ = command(
  ({ set }, collapsed: boolean) => {
    set(sessionListCollapsedStorage.set$, String(collapsed));
  },
);

// ---------------------------------------------------------------------------
// Manage section collapse state (Sidebar)
// ---------------------------------------------------------------------------
const manageSectionCollapsedStorage = localStorageSignals(
  "sidebar-manage-section-collapsed",
);
export const manageSectionCollapsed$ = computed((get) => {
  return get(manageSectionCollapsedStorage.get$) === "true";
});
export const setManageSectionCollapsed$ = command(
  ({ set }, collapsed: boolean) => {
    set(manageSectionCollapsedStorage.set$, String(collapsed));
  },
);

// ---------------------------------------------------------------------------
// Three-column search dialog state
// ---------------------------------------------------------------------------
export type ThreeColumnSearchFilter =
  | "all"
  | "chats"
  | "messages"
  | "agents"
  | "workflows"
  | "artifacts";

const internalThreeColumnSearchOpen$ = state(false);
export const threeColumnSearchOpen$ = computed((get) => {
  return get(internalThreeColumnSearchOpen$);
});
export const setThreeColumnSearchOpen$ = command(({ set }, open: boolean) => {
  if (!open) {
    set(clearChatListQuery$);
    set(hideKeyboardShortcutHints$);
  }
  set(internalThreeColumnSearchOpen$, open);
});

const internalThreeColumnSearchFilter$ = state<ThreeColumnSearchFilter>("all");
export const threeColumnSearchFilter$ = computed((get) => {
  return get(internalThreeColumnSearchFilter$);
});
export const setThreeColumnSearchFilter$ = command(
  ({ set }, filter: ThreeColumnSearchFilter) => {
    set(internalThreeColumnSearchFilter$, filter);
  },
);

export const openThreeColumnSearchDialog$ = command(({ set }) => {
  set(hideKeyboardShortcutHints$);
  set(clearChatListQuery$);
  set(internalThreeColumnSearchFilter$, "all");
  set(internalThreeColumnSearchOpen$, true);
});

// ---------------------------------------------------------------------------
// Pin agent dialog state (pinned agent grid)
// ---------------------------------------------------------------------------
const internalPinAgentDialogOpen$ = state(false);
export const pinAgentDialogOpen$ = computed((get) => {
  return get(internalPinAgentDialogOpen$);
});
export const setPinAgentDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalPinAgentDialogOpen$, open);
});

const internalPinAgentDialogQuery$ = state("");
export const pinAgentDialogQuery$ = computed((get) => {
  return get(internalPinAgentDialogQuery$);
});
export const setPinAgentDialogQuery$ = command(({ set }, query: string) => {
  set(internalPinAgentDialogQuery$, query);
});

export const openPinAgentDialog$ = command(({ set }) => {
  set(internalPinAgentDialogQuery$, "");
  set(internalPinAgentDialogOpen$, true);
});

// ---------------------------------------------------------------------------
// Pinned agent drag and drop state (pinned agent grid)
// ---------------------------------------------------------------------------
const internalDraggingPinnedAgentId$ = state<string | null>(null);
export const draggingPinnedAgentId$ = computed((get) => {
  return get(internalDraggingPinnedAgentId$);
});

const internalPinnedAgentDropTargetId$ = state<string | null>(null);
export const pinnedAgentDropTargetId$ = computed((get) => {
  return get(internalPinnedAgentDropTargetId$);
});

export const startPinnedAgentDrag$ = command(({ set }, agentId: string) => {
  set(internalDraggingPinnedAgentId$, agentId);
  set(internalPinnedAgentDropTargetId$, null);
});

export const setPinnedAgentDropTarget$ = command(
  ({ set }, agentId: string | null) => {
    set(internalPinnedAgentDropTargetId$, agentId);
  },
);

export const endPinnedAgentDrag$ = command(({ set }) => {
  set(internalDraggingPinnedAgentId$, null);
  set(internalPinnedAgentDropTargetId$, null);
});

// ---------------------------------------------------------------------------
// Agent card / pinned section collapse state
// ---------------------------------------------------------------------------
const agentCardCollapsedStorage = localStorageSignals(
  "sidebar-agent-card-collapsed",
);
export const agentCardCollapsed$ = computed((get) => {
  return get(agentCardCollapsedStorage.get$) === "true";
});
export const setAgentCardCollapsed$ = command(({ set }, collapsed: boolean) => {
  set(agentCardCollapsedStorage.set$, String(collapsed));
});

// ---------------------------------------------------------------------------
// Chat thread virtual list layout (RecentChatSection)
// ---------------------------------------------------------------------------
export const CHAT_THREAD_VIRTUAL_ROW_HEIGHT = 36;
export const CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT =
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT * 12;
export type ChatThreadVirtualListScrollAlign = "top" | "bottom";
