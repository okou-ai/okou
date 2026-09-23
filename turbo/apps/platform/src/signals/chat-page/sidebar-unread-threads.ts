import { command, computed } from "ccstate";
import { chatThreadMarkAgentReadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { chatThreadIndicatorsFromWorker$ } from "../shared-database.ts";
import { optimisticReadMarks$ } from "./optimistic-chat-thread-read-marks.ts";

/**
 * The server's unread instant for one thread, once optimistic local marks
 * are applied.
 *
 * The server watermark already covers both kinds of unread: a Run terminal
 * marker and a native Morning Brief delivery, which has no Run and therefore
 * no client-visible terminal event. Reading it here is what lets the open
 * thread clear a native unread without inventing a Run event locally.
 */
export function serverUnreadAt$(threadId: string) {
  return computed(async (get): Promise<string | undefined> => {
    const { unreadAt } = await get(chatThreadIndicatorsFromWorker$);
    const timestamp = unreadAt[threadId];
    if (timestamp === undefined) {
      return undefined;
    }
    const markedAt = get(optimisticReadMarks$).get(threadId);
    return markedAt === undefined || Date.parse(timestamp) > markedAt
      ? timestamp
      : undefined;
  });
}

export const sidebarUnreadThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const { unreadAt } = await get(chatThreadIndicatorsFromWorker$);
    const marks = get(optimisticReadMarks$);
    const ids = new Set<string>();
    for (const [threadId, timestamp] of Object.entries(unreadAt)) {
      const markedAt = marks.get(threadId);
      if (markedAt === undefined || Date.parse(timestamp) > markedAt) {
        ids.add(threadId);
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
