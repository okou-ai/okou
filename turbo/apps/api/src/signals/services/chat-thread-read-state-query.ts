import { and, desc, eq, sql } from "drizzle-orm";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import type { chatThreads } from "@okouai/db/schema/chat-thread";

import type { Db } from "../external/db";

/**
 * The newest Run terminal marker that can leave one thread unread, or no row
 * when the thread has no finished Run. The ordering matches the partial index
 * `idx_chat_events_thread_run_terminal_created`.
 */
export function latestReadWatermarkEventSubquery(
  db: Pick<Db, "select">,
  threadId: string | typeof chatThreads.id,
) {
  return db
    .select({ createdAt: chatEvents.createdAt })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTerminalPredicate(chatEvents.eventType),
      ),
    )
    .orderBy(sql`${desc(chatEvents.createdAt)} NULLS LAST`, desc(chatEvents.id))
    .limit(1)
    .as("latest_read_watermark_event");
}
