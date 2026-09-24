import type { ChatFeishuMessageFiles } from "@okouai/db/jsonb-contracts/chat-feishu-context";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  index,
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatFeishuContext = pgTable(
  "chat_feishu_context",
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
     * Server-private Feishu launch material retained with the trigger context.
     * Raw third-party content is intentionally retained permanently; read paths
     * must continue to project only the explicitly required columns.
     */
    conversationHistory: text("conversation_history"),
    /**
     * Product brand snapshotted from the webhook ingress. Null is limited to
     * rows written by the previous API during the additive #28935 rollout or
     * retained from before this column existed; new writers always set it.
     */
    publicBrand: text("public_brand").$type<PublicBrand>(),
    messageText: text("message_text"),
    messageFiles: jsonb("message_files").$type<ChatFeishuMessageFiles>(),
    chatType: text("chat_type").$type<"group" | "p2p" | "topic_group">(),
    chatId: text("chat_id"),
    messageId: text("message_id"),
    threadId: text("thread_id"),
    replyInThread: boolean("reply_in_thread"),
    reactionId: text("reaction_id"),
    senderOpenId: text("sender_open_id"),
    connectionId: uuid("connection_id"),
    installationId: uuid("installation_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("chat_feishu_context_thread_idx").on(table.chatThreadId)],
);
