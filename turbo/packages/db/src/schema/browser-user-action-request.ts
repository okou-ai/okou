import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { BrowserUserActionState } from "@okouai/api-contracts/contracts/browser-user-actions";
import type { BrowserUserActionPayload } from "@okouai/db/jsonb-contracts/browser-user-action";
import { chatThreads } from "./chat-thread";

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
