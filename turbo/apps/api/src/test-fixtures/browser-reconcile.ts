import { createStore } from "ccstate";
import { z } from "zod";

import { reconcileBrowserFixtures$ } from "../signals/services/browser.service";

const ownedChatThreadIdsSchema = z.array(z.uuid()).min(1).max(20);

// Invoke the real finite worker for only the threads owned by the calling test.
export async function reconcileBrowsersForTest(
  chatThreadIds: readonly string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedChatThreadIds = ownedChatThreadIdsSchema.parse(chatThreadIds);
  const result = await createStore().set(
    reconcileBrowserFixtures$,
    ownedChatThreadIds,
    signal,
  );
  signal.throwIfAborted();
  return result;
}
