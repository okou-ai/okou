import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { workflowAutomations } from "./workflow";

/**
 * A due schedule anchor expired before it was claimed. These are not Run,
 * queue, or failure records; no chat event or agent execution is fabricated.
 * The exact anchor is retained to make competing ticks idempotent.
 */
export const workflowScheduleSkips = pgTable(
  "workflow_schedule_skips",
  {
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    scheduledAnchorAt: timestamp("scheduled_anchor_at").notNull(),
    skippedAt: timestamp("skipped_at").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "workflow_schedule_skips_pk",
        columns: [table.automationId, table.scheduledAnchorAt],
      }),
      index("idx_workflow_schedule_skips_at").on(table.skippedAt),
    ];
  },
);
