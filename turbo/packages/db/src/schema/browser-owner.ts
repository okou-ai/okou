import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
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
