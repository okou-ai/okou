import { sql } from "drizzle-orm";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { slackChatThreadRoutes } from "./slack-chat-thread-route";

export type SlackChatIngressStatus =
  | "pending"
  | "processing"
  | "retryable"
  | "processed"
  | "failed"
  | "terminal";

/**
 * Durable admission record for canonical Slack events. Slack retries reuse the
 * same event ID, so this table is the canonical path's deduplication boundary.
 */
export const slackChatIngress = pgTable(
  "slack_chat_ingress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    routeId: uuid("route_id")
      .notNull()
      .references(
        () => {
          return slackChatThreadRoutes.id;
        },
        { onDelete: "cascade" },
      ),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    payload: text("payload").notNull(),
    /** Product brand derived from the Slack webhook hostname at ingress. */
    publicBrand: text("public_brand").$type<PublicBrand>().notNull(),
    status: varchar("status", { length: 16 })
      .$type<SlackChatIngressStatus>()
      .default("pending")
      .notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    processingAttemptCount: integer("processing_attempt_count")
      .default(0)
      .notNull(),
    retryAt: timestamp("retry_at"),
    lastErrorClass: varchar("last_error_class", { length: 128 }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_slack_chat_ingress_event_id").on(table.eventId),
      index("idx_slack_chat_ingress_retry_sweep").on(
        table.status,
        table.retryAt,
        table.updatedAt,
      ),
      check(
        "chk_slack_chat_ingress_status",
        sql`${table.status} IN ('pending', 'processing', 'retryable', 'processed', 'failed', 'terminal')`,
      ),
      check(
        "chk_slack_chat_ingress_retry_count",
        sql`${table.retryCount} >= 0`,
      ),
      check(
        "chk_slack_chat_ingress_processing_attempt_count",
        sql`${table.processingAttemptCount} >= 0`,
      ),
    ];
  },
);
