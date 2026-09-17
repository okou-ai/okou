import { command, computed } from "ccstate";
import {
  chatThreadMarkAgentReadContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { reloadChatIndicatorsCounter$ } from "../chat-thread-list-reload.ts";
import { optimisticReadMarks$ } from "./optimistic-chat-thread-read-marks.ts";

type UnreadSnapshot = readonly { threadId: string; unreadAt: string }[];

/**
 * Server unread snapshot for the current agent. Refetched alongside the
 * indicator counter. Shared thread-list synchronization and user-channel
 * read-cursor updates both invalidate this shared counter.
 */
const fetchedUnreads$ = computed(async (get): Promise<UnreadSnapshot> => {
  get(reloadChatIndicatorsCounter$);
  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return [];
  }
  const client = get(apiClient$)(chatThreadsContract);
  const result = await accept(client.unreads({ query: { agentId } }), [200]);
  return result.body.unreads;
});

/**
 * The server's own unread instant for one thread, once optimistic local marks
 * are applied.
 *
 * The server watermark already covers both kinds of unread: a Run terminal
 * marker and a native Morning Brief delivery, which has no Run and therefore
 * no client-visible terminal event. Reading it here is what lets the open
 * thread clear a native unread without inventing a Run event locally.
 */
export function serverUnreadAt$(threadId: string) {
  return computed(async (get): Promise<string | undefined> => {
    const unreads = await get(fetchedUnreads$);
    const unread = unreads.find((entry) => {
      return entry.threadId === threadId;
    });
    if (!unread) {
      return undefined;
    }
    const markedAt = get(optimisticReadMarks$).get(threadId);
    return markedAt === undefined || Date.parse(unread.unreadAt) > markedAt
      ? unread.unreadAt
      : undefined;
  });
}

export const sidebarUnreadThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const unreads = await get(fetchedUnreads$);
    const marks = get(optimisticReadMarks$);
    const ids = new Set<string>();
    for (const unread of unreads) {
      const markedAt = marks.get(unread.threadId);
      if (markedAt === undefined || Date.parse(unread.unreadAt) > markedAt) {
        ids.add(unread.threadId);
      }
    }
    return ids;
  },
);

export const markAgentThreadsRead$ = command(
  async ({ get }, agentId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(chatThreadMarkAgentReadContract);
    await accept(
      client.markAgentRead({
        body: { agentId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
  },
);
