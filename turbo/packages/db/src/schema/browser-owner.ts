import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
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

/**
 * Empty physical relation retained for outgoing GA chat deletion/cron SQL.
 * Current API state uses browser_chat_sessions. Remove in #42932 after
 * serving and rollback consumers of the old statements have drained.
 */
export const browserOwnerWindows = pgTable(
  "browser_owner_windows",
  {
    chatThreadId: uuid("chat_thread_id").primaryKey(),
    instanceId: uuid("instance_id").notNull(),
    state: varchar("state", { length: 16 })
      .$type<"active" | "closing">()
      .notNull(),
    primaryWindowId: bigint("primary_window_id", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // Live windows require an active parent. Closing windows retain cleanup
    // identities without preventing a final whole-provider stop.
    liveBrowserStatus: varchar("live_browser_status", { length: 16 })
      .$type<"active">()
      .generatedAlwaysAs(sql`CASE WHEN state = 'active' THEN 'active' END`),
  },
  (table) => {
    return [
      foreignKey({
        name: "browser_owner_windows_instance_fk",
        columns: [table.instanceId],
        foreignColumns: [browserOwnerProfiles.instanceId],
      }),
      foreignKey({
        name: "browser_owner_windows_active_instance_fk",
        columns: [table.instanceId, table.liveBrowserStatus],
        foreignColumns: [
          browserOwnerProfiles.instanceId,
          browserOwnerProfiles.status,
        ],
      }),
      unique("uq_browser_owner_windows_native_window").on(
        table.instanceId,
        table.primaryWindowId,
      ),
      index("idx_browser_owner_windows_expiry").on(
        table.state,
        table.expiresAt,
      ),
      check(
        "browser_owner_windows_state_check",
        sql`${table.state} IN ('active', 'closing')`,
      ),
      check(
        "browser_owner_windows_primary_check",
        sql`${table.primaryWindowId} BETWEEN 0 AND 9007199254740991`,
      ),
      check(
        "browser_owner_windows_deadline_check",
        sql`${table.expiresAt} > ${table.createdAt}`,
      ),
    ];
  },
);
