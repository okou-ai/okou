import { sql, type SQLWrapper } from "drizzle-orm";
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

const MAX_NOTIFICATION_PAGES = 10;

function notificationPayloadCheck(payload: SQLWrapper) {
  const pages = sql`${payload}->'pages'`;
  const pageChecks = Array.from(
    { length: MAX_NOTIFICATION_PAGES },
    (_, index) => {
      const page = sql`(${pages}->${index})`;
      return sql`(${page} IS NULL OR (
      jsonb_typeof(${page}) = 'object'
      AND jsonb_typeof(${page}->'markdown') = 'string'
      AND length(${page}->>'markdown') BETWEEN 1 AND 50000
    ))`;
    },
  );
  return sql`(jsonb_typeof(${payload}) = 'object' AND CASE
    WHEN ${payload}->>'type' = 'rich_text' THEN (
      jsonb_typeof(${payload}->'markdown') = 'string'
      AND length(${payload}->>'markdown') BETWEEN 1 AND 50000
    )
    WHEN ${payload}->>'type' = 'carousel' AND jsonb_typeof(${pages}) = 'array' THEN (
      jsonb_array_length(${pages}) BETWEEN 2 AND ${MAX_NOTIFICATION_PAGES}
      AND ${sql.join(pageChecks, sql` AND `)}
    )
    ELSE false END) IS TRUE`.inlineParams();
}

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
        notificationPayloadCheck(table.payload),
      ),
    ];
  },
);
