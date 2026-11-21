import { computed } from "ccstate";

import { chatThreadIndicatorsFromWorker$ } from "../shared-database.ts";
import { sidebarUnreadThreadIds$ } from "./sidebar-unread-threads.ts";

export const workspaceHasUnreadChats$ = computed(
  async (get): Promise<boolean> => {
    return (await get(sidebarUnreadThreadIds$)).size > 0;
  },
);

export const sidebarActiveThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicatorsFromWorker$);
    return new Set(
      Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
        return indicator === "active" ? [threadId] : [];
      }),
    );
  },
);
