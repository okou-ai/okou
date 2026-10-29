import { computed } from "ccstate";
import { chatFoldersContract } from "@okouai/api-contracts/contracts/chat-folders";
import { authenticatedSessionKey$ } from "../auth.ts";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import {
  threeColumnSearchOpen$,
  debouncedChatListQuery$,
} from "../okou-page/sidebar-state.ts";
import {
  chatFoldersEnabled$,
  currentChatFolderCatalog$,
} from "./chat-folders.ts";
import { eventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";

export const chatFolderSearchNames$ = computed(
  async (get): Promise<ReadonlyMap<string, string>> => {
    get(authenticatedSessionKey$);
    const names = new Map<string, string>();
    if (!get(chatFoldersEnabled$) || !get(threeColumnSearchOpen$)) {
      return names;
    }
    await get(debouncedChatListQuery$);
    await get(currentChatFolderCatalog$);
    const client = get(apiClient$)(chatFoldersContract);
    const agentIds = new Set(
      get(eventDrivenChatThreads$).map((thread) => {
        return thread.agentId;
      }),
    );
    const catalogs = await Promise.all(
      [...agentIds].map(async (agentId) => {
        return (await accept(client.list({ params: { agentId } }), [200])).body;
      }),
    );
    for (const catalog of catalogs) {
      const folders = new Map(
        catalog.folders.map((folder) => {
          return [folder.id, folder.name];
        }),
      );
      for (const row of catalog.memberships) {
        const name = folders.get(row.folderId);
        if (name) {
          names.set(row.chatThreadId, name);
        }
      }
    }
    return names;
  },
);
