import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/** Content-free obligation created by committed usage settlement, not a chat event. */
export const usageChatProjectionWork = pgTable(
  "usage_chat_projection_work",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    desiredRevision: integer("desired_revision").default(1).notNull(),
    appliedRevision: integer("applied_revision").default(0).notNull(),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    failureCount: integer("failure_count").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_usage_chat_projection_due")
      .on(table.availableAt, table.runId)
      .where(sql`${table.appliedRevision} < ${table.desiredRevision}`),
    check(
      "usage_chat_projection_revisions_check",
      sql`${table.desiredRevision} > 0 AND ${table.appliedRevision} >= 0 AND ${table.appliedRevision} <= ${table.desiredRevision}`,
    ),
    check(
      "usage_chat_projection_lease_check",
      sql`(${table.leaseId} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "usage_chat_projection_failures_check",
      sql`${table.failureCount} >= 0`,
    ),
  ],
);
