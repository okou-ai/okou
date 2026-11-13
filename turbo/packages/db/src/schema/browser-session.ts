import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { BrowserUserActionState } from "@okouai/api-contracts/contracts/browser-user-actions";
import type { BrowserUserActionPayload } from "@okouai/db/jsonb-contracts/browser-user-action";

import { chatThreads } from "./chat-thread";

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

export const browserUserActionRequests = pgTable(
  "browser_user_action_requests",
  {
    requestTokenHash: text("request_token_hash").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    status: varchar("status", { length: 20 })
      .$type<BrowserUserActionState>()
      .notNull(),
    providerSessionId: uuid("provider_session_id").notNull(),
    payload: jsonb("payload").$type<BrowserUserActionPayload>().notNull(),
    applyStartedAt: timestamp("apply_started_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      index("idx_browser_user_action_requests_owner").on(
        table.orgId,
        table.userId,
      ),
      index("idx_browser_user_action_requests_user").on(table.userId),
      index("idx_browser_user_action_requests_thread").on(table.chatThreadId),
      index("idx_browser_user_action_requests_provider_state").on(
        table.providerSessionId,
        table.status,
      ),
    ];
  },
);

/**
 * Durable cleanup identities for immutable screenshot candidates, including
 * rejected uploads. An accepted preview keeps its identity dormant while the
 * screenshot pointer references it; replacement/removal makes it eligible.
 * The row deliberately has no thread foreign key: cleanup must remain retryable
 * after the owning thread is deleted.
 */
export const browserSessionScreenshotDeletions = pgTable(
  "browser_session_screenshot_deletions",
  {
    objectKey: text("object_key").primaryKey(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);
