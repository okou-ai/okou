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
    // The sender key remains joinable to the account connection even while
    // the opaque payload is queued or the provider event is replayed.
    senderOpenId: varchar("sender_open_id", { length: 255 }),
    // Frozen at admission. A later disconnect or rebind cannot reassign the
    // queued payload to another Okou account. NULL with a sender key means the
    // sender had no account binding when this event was admitted.
    ownerUserId: text("owner_user_id"),
    /**
     * Product brand derived from the Feishu webhook hostname at ingress. Null
     * is limited to the previous API writer during the additive #28935
     * rollout; the current webhook writer always sets it.
     */
    publicBrand: text("public_brand").$type<PublicBrand>(),
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
      index("feishu_chat_ingress_unattributed_idx")
        .on(table.id)
        .where(sql`${table.senderOpenId} IS NULL`),
      index("feishu_chat_ingress_owner_user_id_idx").on(table.ownerUserId),
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
