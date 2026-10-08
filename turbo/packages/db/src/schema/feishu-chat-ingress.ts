import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { feishuOrgInstallations } from "./feishu-org-installation";

export type FeishuChatIngressStatus =
  | "pending"
  | "processing"
  | "processed"
  | "failed";

/**
 * Durable receipt for a verified Feishu message event. The provider is
 * acknowledged only after this row and the cross-version dedupe row commit.
 */
export const feishuChatIngress = pgTable(
  "feishu_chat_ingress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(
        () => {
          return feishuOrgInstallations.id;
        },
        { onDelete: "cascade" },
      ),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    payload: text("payload").notNull(),
    status: varchar("status", { length: 16 })
      .$type<FeishuChatIngressStatus>()
      .default("pending")
      .notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    reactionId: varchar("reaction_id", { length: 255 }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_feishu_chat_ingress_installation_event").on(
        table.installationId,
        table.eventId,
      ),
      check(
        "chk_feishu_chat_ingress_status",
        sql`${table.status} IN ('pending', 'processing', 'processed', 'failed')`,
      ),
      check(
        "chk_feishu_chat_ingress_retry_count",
        sql`${table.retryCount} >= 0`,
      ),
    ];
  },
);
