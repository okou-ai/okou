import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentphoneUserLinks } from "./agentphone-user-link";
import { chatThreads } from "./chat-thread";

/**
 * Stable mapping from an AgentPhone conversation identity to the canonical
 * Okou chat thread that owns its queue and session chain.
 */
export const agentphoneChatThreadRoutes = pgTable(
  "agentphone_chat_thread_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentphoneUserLinkId: uuid("agentphone_user_link_id")
      .notNull()
      .references(
        () => {
          return agentphoneUserLinks.id;
        },
        { onDelete: "cascade" },
      ),
    rootMessageId: varchar("root_message_id", { length: 255 }).notNull(),
    conversationId: varchar("conversation_id", { length: 255 }),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_agentphone_chat_thread_routes_thread").on(table.chatThreadId),
      uniqueIndex("idx_agentphone_chat_thread_routes_link_root").on(
        table.agentphoneUserLinkId,
        table.rootMessageId,
      ),
      index("idx_agentphone_chat_thread_routes_user_link").on(
        table.agentphoneUserLinkId,
      ),
      index("idx_agentphone_chat_thread_routes_conversation").on(
        table.conversationId,
      ),
    ];
  },
);
