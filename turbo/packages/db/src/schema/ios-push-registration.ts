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
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    deviceToken: text("device_token").notNull(),
    environment: text("environment", {
      enum: ["production", "sandbox"],
    }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return [index("idx_ios_push_registrations_user").on(table.userId)];
  },
);
