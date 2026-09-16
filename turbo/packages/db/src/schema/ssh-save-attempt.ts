import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Terminal, secret-free receipts survive resource deletion: forgetting an attempt
// would let a delayed request create resources again. Final owner erasure removes them.
export const sshSaveAttempts = pgTable(
  "ssh_save_attempts",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    saved: boolean("saved").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId, table.attemptId] }),
      index("idx_ssh_save_attempts_user").on(table.userId),
    ];
  },
);
