import { command, computed, state } from "ccstate";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";

const internalReloadSidebarDrafts$ = state(0);

/**
 * Bump after a local draft save adds or removes a thread's draft so the
 * sidebar draft dots refresh without a full thread-list reload. Draft changes
 * are not broadcast by the server.
 */
export const reloadSidebarDraftThreads$ = command(({ set }) => {
  set(internalReloadSidebarDrafts$, (n) => {
    return n + 1;
  });
});

/**
 * Ids of the caller's threads that hold an unsent composer draft. Fetched
 * separately from the thread list so the list query stays cheap; the draft
 * dot may render a beat after the rows themselves.
 */
export const sidebarDraftThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    get(internalReloadSidebarDrafts$);

    const client = get(apiClient$)(chatThreadsContract);
    const result = await accept(
      client.drafts({
        query: {},
      }),
      [200],
    );
    return new Set(result.body.draftThreadIds);
  },
);
