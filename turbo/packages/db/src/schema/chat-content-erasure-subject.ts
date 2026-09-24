import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/** Confirmed deletion receipts retained after the temporary erasure jobs retire.
 * These receipts only authorize maintenance of late chat content, never access.
 */
export const chatContentErasureSubjects = pgTable(
  "chat_content_erasure_subjects",
  {
    subjectKind: varchar("subject_kind", {
      length: 16,
      enum: ["user", "organization"],
    }).notNull(),
    subjectId: text("subject_id").notNull(),
    sourceReference: text("source_reference").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    nextSweepAt: timestamp("next_sweep_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.subjectKind, table.subjectId] }),
      check(
        "chat_content_erasure_subject_kind",
        sql`${table.subjectKind} IN ('user', 'organization')`,
      ),
      index("chat_content_erasure_next_sweep")
        .on(table.nextSweepAt, table.subjectKind, table.subjectId)
        .where(sql`${table.completedAt} IS NOT NULL`),
    ];
  },
);
