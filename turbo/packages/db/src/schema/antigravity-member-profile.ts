import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// A native Google login lives in the dedicated worker's system keyring.
// A fresh grant ID fences queued work and late confirmations after reconnect.
export const antigravityMemberProfiles = pgTable(
  "antigravity_member_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    machineId: text("machine_id").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => {
    return [unique().on(table.orgId, table.userId)];
  },
);
