import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command } from "ccstate";
import { asc, gt, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";

/**
 * Pure enqueue plan for the input-owning command's atomic write. It executes
 * nothing and never receives or captures a database handle. queuedAt advances
 * even under a frozen/skewed clock; no live lease is touched.
 */
export function queuedChatThreadEnqueuePlan(args: {
  readonly chatThreadId: string;
  readonly orgId: string;
}) {
  const queuedAt = nowDate();
  return {
    values: { chatThreadId: args.chatThreadId, orgId: args.orgId, queuedAt },
    conflict: {
      target: queuedChatThreads.chatThreadId,
      set: {
        queuedAt: sql`greatest(${sql.param(queuedAt, queuedChatThreads.queuedAt)}, ${queuedChatThreads.queuedAt} + interval '1 millisecond')`,
      },
    },
  };
}

/** Organizations with queued threads, by org-id keyset, for the cron pass. */
export const listQueuedChatThreadOrgIds$ = command(
  async (
    { get },
    args: { readonly after?: string; readonly limit: number },
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const rows = await get(db$)
      .selectDistinct({ orgId: queuedChatThreads.orgId })
      .from(queuedChatThreads)
      .where(
        args.after === undefined
          ? undefined
          : gt(queuedChatThreads.orgId, args.after),
      )
      .orderBy(asc(queuedChatThreads.orgId))
      .limit(args.limit);
    signal.throwIfAborted();
    return rows.map(({ orgId }) => {
      return orgId;
    });
  },
);
