import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import type { Db } from "../external/db";

/**
 * The newest Run terminal marker per thread for a bounded set of thread ids,
 * read as one indexed `DISTINCT ON` query. Threads without a finished Run are
 * absent from the map.
 */
export async function loadLatestReadWatermarks(
  db: Pick<Db, "selectDistinctOn">,
  threadIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> {
  if (threadIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .selectDistinctOn([chatEvents.chatThreadId], {
      threadId: chatEvents.chatThreadId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        inArray(chatEvents.chatThreadId, [...threadIds]),
        chatEventTerminalPredicate(chatEvents.eventType),
      ),
    )
    .orderBy(
      chatEvents.chatThreadId,
      desc(chatEvents.createdAt),
      desc(chatEvents.id),
    );
  return new Map(
    rows.map((row) => {
      return [row.threadId, row.createdAt] as const;
    }),
  );
}

/**
 * Advances one thread's read cursor to `watermark` with a single-row
 * compare-and-set. Returns false when the thread is missing, belongs to another
 * user, or already has an equal or newer cursor; a lost race is not retried.
 */
export async function advanceChatThreadReadCursor(
  db: Pick<Db, "update">,
  args: {
    readonly threadId: string;
    readonly userId: string;
    readonly watermark: Date;
  },
): Promise<boolean> {
  const updated = await db
    .update(chatThreads)
    .set({ lastReadAt: args.watermark })
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
        or(
          isNull(chatThreads.lastReadAt),
          lt(chatThreads.lastReadAt, args.watermark),
        ),
      ),
    )
    .returning({ id: chatThreads.id });
  return updated.length > 0;
}
