import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const remoteDevices = pgTable(
  "remote_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    accessAllowed: boolean("access_allowed").default(false).notNull(),
    accessExpiresAt: timestamp("access_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uq_remote_devices_id_owner").on(
      table.id,
      table.orgId,
      table.userId,
    ),
    index("idx_remote_devices_owner").on(table.orgId, table.userId),
    check(
      "chk_remote_devices_access_expiry",
      sql`${table.accessAllowed} OR ${table.accessExpiresAt} IS NULL`,
    ),
  ],
);
