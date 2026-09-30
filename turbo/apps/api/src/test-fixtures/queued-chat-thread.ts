import { randomUUID } from "node:crypto";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { nowDate } from "../lib/time";

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

/** Hand the thread's lease to another picker that never releases it. */
export async function holdQueuedChatThreadClaimFixture(args: {
  readonly orgId: string;
  readonly threadId: string;
}): Promise<string> {
  const claimId = randomUUID();
  const at = nowDate();
  const claimExpiresAt = new Date(at.getTime() + 10_000);
  await db()
    .insert(queuedChatThreads)
    .values({
      chatThreadId: args.threadId,
      orgId: args.orgId,
      queuedAt: at,
      claimId,
      claimExpiresAt,
    })
    .onConflictDoUpdate({
      target: queuedChatThreads.chatThreadId,
      set: { claimId, claimExpiresAt },
    });
  return claimId;
}
