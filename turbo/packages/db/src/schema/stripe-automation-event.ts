import type { StripeAutomationEventSnapshot } from "@okouai/db/jsonb-contracts/stripe-automation-event";
import { sql } from "drizzle-orm";
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

import { workflowAutomations } from "./workflow";

export type StripeWorkflowDeliveryStatus =
  "pending" | "delivered" | "skipped" | "failed";

export const stripeWorkflowDeliveries = pgTable(
  "stripe_workflow_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Deliberately not a foreign key: a pending delivery must survive automation
    // deletion long enough for the worker to record the terminal skipped state.
    automationId: uuid("automation_id").notNull(),
    connectorId: uuid("connector_id").notNull(),
    stripeAccountId: varchar("stripe_account_id", { length: 255 }).notNull(),
    livemode: boolean("livemode").notNull(),
    stripeEventId: varchar("stripe_event_id", { length: 255 }).notNull(),
    stripeEventCreatedAt: timestamp("stripe_event_created_at").notNull(),
    billingReason: text("billing_reason"),
    snapshot: jsonb("snapshot")
      .$type<StripeAutomationEventSnapshot>()
      .notNull(),
    status: varchar("status", { length: 32 })
      .$type<StripeWorkflowDeliveryStatus>()
      .default("pending")
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    revision: integer("revision").default(0).notNull(),
    claimExpiresAt: timestamp("claim_expires_at"),
    nextAttemptAt: timestamp("next_attempt_at").notNull(),
    lastError: text("last_error"),
    skipReason: text("skip_reason"),
    deliveredAt: timestamp("delivered_at"),
    skippedAt: timestamp("skipped_at"),
    failedAt: timestamp("failed_at"),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_stripe_workflow_deliveries_dedupe").on(
        table.automationId,
        table.stripeAccountId,
        table.livemode,
        table.stripeEventId,
      ),
      index("idx_stripe_workflow_deliveries_due")
        .on(table.nextAttemptAt, table.claimExpiresAt)
        .where(sql`${table.status} = 'pending'`),
      index("idx_stripe_workflow_deliveries_automation").on(table.automationId),
    ];
  },
);

export const stripeWorkflowAutomationHealth = pgTable(
  "stripe_workflow_automation_health",
  {
    automationId: uuid("automation_id")
      .primaryKey()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    lastMatchingEventReceivedAt: timestamp("last_matching_event_received_at"),
    latestDeliveryId: uuid("latest_delivery_id"),
    latestDeliveryStatus: varchar("latest_delivery_status", {
      length: 32,
    }).$type<StripeWorkflowDeliveryStatus>(),
    latestDeliveryStatusAt: timestamp("latest_delivery_status_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);
