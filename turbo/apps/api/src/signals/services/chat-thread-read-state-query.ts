import { and, desc, eq } from "drizzle-orm";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import type { chatThreads } from "@okouai/db/runtime/chat-thread";

import type { Db } from "../external/db";

/**
 * The newest Run terminal marker that can leave one thread unread, or no row
 * when the thread has no finished Run. `created_at` is `NOT NULL`, so the
 * plain descending order matches the partial index
 * `idx_chat_events_thread_run_terminal_created`; `id` only breaks ties.
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
    .orderBy(desc(chatEvents.createdAt), desc(chatEvents.id))
    .limit(1)
    .as("latest_read_watermark_event");
}
