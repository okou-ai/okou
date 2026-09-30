import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { nowDate } from "../lib/time";

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
