import { bigint, boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";

export function iosPushRegistrationColumns() {
  return {
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
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  };
}
