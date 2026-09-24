import type { ChatTeamsMessageFiles } from "@okouai/db/jsonb-contracts/chat-teams-context";
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

export const chatTeamsContext = pgTable(
  "chat_teams_context",
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
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id"),
    channelId: text("channel_id"),
    conversationId: text("conversation_id").notNull(),
    conversationType: text("conversation_type"),
    activityId: text("activity_id"),
    /**
     * Server-private Teams launch material retained with the trigger context.
     * Raw third-party content is intentionally retained permanently; read paths
     * must continue to project only the explicitly required columns.
     */
    threadContext: text("thread_context"),
    messageText: text("message_text"),
    messageFiles: jsonb("message_files").$type<ChatTeamsMessageFiles>(),
    tenantName: text("tenant_name"),
    teamName: text("team_name"),
    threadId: text("thread_id"),
    serviceUrl: text("service_url"),
    teamsAppId: text("teams_app_id"),
    /** Product brand derived from the Teams webhook hostname at ingress. */
    publicBrand: text("public_brand").$type<PublicBrand>().notNull(),
    senderUserId: text("sender_user_id"),
    senderDisplayName: text("sender_display_name"),
    senderPrincipalName: text("sender_principal_name"),
    connectionId: uuid("connection_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [index("chat_teams_context_thread_idx").on(table.chatThreadId)];
  },
);
