import type {
  ChatSlackMentionDisplayNames,
  ChatSlackMessageAssets,
  ChatSlackMessageFiles,
} from "@okouai/db/jsonb-contracts/chat-slack-context";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

/**
 * Complete launch context for one Slack-triggered chat run, addressed by the
 * owning chat event through `(context_type = 'slack', context_id)`.
 *
 * Every value the agent prompt and Slack system prompt render from is
 * snapshotted here at ingress, so a launch reads exactly one row and never has
 * to re-resolve Slack state, workspace state, or canonical input assets.
 */
export const chatSlackContext = pgTable(
  "chat_slack_context",
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
    channelId: text("channel_id"),
    messageTs: text("message_ts"),
    /** Bot user ID of the installation that received the message. */
    botUserId: text("bot_user_id"),
    /**
     * Product brand derived from the Slack webhook hostname at ingress.
     */
    publicBrand: text("public_brand").$type<PublicBrand>().notNull(),
    /**
     * Server-private Slack launch material retained with the trigger context.
     * Raw third-party content is intentionally retained permanently; read paths
     * must continue to project only the explicitly required columns.
     */
    conversationContext: text("conversation_context"),
    messageText: text("message_text"),
    messageFiles: jsonb("message_files").$type<ChatSlackMessageFiles>(),
    /** Canonical input assets materialized for `message_files`. */
    messageAssets: jsonb("message_assets").$type<ChatSlackMessageAssets>(),
    mentionDisplayNames: jsonb(
      "mention_display_names",
    ).$type<ChatSlackMentionDisplayNames>(),
    senderDisplayName: text("sender_display_name"),
    senderUserId: text("sender_user_id"),
    channelType: text("channel_type").$type<"channel" | "dm" | "group_dm">(),
    threadTs: text("thread_ts"),
    routeThreadTs: text("route_thread_ts"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("chat_slack_context_thread_idx").on(table.chatThreadId)],
);
