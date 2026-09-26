import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { discordChatThreadRoutes } from "./discord-chat-thread-route";
import { discordOrgConnections } from "./discord-org-connection";

export type DiscordChatIngressStatus =
  | "pending"
  | "processing"
  | "retryable"
  | "processed"
  | "terminal";

/** Durable, deletion-owned message admission before any thread-creation side effect. */
export const discordChatIngress = pgTable(
  "discord_chat_ingress",
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
    routeId: uuid("route_id"),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    messageId: varchar("message_id", { length: 255 }).notNull(),
    payload: text("payload").notNull(),
    status: varchar("status", { length: 16 })
      .$type<DiscordChatIngressStatus>()
      .default("pending")
      .notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    processingAttemptCount: integer("processing_attempt_count")
      .default(0)
      .notNull(),
    /** A processing owner must match this token when completing or retrying its claim. */
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at"),
    retryAt: timestamp("retry_at"),
    lastErrorClass: varchar("last_error_class", { length: 128 }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_discord_chat_ingress_event").on(table.eventId),
      unique("uq_discord_chat_ingress_message").on(table.messageId),
      unique("uq_discord_chat_ingress_connection").on(
        table.id,
        table.connectionId,
      ),
      foreignKey({
        name: "discord_chat_ingress_route_connection_fk",
        columns: [table.routeId, table.connectionId],
        foreignColumns: [
          discordChatThreadRoutes.id,
          discordChatThreadRoutes.connectionId,
        ],
      }).onDelete("cascade"),
      index("idx_discord_chat_ingress_connection").on(table.connectionId),
      index("idx_discord_chat_ingress_route").on(table.routeId),
      index("idx_discord_chat_ingress_retry_sweep").on(
        table.status,
        table.retryAt,
        table.updatedAt,
      ),
      check(
        "chk_discord_chat_ingress_status",
        sql`${table.status} IN ('pending', 'processing', 'retryable', 'processed', 'terminal')`,
      ),
      check(
        "chk_discord_chat_ingress_retry_count",
        sql`${table.retryCount} >= 0`,
      ),
      check(
        "chk_discord_chat_ingress_processing_attempt_count",
        sql`${table.processingAttemptCount} >= 0`,
      ),
      check(
        "chk_discord_chat_ingress_claim",
        sql`(${table.status} = 'processing' AND ${table.claimToken} IS NOT NULL AND ${table.claimedAt} IS NOT NULL) OR (${table.status} <> 'processing' AND ${table.claimToken} IS NULL AND ${table.claimedAt} IS NULL)`,
      ),
    ];
  },
);
