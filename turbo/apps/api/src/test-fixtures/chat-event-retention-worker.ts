import { createStore } from "ccstate";
import { z } from "zod";

import { recordChatEventRetentionCompleted } from "../signals/routes/cron-retain-chat-events";
import { retainChatEvents$ } from "../signals/services/cron-retain-chat-events.service";

const ownedChatThreadIdsSchema = z.array(z.uuid()).min(1).max(100);

// Run the real bounded retention page for only the calling test's threads.
export async function retainChatEventsForTest(
  chatThreadIds: readonly string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedChatThreadIds = ownedChatThreadIdsSchema.parse(chatThreadIds);
  const result = await createStore().set(
    retainChatEvents$,
    { kind: "fixtures", chatThreadIds: ownedChatThreadIds },
    signal,
  );
  signal.throwIfAborted();
  recordChatEventRetentionCompleted(result);
  return result;
}
