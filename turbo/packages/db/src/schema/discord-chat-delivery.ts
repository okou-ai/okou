import type { DiscordChatDeliveryParts } from "@okouai/db/jsonb-contracts/discord-chat-delivery";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { chatEvents } from "./chat-event";
import { chatThreads } from "./chat-thread";
import { discordChatIngress } from "./discord-chat-ingress";
import { discordChatThreadRoutes } from "./discord-chat-thread-route";
import { discordOrgConnections } from "./discord-org-connection";

export const discordChatDeliveries = pgTable(
  "discord_chat_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return discordOrgConnections.id;
        },
        { onDelete: "cascade" },
      ),
    ingressId: uuid("ingress_id").references(
      () => {
        return discordChatIngress.id;
      },
      {
        onDelete: "cascade",
      },
    ),
    chatEventId: uuid("chat_event_id").references(
      () => {
        return chatEvents.id;
      },
      {
        onDelete: "cascade",
      },
    ),
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      {
        onDelete: "cascade",
      },
    ),
    routeId: uuid("route_id").references(
      () => {
        return discordChatThreadRoutes.id;
      },
      {
        onDelete: "cascade",
      },
    ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    content: text("content").notNull(),
    parts: jsonb("parts").$type<DiscordChatDeliveryParts>(),
    status: text("status")
      .$type<"pending" | "delivered" | "failed" | "suppressed">()
      .default("pending")
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at"),
    retryAt: timestamp("retry_at"),
    deliveredAt: timestamp("delivered_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_discord_chat_deliveries_event").on(table.chatEventId),
      uniqueIndex("idx_discord_chat_deliveries_ingress").on(table.ingressId),
      index("idx_discord_chat_deliveries_pending").on(
        table.status,
        table.lastAttemptAt,
      ),
      index("idx_discord_chat_deliveries_owner").on(table.orgId, table.userId),
      index("idx_discord_chat_deliveries_connection").on(table.connectionId),
      index("idx_discord_chat_deliveries_thread").on(table.chatThreadId),
      index("idx_discord_chat_deliveries_route").on(table.routeId),
      foreignKey({
        name: "discord_chat_deliveries_event_thread_fk",
        columns: [table.chatEventId, table.chatThreadId],
        foreignColumns: [chatEvents.id, chatEvents.chatThreadId],
      }).onDelete("cascade"),
      foreignKey({
        name: "discord_chat_deliveries_connection_owner_fk",
        columns: [table.connectionId, table.userId],
        foreignColumns: [
          discordOrgConnections.id,
          discordOrgConnections.userId,
        ],
      }).onDelete("cascade"),
      foreignKey({
        name: "discord_chat_deliveries_route_owner_fk",
        columns: [table.routeId, table.connectionId, table.chatThreadId],
        foreignColumns: [
          discordChatThreadRoutes.id,
          discordChatThreadRoutes.connectionId,
          discordChatThreadRoutes.chatThreadId,
        ],
      }).onDelete("cascade"),
      foreignKey({
        name: "discord_chat_deliveries_ingress_owner_fk",
        columns: [table.ingressId, table.connectionId],
        foreignColumns: [
          discordChatIngress.id,
          discordChatIngress.connectionId,
        ],
      }).onDelete("cascade"),
      check(
        "discord_chat_deliveries_source_check",
        sql`(${table.chatEventId} IS NOT NULL AND ${table.ingressId} IS NULL AND ${table.chatThreadId} IS NOT NULL AND ${table.routeId} IS NOT NULL) OR (${table.chatEventId} IS NULL AND ${table.ingressId} IS NOT NULL AND ${table.chatThreadId} IS NULL AND ${table.routeId} IS NULL)`,
      ),
      check(
        "discord_chat_deliveries_status_check",
        sql`${table.status} IN ('pending', 'delivered', 'failed', 'suppressed')`,
      ),
    ];
  },
);
