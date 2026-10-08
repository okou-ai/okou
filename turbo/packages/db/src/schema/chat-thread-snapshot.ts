import {
  bigint,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
export const chatThreadSnapshots = pgTable(
  "chat_thread_snapshots",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    latestEventId: uuid("latest_event_id"),
    /** Sequence position represented by the compacted snapshot. */
    latestEventSeqId: bigint("latest_event_seq_id", { mode: "number" }),
    /** Immutable R2 snapshot object; null only in old rows or test fixtures. */
    objectKey: text("object_key"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.orgId] })];
  },
);
