import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { BrowserOwnerWindows } from "../jsonb-contracts/browser-owner";

export const browserOwnerProfiles = pgTable(
  "browser_owner_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    providerProfileId: uuid("provider_profile_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_browser_owner_profiles_owner").on(
        table.orgId,
        table.userId,
      ),
      uniqueIndex("uq_browser_owner_profiles_provider").on(
        table.providerProfileId,
      ),
    ];
  },
);

/** The immutable instance UUID is also its physical Browser generation. */
export const browserOwnerInstances = pgTable(
  "browser_owner_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerProfileId: uuid("owner_profile_id")
      .notNull()
      .references(() => {
        return browserOwnerProfiles.id;
      }),
    providerSessionId: uuid("provider_session_id"),
    status: varchar("status", { length: 16 })
      .$type<"creating" | "active" | "stopping" | "stopped">()
      .notNull(),
    windows: jsonb("windows")
      .$type<BrowserOwnerWindows>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    creationExpiresAt: timestamp("creation_expires_at").notNull(),
    timeoutAt: timestamp("timeout_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_browser_owner_instances_live_owner")
        .on(table.ownerProfileId)
        .where(sql`${table.status} IN ('creating', 'active', 'stopping')`),
      uniqueIndex("uq_browser_owner_instances_provider").on(
        table.providerSessionId,
      ),
      index("idx_browser_owner_instances_reconcile").on(
        table.status,
        table.updatedAt,
      ),
      check(
        "browser_owner_instances_status_check",
        sql`${table.status} IN ('creating', 'active', 'stopping', 'stopped')`,
      ),
      check(
        "browser_owner_instances_provider_check",
        sql`(${table.status} <> 'active' OR ${table.providerSessionId} IS NOT NULL)
        AND (${table.status} <> 'creating' OR ${table.providerSessionId} IS NULL)`,
      ),
      check(
        "browser_owner_instances_windows_check",
        sql`jsonb_typeof(${table.windows}) = 'object'`,
      ),
      check(
        "browser_owner_instances_deadline_check",
        sql`${table.creationExpiresAt} > ${table.createdAt}
        AND ${table.timeoutAt} >= ${table.creationExpiresAt}`,
      ),
    ];
  },
);

/** Attribution outlives chat deletion until exact provider cleanup completes. */
export const browserPageOwnership = pgTable(
  "browser_page_ownership",
  {
    instanceId: uuid("instance_id")
      .notNull()
      .references(
        () => {
          return browserOwnerInstances.id;
        },
        { onDelete: "cascade" },
      ),
    targetId: varchar("target_id", { length: 256 }).notNull(),
    windowGeneration: uuid("window_generation").notNull(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    nativeWindowId: integer("native_window_id").notNull(),
    openerTargetId: varchar("opener_target_id", { length: 256 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.instanceId, table.targetId] }),
      index("idx_browser_page_ownership_window").on(
        table.instanceId,
        table.windowGeneration,
      ),
      check(
        "browser_page_ownership_native_window_check",
        sql`${table.nativeWindowId} > 0`,
      ),
    ];
  },
);
