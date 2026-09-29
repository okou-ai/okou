import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { connectors } from "./connector";
import { workflowAutomations } from "./workflow";

export const googleFormsWatchStates = pgTable(
  "google_forms_watch_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(
        () => {
          return connectors.id;
        },
        { onDelete: "cascade" },
      ),
    formId: text("form_id").notNull(),
    watchId: varchar("watch_id", { length: 255 }).notNull(),
    topicName: text("topic_name").notNull(),
    expireTime: timestamp("expire_time").notNull(),
    lastRenewedAt: timestamp("last_renewed_at").notNull(),
    needsRewatch: boolean("needs_rewatch").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_google_forms_watch_states_connector_form").on(
        table.connectorId,
        table.formId,
      ),
      uniqueIndex("idx_google_forms_watch_states_watch").on(table.watchId),
      index("idx_google_forms_watch_states_renewal").on(table.expireTime),
    ];
  },
);

export const googleFormsAutomationCursors = pgTable(
  "google_forms_automation_cursors",
  {
    automationId: uuid("automation_id")
      .primaryKey()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    watchStateId: uuid("watch_state_id")
      .notNull()
      .references(
        () => {
          return googleFormsWatchStates.id;
        },
        { onDelete: "cascade" },
      ),
    // Google emits microsecond-precision RFC3339 values. Keep them byte-for-byte
    // so the next responses.list filter never regresses the cursor.
    lastSeenSubmittedTime: text("last_seen_submitted_time").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_google_forms_automation_cursors_watch").on(table.watchStateId),
    ];
  },
);

export const googleFormsProcessedEvents = pgTable(
  "google_forms_processed_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    watchStateId: uuid("watch_state_id")
      .notNull()
      .references(
        () => {
          return googleFormsWatchStates.id;
        },
        { onDelete: "cascade" },
      ),
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    pubsubMessageId: varchar("pubsub_message_id", { length: 255 }).notNull(),
    responseId: varchar("response_id", { length: 255 }).notNull(),
    lastSubmittedTime: text("last_submitted_time").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_google_forms_processed_events_automation_response").on(
        table.watchStateId,
        table.automationId,
        table.responseId,
        table.lastSubmittedTime,
      ),
      index("idx_google_forms_processed_events_pubsub_message").on(
        table.pubsubMessageId,
      ),
    ];
  },
);
