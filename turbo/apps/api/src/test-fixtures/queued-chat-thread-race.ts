import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { loadChatQueueHead } from "../signals/services/chat-event-queue.service";
import {
  claimQueuedChatThread,
  deleteQueuedChatThread,
  markChatThreadQueued,
} from "../signals/services/queued-chat-thread.service";

export interface QueuedChatThreadRowFixture {
  readonly orgId: string;
  readonly queuedAt: Date;
  readonly claimId: string | null;
  readonly claimExpiresAt: Date | null;
}

/** Read the thread's queue row; null when the thread is not queued. */
export async function readQueuedChatThreadFixture(
  chatThreadId: string,
): Promise<QueuedChatThreadRowFixture | null> {
  const [row] = await db()
    .select({
      orgId: queuedChatThreads.orgId,
      queuedAt: queuedChatThreads.queuedAt,
      claimId: queuedChatThreads.claimId,
      claimExpiresAt: queuedChatThreads.claimExpiresAt,
    })
    .from(queuedChatThreads)
    .where(eq(queuedChatThreads.chatThreadId, chatThreadId));
  return row ?? null;
}

/** Record a queue row the way enqueue does, without appending input. */
export async function markChatThreadQueuedFixture(args: {
  readonly chatThreadId: string;
  readonly orgId: string;
}): Promise<void> {
  await markChatThreadQueued(db(), args);
}

/** Remove the queue row, as an older API instance never wrote one. */
export async function removeQueuedChatThreadFixture(
  chatThreadId: string,
): Promise<void> {
  await db()
    .delete(queuedChatThreads)
    .where(eq(queuedChatThreads.chatThreadId, chatThreadId));
}

/**
 * Interleave a picker with an enqueue: the picker takes the lease and reads an
 * empty queue head, `enqueue` appends input and runs the enqueue path, then
 * the picker deletes the row by its own (now stale) claim.
 */
export async function pickEmptyHeadAcrossEnqueueFixture(args: {
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly enqueue: () => Promise<void>;
}): Promise<{ readonly staleClaimId: string }> {
  await markChatThreadQueued(db(), {
    chatThreadId: args.chatThreadId,
    orgId: args.orgId,
  });
  const claim = await claimQueuedChatThread(db(), args.chatThreadId);
  if (!claim) {
    throw new Error("Expected the picker to take the queue lease");
  }
  const head = await loadChatQueueHead(db(), args.chatThreadId);
  if (head) {
    throw new Error("Expected the picker to read an empty queue head");
  }
  await args.enqueue();
  await deleteQueuedChatThread(db(), claim);
  return { staleClaimId: claim.claimId };
}
