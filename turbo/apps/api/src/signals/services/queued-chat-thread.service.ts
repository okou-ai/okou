import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { asc, gt, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";

type ReadDb = Pick<Db, "selectDistinct">;

/**
 * Record the latest enqueue time for the thread's pending input. Enqueue never
 * touches the lease: from claim to the pending commit the lease is the only
 * mutual exclusion, so a live lease stays with its picker and an empty or
 * expired lease is claimed as usual. `queuedAt` strictly advances (at least
 * 1 ms past the stored value, even under a frozen or skewed clock) so the
 * lease holder's release or empty-queue delete observes the new input and
 * schedules one new pick for the thread.
 */
export async function markChatThreadQueued(
  db: Db | Tx,
  args: { readonly chatThreadId: string; readonly orgId: string },
): Promise<void> {
  const queuedAt = nowDate();
  await db
    .insert(queuedChatThreads)
    .values({
      chatThreadId: args.chatThreadId,
      orgId: args.orgId,
      queuedAt,
    })
    .onConflictDoUpdate({
      target: queuedChatThreads.chatThreadId,
      set: {
        queuedAt: sql`greatest(${sql.param(queuedAt, queuedChatThreads.queuedAt)}, ${queuedChatThreads.queuedAt} + interval '1 millisecond')`,
      },
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
