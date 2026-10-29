import { computed, type Computed } from "ccstate";
import type {
  ChatFolder,
  ChatFolderCatalog,
} from "@okouai/api-contracts/contracts/chat-folders";
import type { SidebarChatThreadItemSignals } from "./sidebar-chat-thread-item.ts";
import type { ChatFolderSignals } from "./chat-folders.ts";
import { sidebarUnreadThreadIds$ } from "./sidebar-unread-threads.ts";
import { sidebarActiveThreadIds$ } from "./chat-thread-indicators-from-worker.ts";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";

export type ChatFolderRow =
  | {
      readonly kind: "folder";
      readonly key: string;
      readonly folder: ChatFolder;
      readonly expanded: boolean;
      readonly unread$: Computed<Promise<boolean>>;
      readonly running$: Computed<Promise<boolean>>;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly item: SidebarChatThreadItemSignals;
      readonly filed: boolean;
      readonly shortcutIndex: number;
    }
  | {
      readonly kind: "heading";
      readonly key: string;
      readonly hasFolders: boolean;
    }
  | { readonly kind: "create"; readonly key: string }
  | { readonly kind: "empty"; readonly key: string };

export function createChatFolderRows(
  folders: ChatFolderSignals,
  catalog: ChatFolderCatalog,
  items$: Computed<readonly SidebarChatThreadItemSignals[]>,
  filtered: boolean,
) {
  const activity = new Map(
    catalog.folders.map((folder) => {
      const ids = new Set(
        catalog.memberships
          .filter((row) => {
            return row.folderId === folder.id;
          })
          .map((row) => {
            return row.chatThreadId;
          }),
      );
      return [
        folder.id,
        {
          unread$: computed(async (get) => {
            const unread = await get(sidebarUnreadThreadIds$);
            const meta = get(chatThreadMetaMap$);
            return [...ids].some((id) => {
              return (
                unread.has(id) &&
                meta.get(id)?.agentId === folders.owner.agentId &&
                !meta.get(id)?.muted
              );
            });
          }),
          running$: computed(async (get) => {
            const active = await get(sidebarActiveThreadIds$);
            const meta = get(chatThreadMetaMap$);
            return [...ids].some((id) => {
              return (
                active.has(id) &&
                meta.get(id)?.agentId === folders.owner.agentId
              );
            });
          }),
        },
      ] as const;
    }),
  );
  return computed((get): readonly ChatFolderRow[] => {
    const items = get(items$);
    const collapsed = get(folders.collapsed$);
    const membership = new Map(
      catalog.memberships.map((row) => {
        return [row.chatThreadId, row.folderId];
      }),
    );
    const rows: ChatFolderRow[] = [];
    let shortcutIndex = 0;
    const append = (item: SidebarChatThreadItemSignals, filed: boolean) => {
      rows.push({
        kind: "thread",
        key: item.threadId,
        item,
        filed,
        shortcutIndex: shortcutIndex++,
      });
    };
    if (catalog.folders.length === 0) {
      rows.push({ kind: "create", key: "create" });
    }
    for (const folder of catalog.folders) {
      const children = items.filter((item) => {
        return membership.get(item.threadId) === folder.id;
      });
      if (filtered && children.length === 0) {
        continue;
      }
      const indicators = activity.get(folder.id)!;
      rows.push({
        kind: "folder",
        key: folder.id,
        folder,
        expanded: !collapsed.has(folder.id),
        ...indicators,
      });
      if (collapsed.has(folder.id)) {
        continue;
      }
      if (children.length === 0) {
        rows.push({ kind: "empty", key: `${folder.id}:empty` });
      }
      for (const item of children) {
        append(item, true);
      }
    }
    rows.push({
      kind: "heading",
      key: "unfiled",
      hasFolders: catalog.folders.length > 0,
    });
    for (const item of items) {
      if (!membership.has(item.threadId)) {
        append(item, false);
      }
    }
    return rows;
  });
}
