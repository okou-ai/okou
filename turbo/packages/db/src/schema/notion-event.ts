import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { NotionWorkflowPendingEventContextJson } from "@okouai/db/jsonb-contracts/notion-event";

import { connectors } from "./connector";
import { workflowAutomations } from "./workflow";

export type { NotionWorkflowPendingEventContext } from "@okouai/db/jsonb-contracts/notion-event";

export const notionWebhookSecrets = pgTable(
  "notion_webhook_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subscriptionId: uuid("subscription_id"),
    encryptedVerificationToken: text("encrypted_verification_token").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_notion_webhook_secrets_active").on(table.active),
      uniqueIndex("idx_notion_webhook_secrets_active_single")
        .on(table.active)
        .where(sql`active = true`),
    ];
  },
);

export const notionWebhookEvents = pgTable(
  "notion_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    notionEventId: uuid("notion_event_id").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    pageId: uuid("page_id"),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_notion_webhook_events_event_id").on(table.notionEventId),
      index("idx_notion_webhook_events_page").on(table.pageId),
    ];
  },
);

export type NotionWorkflowPendingEventStatus =
  "pending" | "running" | "processed" | "skipped";
export type NotionWorkflowPendingEventFamily =
  "new_child_page" | "new_database_item" | "page_content_updated";
export type NotionWorkflowPendingEventScopeType = "page" | "data_source";

export const notionWorkflowPendingEvents = pgTable(
  "notion_workflow_pending_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    connectorId: uuid("connector_id").references(
      () => {
        return connectors.id;
      },
      { onDelete: "set null" },
    ),
    pageId: uuid("page_id").notNull(),
    scopeType: varchar("scope_type", { length: 32 })
      .$type<NotionWorkflowPendingEventScopeType>()
      .notNull(),
    scopeId: uuid("scope_id").notNull(),
    eventFamily: varchar("event_family", { length: 64 })
      .$type<NotionWorkflowPendingEventFamily>()
      .notNull()
      .default("new_child_page"),
    status: varchar("status", { length: 32 })
      .$type<NotionWorkflowPendingEventStatus>()
      .notNull()
      .default("pending"),
    firstNotionEventId: uuid("first_notion_event_id").notNull(),
    latestNotionEventId: uuid("latest_notion_event_id").notNull(),
    firstEventAt: timestamp("first_event_at").notNull(),
    latestEventAt: timestamp("latest_event_at").notNull(),
    latestEventContext: jsonb(
      "latest_event_context",
    ).$type<NotionWorkflowPendingEventContextJson>(),
    runAfter: timestamp("run_after").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    pageTitle: text("page_title"),
    pageUrl: text("page_url"),
    parentTitle: text("parent_title"),
    parentUrl: text("parent_url"),
    skipReason: text("skip_reason"),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_notion_pending_events_automation_page_family_active")
        .on(table.automationId, table.pageId, table.eventFamily)
        .where(sql`status IN ('pending', 'running')`),
      index("idx_notion_pending_events_due").on(table.status, table.runAfter),
      index("idx_notion_pending_events_connector").on(table.connectorId),
      index("idx_notion_pending_events_page_pending").on(
        table.pageId,
        table.status,
      ),
      index("idx_notion_pending_events_scope").on(
        table.scopeType,
        table.scopeId,
      ),
    ];
  },
);
