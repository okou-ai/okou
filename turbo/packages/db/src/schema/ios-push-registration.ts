import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Retain disabled bindings so an older in-flight register cannot undo sign-out.
export const iosPushRegistrations = pgTable(
  "ios_push_registrations",
  {
    installationId: uuid("installation_id").primaryKey(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    // A legacy writer advancing revision automatically retires this capability.
    notificationStateRevision: bigint("notification_state_revision", {
      mode: "number",
    }),
    // Opening this installation acknowledges badges without reading its chats.
    badgeClearedAt: timestamp("badge_cleared_at"),
    badgeClearedRevision: bigint("badge_cleared_revision", { mode: "number" }),
    badgeClearSequence: bigint("badge_clear_sequence", { mode: "number" }),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    deviceToken: text("device_token").notNull(),
    environment: text("environment", {
      enum: ["production", "sandbox"],
    }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // WidgetKit's token for this installation's widgets; null until a widget is installed.
    widgetPushToken: text("widget_push_token"),
    // The last widget push claimed for this binding; it spaces pushes to the device.
    widgetPushedAt: timestamp("widget_pushed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return [index("idx_ios_push_registrations_user").on(table.userId)];
  },
);
