import {
  chatEventsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import type { ApiClientFactory } from "../api-client.ts";

export async function sendChatEvent(
  createClient: ApiClientFactory,
  body: ChatEventSendBody,
  signal: AbortSignal,
): Promise<void> {
  // The web client only needs acceptance; thread state comes from the
  // persisted events, so the response body is intentionally not read.
  await accept(
    createClient(chatEventsContract).send({
      body,
      fetchOptions: { signal },
    }),
    [201],
    signal,
  );
}
