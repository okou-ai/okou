import {
  date,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { chatEvents } from "./chat-event";
import { workflowAutomations } from "./workflow";

/** One review-day occurrence; execution and completion remain owned by Runs. */
export const proactiveNightlyCycles = pgTable(
  "proactive_nightly_cycles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").$type<"learning" | "planning">().notNull(),
    reviewDate: date("review_date").notNull(),
    timezone: text("timezone").notNull(),
    scheduledAt: timestamp("scheduled_at").notNull(),
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    eventId: uuid("event_id").references(
      () => {
        return chatEvents.id;
      },
      {
        onDelete: "set null",
      },
    ),
    learningEventId: uuid("learning_event_id").references(
      () => {
        return chatEvents.id;
      },
      {
        onDelete: "set null",
      },
    ),
    learningMemoryVersion: varchar("learning_memory_version", { length: 64 }),
    skippedReason: text("skipped_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "proactive_nightly_cycles_kind_check",
        sql`${table.kind} IN ('learning', 'planning')`,
      ),
      uniqueIndex("proactive_nightly_cycles_owner_day_kind").on(
        table.orgId,
        table.userId,
        table.reviewDate,
        table.kind,
      ),
      uniqueIndex("proactive_nightly_cycles_event").on(table.eventId),
      index("proactive_nightly_cycles_automation").on(table.automationId),
    ];
  },
);
