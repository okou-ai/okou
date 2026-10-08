import { command } from "ccstate";
import { chatThreadMarkReadContract } from "@okouai/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { recordOptimisticReadMark$ } from "./optimistic-chat-thread-read-marks.ts";

interface MarkReadArgs {
  readonly threadId: string;
}

export const markChatThreadRead$ = command(
  async (
    { get, set },
    { threadId }: MarkReadArgs,
    signal: AbortSignal,
  ): Promise<string | null> => {
    set(recordOptimisticReadMark$, threadId);
    const client = get(apiClient$)(chatThreadMarkReadContract);
    const result = await accept(
      client.markRead({
        params: { id: threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body.lastReadAt;
  },
);
