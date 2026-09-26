import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

/**
 * One row per chat thread that has input waiting to be picked into a run.
 *
 * The row stores no content: the thread's pending `input.prompt` and
 * `input.automation` events in `chat_events` remain the queue. Enqueue inserts
 * the row, and a picker takes a short compare-and-set lease on it before it
 * launches the thread's queue head. The lease only avoids duplicate work;
 * the per-thread active-run index and each event's unique revoke edge remain
 * the mutual exclusion. The lease columns are intentionally unindexed.
 */
export const queuedChatThreads = pgTable(
  "queued_chat_threads",
  {
    chatThreadId: uuid("chat_thread_id")
      .primaryKey()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    queuedAt: timestamp("queued_at").notNull(),
    claimId: uuid("claim_id"),
    claimExpiresAt: timestamp("claim_expires_at"),
  },
  (table) => {
    return [
      index("queued_chat_threads_org_queued_at_idx").on(
        table.orgId,
        table.queuedAt,
      ),
    ];
  },
);
