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
    /** Opaque key of an immutable R2 snapshot object. */
    objectKey: text("object_key"),
    /** SHA-256 of the compressed snapshot bytes, independent of its key. */
    contentDigest: text("content_digest"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.orgId] })];
  },
);
