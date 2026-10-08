import { command } from "ccstate";
import { chatThreadMarkUnreadContract } from "@okouai/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { clearOptimisticReadMark$ } from "./optimistic-chat-thread-read-marks.ts";

interface MarkUnreadArgs {
  readonly threadId: string;
}

export const markChatThreadUnread$ = command(
  async (
    { get, set },
    { threadId }: MarkUnreadArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(apiClient$)(chatThreadMarkUnreadContract);
    await accept(
      client.markUnread({
        params: { id: threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(clearOptimisticReadMark$, threadId);
  },
);
