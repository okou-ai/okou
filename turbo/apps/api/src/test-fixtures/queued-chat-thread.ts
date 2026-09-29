import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";

/** Queue lease ownership has no public response representation. */
export async function readQueuedChatThreadClaimFixture(threadId: string) {
  const [claim] = await db()
    .select({
      claimId: queuedChatThreads.claimId,
      claimExpiresAt: queuedChatThreads.claimExpiresAt,
    })
    .from(queuedChatThreads)
    .where(eq(queuedChatThreads.chatThreadId, threadId));
  return claim;
}
