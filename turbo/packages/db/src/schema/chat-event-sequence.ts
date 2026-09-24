import { sql } from "drizzle-orm";
import { bigint, check, pgTable, uuid } from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";

/** Allocation watermark, independent of retained events and archive coverage. */
export const chatEventSequences = pgTable(
  "chat_event_sequences",
  {
    chatThreadId: uuid("chat_thread_id")
      .primaryKey()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    lastSeqId: bigint("last_seq_id", { mode: "number" }).notNull(),
  },
  (table) => {
    return [
      check("chat_event_sequences_nonnegative", sql`${table.lastSeqId} >= 0`),
    ];
  },
);
