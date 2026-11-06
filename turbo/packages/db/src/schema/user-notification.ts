import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { UserNotificationPayload } from "../jsonb-contracts/user-notification";

/** Insert one row per recipient. Read receipts are personal, across workspaces. */
export const userNotifications = pgTable(
  "user_notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").$type<UserNotificationPayload>().notNull(),
    deliveryKey: text("delivery_key"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    readAt: timestamp("read_at", { withTimezone: true, precision: 3 }),
  },
  (table) => {
    return [
      index("idx_user_notifications_inbox").on(
        table.userId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
      index("idx_user_notifications_unread")
        .on(table.userId, table.createdAt)
        .where(sql`${table.readAt} IS NULL`),
      uniqueIndex("uq_user_notifications_delivery").on(
        table.userId,
        table.deliveryKey,
      ),
      check(
        "chk_user_notification_title",
        sql`length(trim(${table.title})) BETWEEN 1 AND 200`,
      ),
      check(
        "chk_user_notification_summary",
        sql`length(${table.summary}) <= 500`,
      ),
      check(
        "chk_user_notification_payload",
        sql`(
    jsonb_typeof(${table.payload}) = 'object'
    AND ${table.payload}->>'type' = 'rich_text'
    AND jsonb_typeof(${table.payload}->'markdown') = 'string'
    AND length(${table.payload}->>'markdown') BETWEEN 1 AND 50000
    AND (NOT (${table.payload} ? 'action') OR (
      jsonb_typeof(${table.payload}->'action') = 'object'
      AND jsonb_typeof(${table.payload}->'action'->'label') = 'string'
      AND length(trim(${table.payload}->'action'->>'label')) BETWEEN 1 AND 80
      AND jsonb_typeof(${table.payload}->'action'->'url') = 'string'
      AND ${table.payload}->'action'->>'url' ~ '^https://'
      AND length(${table.payload}->'action'->>'url') <= 2048
    ))
  ) IS TRUE`,
      ),
    ];
  },
);
