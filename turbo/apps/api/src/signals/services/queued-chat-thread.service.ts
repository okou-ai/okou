import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { asc, gt } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";

type ReadDb = Pick<Db, "selectDistinct">;

/**
 * Record the latest enqueue time for the thread's pending input.
 * New input also clears any lease: a picker that read the queue as empty
 * before this input committed then deletes or releases zero rows, the row
 * survives, and the enqueuer's own pick can take the lease.
 */
export async function markChatThreadQueued(
  db: Db | Tx,
  args: { readonly chatThreadId: string; readonly orgId: string },
): Promise<void> {
  await db
    .insert(queuedChatThreads)
    .values({
      chatThreadId: args.chatThreadId,
      orgId: args.orgId,
      queuedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: queuedChatThreads.chatThreadId,
      set: { queuedAt: nowDate(), claimId: null, claimExpiresAt: null },
    });
}

/**
 * Organizations that have queued threads, by org id keyset. The cron walks
 * every page; each organization is then picked to its concurrency limit.
 */
export async function listQueuedChatThreadOrgIds(
  db: ReadDb,
  args: { readonly after?: string; readonly limit: number },
): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ orgId: queuedChatThreads.orgId })
    .from(queuedChatThreads)
    .where(
      args.after === undefined
        ? undefined
        : gt(queuedChatThreads.orgId, args.after),
    )
    .orderBy(asc(queuedChatThreads.orgId))
    .limit(args.limit);
  return rows.map(({ orgId }) => {
    return orgId;
  });
}
