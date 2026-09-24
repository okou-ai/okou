import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  index,
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatAgentphoneContext = pgTable(
  "chat_agentphone_context",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    /**
     * Server-private AgentPhone launch material retained with the trigger
     * context. Phone numbers are personal data; safety depends on read paths
     * projecting only explicitly required columns, never whole rows.
     */
    messageText: text("message_text"),
    threadContext: text("thread_context"),
    messageId: text("message_id"),
    rootMessageId: text("root_message_id"),
    conversationId: text("conversation_id"),
    groupId: text("group_id"),
    channel: text("channel").$type<"imessage" | "sms" | "mms">(),
    isGroup: boolean("is_group"),
    phoneHandle: text("phone_handle"),
    fromNumber: text("from_number"),
    toNumber: text("to_number"),
    userLinkId: uuid("user_link_id"),
    agentphoneAgentId: text("agentphone_agent_id"),
    /** Product brand derived from the webhook hostname; null only for pre-rollout contexts. */
    publicBrand: text("public_brand").$type<PublicBrand>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("chat_agentphone_context_thread_idx").on(table.chatThreadId),
  ],
);
