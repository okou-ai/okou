import {
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { WechatAttachments } from "../jsonb-contracts/wechat";
import { chatThreads } from "./chat-thread";

/** One scanner identity belongs to exactly one Okou owner/workspace. */
export const wechatConnections = pgTable(
  "wechat_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    senderId: text("sender_id").notNull(),
    botId: text("bot_id").notNull(),
    generation: uuid("generation").defaultRandom().notNull(),
    baseUrl: text("base_url").notNull(),
    tokenCiphertext: text("token_ciphertext").notNull(),
    status: text("status")
      .$type<"active" | "reconnect_required" | "disconnected">()
      .notNull()
      .default("active"),
    updatesCursor: text("updates_cursor").notNull().default(""),
    // A fetched batch and its cursor are saved together before dispatch. A retry
    // finishes this encrypted batch before fetching more messages.
    pendingBatchCiphertext: text("pending_batch_ciphertext"),
    // Reusing a disconnected transport must not turn its backlog into new prompts.
    resumedAt: timestamp("resumed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => {
    return [
      uniqueIndex("wechat_connections_owner_idx").on(t.orgId, t.userId),
      uniqueIndex("wechat_connections_sender_idx").on(t.senderId),
    ];
  },
);

export const wechatConnectAttempts = pgTable(
  "wechat_connect_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    qrCiphertext: text("qr_ciphertext").notNull(),
    baseUrl: text("base_url").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => {
    return [
      uniqueIndex("wechat_connect_attempts_owner_idx").on(t.orgId, t.userId),
    ];
  },
);

export const wechatChatThreadRoutes = pgTable(
  "wechat_chat_thread_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return wechatConnections.id;
        },
        { onDelete: "cascade" },
      ),
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
  (t) => {
    return [
      uniqueIndex("wechat_chat_thread_routes_connection_idx").on(
        t.connectionId,
      ),
      index("wechat_chat_thread_routes_thread_idx").on(t.chatThreadId),
    ];
  },
);

/** Private routing snapshot. Only explicitly selected metadata reaches prompts. */
export const chatWechatContext = pgTable(
  "chat_wechat_context",
  {
    id: uuid("id").primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return wechatConnections.id;
        },
        { onDelete: "cascade" },
      ),
    generation: uuid("generation").notNull(),
    senderId: text("sender_id").notNull(),
    botId: text("bot_id").notNull(),
    messageId: text("message_id").notNull(),
    contextTokenCiphertext: text("context_token_ciphertext").notNull(),
    quotedText: text("quoted_text"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => {
    return [index("chat_wechat_context_thread_idx").on(t.chatThreadId)];
  },
);

/** Provider receipts, not generated assistant output. Disconnect revokes this archive. */
export const wechatMessages = pgTable(
  "wechat_messages",
  {
    id: uuid("id").primaryKey(),
    sequence: bigserial("sequence", { mode: "bigint" }).notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return wechatConnections.id;
        },
        { onDelete: "cascade" },
      ),
    generation: uuid("generation").notNull(),
    providerMessageId: text("provider_message_id"),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    status: text("status").$type<"received" | "sent" | "unknown">().notNull(),
    content: text("content").notNull(),
    quotedText: text("quoted_text"),
    requestHash: text("request_hash"),
    attachments: jsonb("attachments")
      .$type<WechatAttachments>()
      .notNull()
      .default([]),
    mediaCiphertext: text("media_ciphertext"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => {
    return [
      index("wechat_messages_connection_sequence_idx").on(
        t.connectionId,
        t.sequence,
      ),
      check(
        "wechat_messages_delivery_check",
        sql`(${t.direction} = 'inbound' AND ${t.status} = 'received') OR (${t.direction} = 'outbound' AND ${t.status} IN ('sent', 'unknown'))`,
      ),
    ];
  },
);
