import { createStore } from "ccstate";
import { z } from "zod";

import { now } from "../lib/time";
import {
  cleanupExpiredEmailOutboxItems$,
  drainEmailOutboxItems$,
} from "../signals/services/email-common.service";

const emailOutboxItemIdsSchema = z.array(z.string().uuid()).min(1);

// Drive the real workers for the calling test's explicitly owned outbox items.
export async function drainEmailOutboxItemsForTest(
  itemIds: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const ownedItemIds = emailOutboxItemIdsSchema.parse(itemIds);
  const drained = await createStore().set(
    drainEmailOutboxItems$,
    { currentTimeMs: now(), itemIds: ownedItemIds },
    signal,
  );
  signal.throwIfAborted();
  return drained;
}

export async function cleanupExpiredEmailOutboxItemsForTest(
  itemIds: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const ownedItemIds = emailOutboxItemIdsSchema.parse(itemIds);
  const cleaned = await createStore().set(
    cleanupExpiredEmailOutboxItems$,
    { currentTimeMs: now(), itemIds: ownedItemIds },
    signal,
  );
  signal.throwIfAborted();
  return cleaned;
}
