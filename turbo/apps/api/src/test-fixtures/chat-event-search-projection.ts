import { createStore } from "ccstate";
import { z } from "zod";

import { projectChatEventSearchTestScope$ } from "../signals/services/cron-project-chat-event-search.service";

const ownedChatThreadIdsSchema = z.array(z.uuid()).min(1).max(20);

// Run the real finite projector for only the calling test's owned threads.
export async function projectChatEventSearchForTest(
  chatThreadIds: readonly string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedChatThreadIds = ownedChatThreadIdsSchema.parse(chatThreadIds);
  const result = await createStore().set(
    projectChatEventSearchTestScope$,
    { chatThreadIds: ownedChatThreadIds },
    signal,
  );
  signal.throwIfAborted();
  return result;
}
