import type { JsonObject } from "@okouai/db/jsonb-contracts/shared";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatAutomationContext = pgTable(
  "chat_automation_context",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    automationId: uuid("automation_id").notNull(),
    triggerBrief: text("trigger_brief"),
    workflowName: text("workflow_name"),
    eventType: text("event_type"),
    /**
     * Exact account that delivered the event. This is run-scoped launch
     * material, not a persisted thread account preference. It intentionally
     * has no foreign key so queued event provenance survives account deletion;
     * launch falls back to the thread preference or current default when the
     * recorded source is no longer usable.
     */
    connectorSourceId: uuid("connector_source_id"),
    /**
     * Server-private workflow automation launch material retained permanently.
     * Raw third-party content is intentionally retained as its only database
     * copy. Server-only object-key ordering metadata preserves byte-identical
     * prompt rendering and is stripped at claim. Read paths must project only
     * explicitly required columns, and no caller may project the entire row.
     */
    eventPayload: jsonb("event_payload").$type<JsonObject>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("chat_automation_context_thread_idx").on(table.chatThreadId),
      index("chat_automation_context_automation_id_idx").on(table.automationId),
    ];
  },
);
