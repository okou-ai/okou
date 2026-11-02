import {
  bigint,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** One immutable R2 metadata snapshot pointer per private user/org stream. */
export const projectSnapshots = pgTable(
  "project_snapshots",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    latestEventId: uuid("latest_event_id"),
    latestEventSeqId: bigint("latest_event_seq_id", { mode: "number" }),
    objectKey: text("object_key"),
    contentDigest: text("content_digest"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.orgId] })];
  },
);
