import { computed } from "ccstate";
import type { ChatFolderCatalog } from "@okouai/api-contracts/contracts/chat-folders";
import { chatThreads$, currentChatThreadListSignals$ } from "../agent-chat.ts";
import { chatThreadOnlyUnread$ } from "./chat-thread-only-unread.ts";
import { currentChatFolders$ } from "./chat-folders.ts";

function groupThreadIds(
  threadIds: readonly string[],
  catalog: ChatFolderCatalog,
  collapsed?: ReadonlySet<string>,
): readonly string[] {
  const membership = new Map(
    catalog.memberships.map((row) => {
      return [row.chatThreadId, row.folderId];
    }),
  );
  return [
    ...catalog.folders.flatMap((folder) => {
      return collapsed?.has(folder.id)
        ? []
        : threadIds.filter((id) => {
            return membership.get(id) === folder.id;
          });
    }),
    ...threadIds.filter((id) => {
      return !membership.has(id);
    }),
  ];
}

export const currentChatThreadListIds$ = computed(
  async (get): Promise<readonly string[]> => {
    const threads = await get(chatThreads$);
    const threadIds = threads.map((thread) => {
      return thread.id;
    });
    const folders = await get(currentChatFolders$);
    if (!folders) {
      return threadIds;
    }
    const catalog = await get(folders.catalog$);
    return groupThreadIds(threadIds, catalog, get(folders.collapsed$));
  },
);

export interface ChatThreadNavigationList {
  readonly orderedThreadIds: readonly string[];
  readonly listedThreadIds: readonly string[];
}

// A filtered current chat still needs its position in the complete ordering so
// adjacent navigation can skip hidden chats. Unread navigation intentionally
// keeps using its independently computed list for both ordering and eligibility.
export const currentChatThreadNavigationList$ = computed(
  async (get): Promise<ChatThreadNavigationList> => {
    if (get(chatThreadOnlyUnread$)) {
      const listedThreadIds = await get(currentChatThreadListIds$);
      return {
        orderedThreadIds: listedThreadIds,
        listedThreadIds,
      };
    }

    const list = await get(currentChatThreadListSignals$);
    const folders = await get(currentChatFolders$);
    if (folders) {
      return {
        orderedThreadIds: groupThreadIds(
          get(list.allThreadIds$),
          await get(folders.catalog$),
        ),
        listedThreadIds: await get(currentChatThreadListIds$),
      };
    }
    return {
      orderedThreadIds: get(list.allThreadIds$),
      listedThreadIds: get(list.threadIds$),
    };
  },
);
