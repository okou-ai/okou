import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { morningBriefNativeSchedules } from "./morning-brief-native-schedule";
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

/** Native Morning Brief has no required legacy automation identity. */
export const morningBriefNativeScheduleSkips = pgTable(
  "morning_brief_native_schedule_skips",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    ownerEpoch: integer("owner_epoch").notNull(),
    scheduledAnchorAt: timestamp("scheduled_anchor_at").notNull(),
    skippedAt: timestamp("skipped_at").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "morning_brief_native_schedule_skips_pk",
        columns: [
          table.orgId,
          table.userId,
          table.ownerEpoch,
          table.scheduledAnchorAt,
        ],
      }),
      foreignKey({
        name: "fk_morning_brief_native_schedule_skips_owner",
        columns: [table.orgId, table.userId],
        foreignColumns: [
          morningBriefNativeSchedules.orgId,
          morningBriefNativeSchedules.userId,
        ],
      }).onDelete("cascade"),
      index("idx_morning_brief_native_schedule_skips_at").on(table.skippedAt),
    ];
  },
);
