import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { claimQueuedChatThread } from "../signals/services/queued-chat-thread.service";

/**
 * Take a queued thread's pick lease the way a picker does, then stop, as a
 * picker that died mid-launch would. No product API can leave a live lease
 * behind without also finishing the pick.
 */
export async function claimQueuedChatThreadLeaseFixture(
  chatThreadId: string,
): Promise<void> {
  const claim = await claimQueuedChatThread(db(), chatThreadId);
  if (!claim) {
    throw new Error(
      `Expected queued chat thread ${chatThreadId} to have a free lease`,
    );
  }
}

/** The queue-row state, which no product API exposes. */
export async function readQueuedChatThreadFixture(
  chatThreadId: string,
): Promise<{ readonly leased: boolean } | null> {
  const [row] = await db()
    .select({ claimId: queuedChatThreads.claimId })
    .from(queuedChatThreads)
    .where(eq(queuedChatThreads.chatThreadId, chatThreadId))
    .limit(1);
  return row ? { leased: row.claimId !== null } : null;
}
