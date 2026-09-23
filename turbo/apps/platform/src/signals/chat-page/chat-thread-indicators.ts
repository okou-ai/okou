import { command, computed, state } from "ccstate";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";

const chatThreadIndicatorsReload$ = state(0);

/**
 * Async computed — reads chat thread indicators from the API. The Worker owns
 * this fetch; tabs read the Worker's value through
 * `chat-thread-indicators-from-worker.ts`.
 */
export const chatThreadIndicators$ = computed(async (get) => {
  get(chatThreadIndicatorsReload$);
  const client = get(apiClient$)(chatThreadsContract);
  const result = await accept(client.indicators(), [200]);
  return result.body;
});

export const reloadChatThreadIndicators$ = command(({ set }) => {
  set(chatThreadIndicatorsReload$, (value) => {
    return value + 1;
  });
});
