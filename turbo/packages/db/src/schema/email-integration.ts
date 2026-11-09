import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";

/** A verified sender belongs to one account/workspace at a time, like Phone. */
export const emailUserLinks = pgTable(
  "email_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    emailAddress: text("email_address").notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    disconnectedAt: timestamp("disconnected_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("email_user_links_address_unique").on(table.emailAddress),
      index("email_user_links_member_idx").on(table.userId, table.orgId),
    ];
  },
);

/** Header references are scoped to the sender, never globally trusted. */
export const emailChatThreadRoutes = pgTable(
  "email_chat_thread_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userLinkId: uuid("user_link_id")
      .notNull()
      .references(
        () => {
          return emailUserLinks.id;
        },
        { onDelete: "cascade" },
      ),
    rootMessageId: text("root_message_id").notNull(),
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
      uniqueIndex("email_chat_thread_routes_sender_root_unique").on(
        table.userLinkId,
        table.rootMessageId,
      ),
      index("email_chat_thread_routes_thread_idx").on(table.chatThreadId),
    ];
  },
);

/** Retain the first request across assisted signup; provider IDs deduplicate retries. */
export const emailChannelMessages = pgTable(
  "email_channel_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerEmailId: text("provider_email_id").notNull(),
    sender: text("sender").notNull(),
    messageId: text("message_id").notNull(),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull().default([]),
    attachmentNames: text("attachment_names").array().notNull().default([]),
    attachmentIds: text("attachment_ids").array().notNull().default([]),
    authenticated: boolean("authenticated").notNull(),
    routeId: uuid("route_id").references(
      () => {
        return emailChatThreadRoutes.id;
      },
      {
        onDelete: "cascade",
      },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("email_channel_messages_provider_unique").on(
        table.providerEmailId,
      ),
      uniqueIndex("email_channel_messages_sender_message_unique").on(
        table.sender,
        table.messageId,
      ),
      index("email_channel_messages_route_idx").on(table.routeId),
    ];
  },
);

export const chatEmailContext = pgTable(
  "chat_email_context",
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
    userLinkId: uuid("user_link_id").notNull(),
    emailMessageId: uuid("email_message_id").notNull(),
    messageText: text("message_text").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [index("chat_email_context_thread_idx").on(table.chatThreadId)];
  },
);
