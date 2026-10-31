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
import { browserOwnerProfiles } from "./browser-owner";

/** One logical chat Browser; recovery survives retirement of its live binding. */
export const browserChatSessions = pgTable(
  "browser_chat_sessions",
  {
    chatThreadId: uuid("chat_thread_id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 64 }).notNull().default("browser"),
    instanceId: uuid("instance_id"),
    state: varchar("state", { length: 16 }).$type<"active" | "closing">(),
    primaryWindowId: bigint("primary_window_id", { mode: "number" }),
    expiresAt: timestamp("expires_at"),
    encryptedTabUrls: text("encrypted_tab_urls"),
    tabUrlsCapturedAt: timestamp("tab_urls_captured_at"),
    screenshotObjectKey: text("screenshot_object_key"),
    screenshotUrl: text("screenshot_url"),
    screenshotCapturedAt: timestamp("screenshot_captured_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    liveBrowserStatus: varchar("live_browser_status", { length: 16 })
      .$type<"active">()
      .generatedAlwaysAs(sql`CASE WHEN state = 'active' THEN 'active' END`),
  },
  (table) => {
    return [
      foreignKey({
        name: "browser_chat_sessions_owner_fk",
        columns: [table.orgId, table.userId],
        foreignColumns: [
          browserOwnerProfiles.orgId,
          browserOwnerProfiles.userId,
        ],
      }),
      foreignKey({
        name: "browser_chat_sessions_instance_fk",
        columns: [table.instanceId],
        foreignColumns: [browserOwnerProfiles.instanceId],
      }),
      foreignKey({
        name: "browser_chat_sessions_active_instance_fk",
        columns: [table.instanceId, table.liveBrowserStatus],
        foreignColumns: [
          browserOwnerProfiles.instanceId,
          browserOwnerProfiles.status,
        ],
      }),
      unique("uq_browser_chat_sessions_native_window").on(
        table.instanceId,
        table.primaryWindowId,
      ),
      index("idx_browser_chat_sessions_owner").on(table.orgId, table.userId),
      index("idx_browser_chat_sessions_reconcile").on(table.updatedAt),
      check(
        "browser_chat_sessions_binding_check",
        sql`
    (${table.instanceId} IS NULL AND ${table.state} IS NULL AND ${table.primaryWindowId} IS NULL AND ${table.expiresAt} IS NULL)
    OR (${table.instanceId} IS NOT NULL AND ${table.state} IS NOT NULL AND ${table.state} IN ('active', 'closing')
      AND ${table.primaryWindowId} IS NOT NULL AND ${table.expiresAt} IS NOT NULL)`,
      ),
      check(
        "browser_chat_sessions_primary_check",
        sql`${table.primaryWindowId} BETWEEN 0 AND 9007199254740991`,
      ),
      check(
        "browser_chat_sessions_deadline_check",
        sql`${table.expiresAt} > ${table.createdAt}`,
      ),
      check(
        "browser_chat_sessions_urls_check",
        sql`(${table.encryptedTabUrls} IS NULL) = (${table.tabUrlsCapturedAt} IS NULL)`,
      ),
      check(
        "browser_chat_sessions_screenshot_check",
        sql`
    (${table.screenshotObjectKey} IS NULL AND ${table.screenshotUrl} IS NULL AND ${table.screenshotCapturedAt} IS NULL)
    OR (${table.screenshotObjectKey} IS NOT NULL AND ${table.screenshotUrl} IS NOT NULL AND ${table.screenshotCapturedAt} IS NOT NULL)`,
      ),
    ];
  },
);
