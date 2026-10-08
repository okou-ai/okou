import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Receipts outlive outbox cleanup and run deletion; content lives only in the outbox. */
export const mailNotifications = pgTable(
  "mail_notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    sourceRunId: uuid("source_run_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    outboxId: uuid("outbox_id"),
    status: text("status", {
      enum: ["queued", "sent", "skipped", "failed"],
    }).notNull(),
    reason: text("reason", {
      enum: [
        "unsubscribed",
        "suppressed",
        "no-email",
        "expired",
        "delivery-failed",
      ],
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("mail_notifications_owner_key_unique").on(
        table.orgId,
        table.userId,
        table.idempotencyKey,
      ),
      uniqueIndex("mail_notifications_outbox_unique").on(table.outboxId),
      index("mail_notifications_user_idx").on(table.userId),
    ];
  },
);
