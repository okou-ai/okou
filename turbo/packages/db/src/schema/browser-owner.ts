import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** One persistent profile and its single current physical Browser lifetime. */
export const browserOwnerProfiles = pgTable(
  "browser_owner_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    providerProfileId: uuid("provider_profile_id").notNull(),
    instanceId: uuid("instance_id").notNull(),
    providerSessionId: uuid("provider_session_id"),
    status: varchar("status", { length: 16 })
      .$type<"creating" | "active" | "stopping" | "stopped">()
      .notNull(),
    creationExpiresAt: timestamp("creation_expires_at").notNull(),
    timeoutAt: timestamp("timeout_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_browser_owner_profiles_owner").on(table.orgId, table.userId),
      unique("uq_browser_owner_profiles_provider").on(table.providerProfileId),
      unique("uq_browser_owner_profiles_instance").on(table.instanceId),
      unique("uq_browser_owner_profiles_session").on(table.providerSessionId),
      unique("uq_browser_owner_profiles_instance_state").on(
        table.instanceId,
        table.status,
      ),
      index("idx_browser_owner_profiles_reconcile").on(
        table.status,
        table.updatedAt,
      ),
      check(
        "browser_owner_profiles_status_check",
        sql`${table.status} IN ('creating', 'active', 'stopping', 'stopped')`,
      ),
      check(
        "browser_owner_profiles_provider_check",
        sql`(${table.status} <> 'active' OR ${table.providerSessionId} IS NOT NULL)
          AND (${table.status} <> 'creating' OR ${table.providerSessionId} IS NULL)`,
      ),
      check(
        "browser_owner_profiles_deadline_check",
        sql`${table.creationExpiresAt} > ${table.createdAt}
          AND ${table.timeoutAt} >= ${table.creationExpiresAt}`,
      ),
    ];
  },
);
