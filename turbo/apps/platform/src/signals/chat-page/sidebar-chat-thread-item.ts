import { command, computed, state, type Command, type Computed } from "ccstate";
import { pathParams$, searchParams$ } from "../route.ts";
import { setSidebarExpanded$ } from "../okou-page/nav.ts";
import { setPendingDeleteThreadId$ } from "../okou-page/sidebar-state.ts";
import { threadMeta } from "./chat-thread-event-sourcing.ts";
import { sidebarActiveThreadIds$ } from "./chat-thread-indicators-from-worker.ts";
import {
  pinChatThread$,
  renameChatThread$,
  setChatThreadMuted$,
  unpinChatThread$,
} from "./chat-event.ts";
import {
  currentLeftThread$,
  currentRightThread$,
  loadLeftThread$,
  loadRightThread$,
  SIDEBAR_PARAM,
  unloadRightThread$,
} from "./chat-thread-panes.ts";
import { openRenameChatThreadDialogForThreadId$ } from "./chat-thread-rename.ts";
import { markChatThreadUnread$ } from "./chat-thread-mark-unread.ts";
import { setChatThreadArchivedWithFeedback$ } from "./chat-thread-archive.ts";
import { sidebarDraftThreadIds$ } from "./sidebar-draft-threads.ts";
import { sidebarUnreadThreadIds$ } from "./sidebar-unread-threads.ts";
import { onRef } from "../utils.ts";

export type SidebarChatThreadIndicatorState =
  "running" | "muted" | "unread" | "draft";

export type SidebarChatThreadPaneIndicator = "main" | "sidebar";
export type SidebarChatThreadTargetPane = "main" | "sidebar";

export interface SidebarChatThreadItemSignals {
  readonly threadId: string;
  readonly title$: Computed<string | null>;
  readonly archived$: Computed<boolean>;
  readonly muted$: Computed<boolean>;
  readonly pinned$: Computed<boolean>;
  readonly currentPage$: Computed<boolean>;
  readonly highlighted$: Computed<boolean>;
  readonly unread$: Computed<Promise<boolean>>;
  readonly paneIndicator$: Computed<SidebarChatThreadPaneIndicator | null>;
  readonly indicatorState$: Computed<
    Promise<SidebarChatThreadIndicatorState | null>
  >;
  readonly select$: Command<boolean, [SidebarChatThreadTargetPane]>;
  readonly togglePinned$: Command<Promise<void>, [AbortSignal]>;
  readonly toggleArchived$: Command<Promise<void>, [AbortSignal]>;
  readonly toggleMuted$: Command<Promise<void>, [AbortSignal]>;
  readonly markUnread$: Command<Promise<void>, [AbortSignal]>;
  readonly openRename$: Command<void, [AbortSignal]>;
  readonly inlineRenaming$: Computed<boolean>;
  readonly startInlineRename$: Command<void, []>;
  readonly commitInlineRename$: Command<Promise<void>, [string, AbortSignal]>;
  readonly cancelInlineRename$: Command<void, []>;
  readonly requestDelete$: Command<void, []>;
}

// One sidebar title is edited in place at a time: the blur that leaves one
// field commits it before a double-click can open the next.
const inlineRenameThreadId$ = state<string | null>(null);

/**
 * Focuses the in-place title field with its text selected, so typing replaces
 * the title and the arrow keys keep it.
 */
export const sidebarThreadRenameInputRef$ = onRef(
  command((_context, input: HTMLInputElement, _signal: AbortSignal) => {
    input.focus();
    input.select();
  }),
);

type InlineRenameSignals = Pick<
  SidebarChatThreadItemSignals,
  | "inlineRenaming$"
  | "startInlineRename$"
  | "commitInlineRename$"
  | "cancelInlineRename$"
>;

function createInlineRenameSignals(
  threadId: string,
  meta$: ReturnType<typeof threadMeta>,
): InlineRenameSignals {
  return {
    inlineRenaming$: computed((get): boolean => {
      return get(inlineRenameThreadId$) === threadId;
    }),
    startInlineRename$: command(({ set }) => {
      set(inlineRenameThreadId$, threadId);
    }),
    commitInlineRename$: command(
      async ({ get, set }, value: string, signal: AbortSignal) => {
        // Escape ends the edit before focus leaves the field, so the blur
        // that follows has nothing left to commit.
        if (get(inlineRenameThreadId$) !== threadId) {
          return;
        }
        set(inlineRenameThreadId$, null);
        const meta = get(meta$);
        const title = value.trim();
        if (!title || title === meta?.title?.trim()) {
          return;
        }
        await set(
          renameChatThread$,
          { threadId, title, agentId: meta?.agentId },
          signal,
        );
      },
    ),
    cancelInlineRename$: command(({ set }) => {
      set(inlineRenameThreadId$, null);
    }),
  };
}

interface SidebarChatThreadItemSignalsRegistry {
  reconcile(
    threadIds: readonly string[],
  ): readonly SidebarChatThreadItemSignals[];
}

function createSidebarChatThreadItemSignals(
  threadId: string,
): SidebarChatThreadItemSignals {
  const meta$ = threadMeta(threadId);
  const title$ = computed((get): string | null => {
    return get(meta$)?.title ?? null;
  });
  const archived$ = computed((get): boolean => {
    return get(meta$)?.archived ?? false;
  });
  const muted$ = computed((get): boolean => {
    return get(meta$)?.muted ?? false;
  });
  const currentPage$ = computed((get): boolean => {
    return get(pathParams$)?.threadId === threadId;
  });
  const sidebarThreadId$ = computed((get): string | null => {
    const mainThreadId = get(pathParams$)?.threadId;
    const sidebarThreadId = get(searchParams$).get(SIDEBAR_PARAM);
    return sidebarThreadId && sidebarThreadId !== mainThreadId
      ? sidebarThreadId
      : null;
  });
  const highlighted$ = computed((get): boolean => {
    return get(currentPage$) || get(sidebarThreadId$) === threadId;
  });
  const unread$ = computed(async (get): Promise<boolean> => {
    return (
      (await get(sidebarUnreadThreadIds$)).has(threadId) && !get(highlighted$)
    );
  });

  return {
    threadId,
    title$,
    archived$,
    muted$,
    pinned$: computed((get): boolean => {
      const pinnedAt = get(meta$)?.pinnedAt;
      return pinnedAt !== null && pinnedAt !== undefined;
    }),
    currentPage$,
    highlighted$,
    unread$,
    paneIndicator$: computed((get): SidebarChatThreadPaneIndicator | null => {
      const sidebarThreadId = get(sidebarThreadId$);
      if (!sidebarThreadId) {
        return null;
      }
      if (get(currentPage$)) {
        return "main";
      }
      return sidebarThreadId === threadId ? "sidebar" : null;
    }),
    indicatorState$: computed(
      async (get): Promise<SidebarChatThreadIndicatorState | null> => {
        if ((await get(sidebarActiveThreadIds$)).has(threadId)) {
          return "running";
        }
        if (get(muted$)) {
          return "muted";
        }
        if (await get(unread$)) {
          return "unread";
        }
        return (await get(sidebarDraftThreadIds$)).has(threadId) &&
          !get(highlighted$)
          ? "draft"
          : null;
      },
    ),
    select$: command(({ get, set }, pane: SidebarChatThreadTargetPane) => {
      const mainThreadId = get(pathParams$)?.threadId;
      if (typeof mainThreadId !== "string") {
        set(setSidebarExpanded$, false);
        return false;
      }

      if (pane === "sidebar") {
        const currentLeftId = get(currentLeftThread$)?.threadId ?? null;
        const currentRightId = get(currentRightThread$)?.threadId ?? null;
        if (threadId === currentLeftId) {
          return true;
        }
        if (threadId === currentRightId) {
          set(unloadRightThread$);
        } else {
          set(loadRightThread$, threadId);
        }
      } else if (get(currentLeftThread$)?.threadId !== threadId) {
        set(loadLeftThread$, threadId);
      }

      set(setSidebarExpanded$, false);
      return true;
    }),
    togglePinned$: command(async ({ get, set }, signal: AbortSignal) => {
      const pinnedAt = get(meta$)?.pinnedAt;
      if (pinnedAt === null || pinnedAt === undefined) {
        await set(pinChatThread$, threadId, signal);
        return;
      }
      await set(unpinChatThread$, threadId, signal);
    }),
    toggleArchived$: command(async ({ get, set }, signal: AbortSignal) => {
      await set(
        setChatThreadArchivedWithFeedback$,
        { threadId, archived: !get(archived$) },
        signal,
      );
    }),
    toggleMuted$: command(async ({ get, set }, signal: AbortSignal) => {
      await set(setChatThreadMuted$, { threadId, muted: !get(muted$) }, signal);
    }),
    markUnread$: command(async ({ set }, signal: AbortSignal) => {
      await set(markChatThreadUnread$, { threadId }, signal);
    }),
    openRename$: command(({ set }, signal: AbortSignal) => {
      set(openRenameChatThreadDialogForThreadId$, threadId, signal);
    }),
    ...createInlineRenameSignals(threadId, meta$),
    requestDelete$: command(({ set }) => {
      set(setPendingDeleteThreadId$, threadId);
    }),
  };
}

function createSidebarChatThreadItemSignalsRegistry(): SidebarChatThreadItemSignalsRegistry {
  const signalsByThreadId = new Map<string, SidebarChatThreadItemSignals>();

  return {
    reconcile(threadIds) {
      const nextSignalsByThreadId = new Map<
        string,
        SidebarChatThreadItemSignals
      >();
      const items = threadIds.map((threadId) => {
        const signals =
          signalsByThreadId.get(threadId) ??
          createSidebarChatThreadItemSignals(threadId);
        nextSignalsByThreadId.set(threadId, signals);
        return signals;
      });
      signalsByThreadId.clear();
      for (const [threadId, signals] of nextSignalsByThreadId) {
        signalsByThreadId.set(threadId, signals);
      }
      return items;
    },
  };
}

export const sidebarChatThreadItemSignalsRegistry$ = computed(() => {
  return createSidebarChatThreadItemSignalsRegistry();
});
