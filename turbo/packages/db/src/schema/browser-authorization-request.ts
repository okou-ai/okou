import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const browserAuthorizationRequests = pgTable(
  "browser_authorization_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestTokenHash: text("request_token_hash").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id").notNull(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_browser_authorization_requests_token_hash").on(
        table.requestTokenHash,
      ),
      index("idx_browser_authorization_requests_owner").on(
        table.orgId,
        table.userId,
      ),
      index("idx_browser_authorization_requests_expires").on(table.expiresAt),
    ];
  },
);
