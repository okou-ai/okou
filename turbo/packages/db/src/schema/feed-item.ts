import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  FeedItemContent,
  FeedItemState,
  FeedItemType,
} from "../jsonb-contracts/feed-item";

/** One owner-scoped item; each type owns its content and interaction state. */
export const feedItems = pgTable(
  "feed_items",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    id: uuid("id").notNull(),
    type: text("type").$type<FeedItemType>().notNull(),
    priority: integer("priority").notNull().default(0),
    content: jsonb("content").$type<FeedItemContent>(),
    state: jsonb("state").$type<FeedItemState>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId, table.id] }),
      check("feed_items_type", sql`${table.type} = 'suggestion'`),
      check(
        "feed_items_suggestion_state",
        sql`(
    jsonb_typeof(${table.state}) = 'object'
    AND ${table.state}->>'status' IN ('active', 'consumed', 'removed')
    AND ${table.state} ? 'selectedOptionId'
    AND (${table.state}->'selectedOptionId' = 'null'::jsonb OR jsonb_typeof(${table.state}->'selectedOptionId') = 'string')
    AND jsonb_typeof(${table.state}->'feedbacks') = 'array'
    AND jsonb_array_length(${table.state}->'feedbacks') <= 100
  ) IS TRUE`,
      ),
      check(
        "feed_items_suggestion_content",
        sql`${table.state}->>'status' <> 'active' OR ${table.content} IS NOT NULL`,
      ),
      check(
        "feed_items_suggestion_expiry",
        sql`${table.expiresAt} IS NOT NULL`,
      ),
      index("feed_items_active_order")
        .on(
          table.orgId,
          table.userId,
          table.priority.desc(),
          table.createdAt,
          table.id,
        )
        .where(
          sql`${table.type} = 'suggestion' AND ${table.state}->>'status' = 'active'`,
        ),
      index("feed_items_pending_feedback")
        .on(table.orgId, table.userId, table.updatedAt, table.id)
        .where(
          sql`jsonb_path_exists(${table.state}->'feedbacks', '$[*] ? (@.learnedAt == null)')`,
        ),
      index("feed_items_expiry").on(
        table.expiresAt,
        table.orgId,
        table.userId,
        table.id,
      ),
      index("feed_items_receipts")
        .on(table.orgId, table.userId, table.updatedAt.desc(), table.id)
        .where(sql`${table.state}->>'status' <> 'active'`),
    ];
  },
);
