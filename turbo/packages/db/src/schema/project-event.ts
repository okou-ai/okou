import {
  bigint,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const projectEventKind = pgEnum("project_event_kind", [
  "created",
  "renamed",
  "deleted",
]);

/** Sequence reservation and event publication must share one atomic statement. */
export const projectEventSequences = pgTable(
  "project_event_sequences",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    lastSeqId: bigint("last_seq_id", { mode: "number" }).default(0).notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.orgId] })];
  },
);

/** No Project FK: deletion tombstones must outlive the identity row. */
export const projectEvents = pgTable(
  "project_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    seqId: bigint("seq_id", { mode: "number" }).notNull(),
    projectId: uuid("project_id").notNull(),
    kind: projectEventKind("kind").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("project_events_user_org_seq_unique").on(
        table.userId,
        table.orgId,
        table.seqId,
      ),
      index("project_events_project_idx").on(table.projectId),
    ];
  },
);
