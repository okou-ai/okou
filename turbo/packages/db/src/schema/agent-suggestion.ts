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
  AgentSuggestionContent,
  AgentSuggestionFeedbacks,
} from "../jsonb-contracts/agent-suggestion";

/** One owner-scoped card per row; feedback writes never rebuild another card. */
export const agentSuggestions = pgTable(
  "agent_suggestion_items",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    id: uuid("id").notNull(),
    status: text("status").$type<"active" | "consumed" | "removed">().notNull(),
    priority: integer("priority").notNull().default(0),
    content: jsonb("content").$type<AgentSuggestionContent>(),
    selectedOptionId: text("selected_option_id"),
    feedbacks: jsonb("feedbacks")
      .$type<AgentSuggestionFeedbacks>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId, table.id] }),
      check(
        "agent_suggestion_items_status",
        sql`${table.status} IN ('active', 'consumed', 'removed')`,
      ),
      check(
        "agent_suggestion_items_active_content",
        sql`${table.status} <> 'active' OR ${table.content} IS NOT NULL`,
      ),
      check(
        "agent_suggestion_items_feedback_bound",
        sql`jsonb_typeof(${table.feedbacks}) = 'array' AND jsonb_array_length(${table.feedbacks}) <= 100`,
      ),
      index("agent_suggestion_items_active_order")
        .on(
          table.orgId,
          table.userId,
          table.priority.desc(),
          table.createdAt,
          table.id,
        )
        .where(sql`${table.status} = 'active'`),
      index("agent_suggestion_items_pending_feedback")
        .on(table.orgId, table.userId, table.updatedAt, table.id)
        .where(
          sql`jsonb_path_exists(${table.feedbacks}, '$[*] ? (@.learnedAt == null)')`,
        ),
      index("agent_suggestion_items_expiry").on(
        table.expiresAt,
        table.orgId,
        table.userId,
        table.id,
      ),
      index("agent_suggestion_items_receipts")
        .on(table.orgId, table.userId, table.updatedAt.desc(), table.id)
        .where(sql`${table.status} <> 'active'`),
    ];
  },
);
