import { command, computed, state } from "ccstate";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";

const chatThreadIndicatorsReload$ = state(0);
const LEGACY_UNREAD_REQUEST_CONCURRENCY = 4;

/**
 * Async computed — reads chat thread indicators from the API. The Worker owns
 * this fetch; tabs read the Worker's value through
 * `chat-thread-indicators-from-worker.ts`.
 */
export const chatThreadIndicators$ = computed(async (get) => {
  get(chatThreadIndicatorsReload$);
  const client = get(apiClient$)(chatThreadsContract);
  const result = await accept(client.indicators(), [200]);
  if (result.body.unreadAt !== undefined) {
    return { ...result.body, unreadAt: result.body.unreadAt };
  }

  // A new App can reach an older API retained for rollback. Remove this path
  // after that API is no longer a serving or rollback target.
  const agentIds = Object.entries(result.body.agents).flatMap(
    ([agentId, indicator]) => {
      return indicator === "unread" ? [agentId] : [];
    },
  );
  const unreadAt: Record<string, string> = {};
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(LEGACY_UNREAD_REQUEST_CONCURRENCY, agentIds.length) },
      async () => {
        while (nextIndex < agentIds.length) {
          const agentId = agentIds[nextIndex++];
          if (agentId === undefined) {
            throw new Error("Legacy unread agent ID is missing");
          }
          const unreads = await accept(
            client.unreads({ query: { agentId } }),
            [200],
          );
          for (const unread of unreads.body.unreads) {
            if (result.body.threads[unread.threadId] === "unread") {
              unreadAt[unread.threadId] = unread.unreadAt;
            }
          }
        }
      },
    ),
  );
  return { ...result.body, unreadAt };
});

export const reloadChatThreadIndicators$ = command(({ set }) => {
  set(chatThreadIndicatorsReload$, (value) => {
    return value + 1;
  });
});
