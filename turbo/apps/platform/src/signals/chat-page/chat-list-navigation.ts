import { command, computed } from "ccstate";
import { currentChatThreadNavigationList$ } from "../agent-chat.ts";
import { suggestionsEnabled$ } from "../okou-page/agent-suggestion-session.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { rootSignal$ } from "../root-signal.ts";
import { singleAgentEnabled$ } from "../single-agent.ts";
import { currentLeftThread$ } from "./chat-thread-panes.ts";
import {
  loadLeftThread$,
  loadRightThread$,
} from "./chat-thread-pane-navigation.ts";
import {
  projectIdOfRowKey,
  threadIdOfRowKey,
  threadRowKey,
} from "./chat-thread-list-rows.ts";
import { scrollToChatListRow$ } from "./sidebar-chat-thread-scroll.ts";

type ChatListNavigationDirection = "prev" | "next";

/** My Okou's New chat entry, whose page is the chat page at `/`. */
export const NEW_CHAT_ENTRY_KEY = "entry:new-chat";
/** The For you entry, shown while Suggestions are on. */
export const FOR_YOU_ENTRY_KEY = "entry:for-you";

/**
 * The entries above the list's scroll viewport, in the order they appear.
 * Keyboard navigation passes them like rows, and filters never hide them.
 */
const chatListEntryKeys$ = computed(async (get): Promise<readonly string[]> => {
  return [
    ...((await get(singleAgentEnabled$)) ? [NEW_CHAT_ENTRY_KEY] : []),
    ...((await get(suggestionsEnabled$)) ? [FOR_YOU_ENTRY_KEY] : []),
  ];
});

/**
 * The nearest visible list item from the current position. A current item that
 * a fold, filter or archive hides keeps its place in the complete order, so
 * navigation continues from where it stood. Without a current item, moving
 * down enters the list at its first visible item.
 */
function findAdjacentListedKey({
  currentKey,
  direction,
  orderedKeys,
  listedKeys,
  selectable,
}: {
  currentKey: string | null;
  direction: ChatListNavigationDirection;
  orderedKeys: readonly string[];
  listedKeys: readonly string[];
  selectable: (key: string) => boolean;
}): string | undefined {
  const currentIndex =
    currentKey === null ? -1 : orderedKeys.indexOf(currentKey);
  if (currentKey !== null && currentIndex === -1) {
    return undefined;
  }
  if (currentKey === null && direction === "prev") {
    return undefined;
  }
  const listed = new Set(listedKeys);
  const step = direction === "prev" ? -1 : 1;
  for (
    let index = currentIndex + step;
    index >= 0 && index < orderedKeys.length;
    index += step
  ) {
    const candidate = orderedKeys[index];
    if (
      candidate !== undefined &&
      listed.has(candidate) &&
      selectable(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

export const navigateChatList$ = command(
  async (
    { get, set },
    request: {
      /**
       * The key of the current entry, Project or chat, if the page has one.
       */
      readonly currentKey: string | null;
      readonly direction: ChatListNavigationDirection;
      readonly pane: "main" | "side";
      /** The chat the other pane shows, which this pane cannot also open. */
      readonly excludedThreadId: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const navigation = await get(currentChatThreadNavigationList$);
    signal.throwIfAborted();
    const entryKeys = await get(chatListEntryKeys$);
    signal.throwIfAborted();
    const excludedKey =
      request.excludedThreadId === null
        ? null
        : threadRowKey(request.excludedThreadId);
    const targetKey = findAdjacentListedKey({
      currentKey: request.currentKey,
      direction: request.direction,
      orderedKeys: [...entryKeys, ...navigation.orderedKeys],
      listedKeys: [...entryKeys, ...navigation.listedKeys],
      // The entry and Project pages only open in the main pane.
      selectable: (key) => {
        return (
          key !== excludedKey &&
          (request.pane === "main" || threadIdOfRowKey(key) !== null)
        );
      },
    });
    if (!targetKey) {
      return;
    }
    // The entries sit above the scroll viewport, so reaching one scrolls
    // nothing.
    if (targetKey === NEW_CHAT_ENTRY_KEY) {
      set(detachedNavigateTo$, ROUTES.home);
      return;
    }
    if (targetKey === FOR_YOU_ENTRY_KEY) {
      set(detachedNavigateTo$, ROUTES.forYou);
      return;
    }
    const projectId = projectIdOfRowKey(targetKey);
    const threadId = threadIdOfRowKey(targetKey);
    if (projectId) {
      set(detachedNavigateTo$, ROUTES.project, { pathParams: { projectId } });
    } else if (threadId && request.pane === "main" && get(currentLeftThread$)) {
      set(loadLeftThread$, threadId);
    } else if (threadId && request.pane === "main") {
      // A page without chat panes, such as a Project, opens the chat plainly.
      set(detachedNavigateTo$, ROUTES.chat, { pathParams: { threadId } });
    } else if (threadId) {
      set(loadRightThread$, threadId);
    }
    // The selection outlives the page it leaves, so its scroll belongs to the
    // app root.
    await set(
      scrollToChatListRow$,
      {
        key: targetKey,
        align: request.direction === "next" ? "bottom" : "top",
      },
      get(rootSignal$),
    );
  },
);
