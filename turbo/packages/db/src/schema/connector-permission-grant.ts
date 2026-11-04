import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { orgCustomConnectors } from "./org-custom-connector";

/** Member connector rules shared across all Chats, Agents and accounts. */
export const connectorPermissionGrants = pgTable(
  "connector_permission_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }),
    customConnectorId: uuid("custom_connector_id"),
    permission: varchar("permission", { length: 128 }).notNull(),
    action: varchar("action", { length: 8 })
      .$type<"allow" | "deny">()
      .notNull(),
    expiresAt: timestamp("expires_at"),
  },
  (table) => {
    return [
      uniqueIndex("uq_connector_permission_grants_builtin")
        .on(table.orgId, table.userId, table.connectorSlug, table.permission)
        .where(sql`${table.connectorSlug} IS NOT NULL`),
      uniqueIndex("uq_connector_permission_grants_custom")
        .on(
          table.orgId,
          table.userId,
          table.customConnectorId,
          table.permission,
        )
        .where(sql`${table.customConnectorId} IS NOT NULL`),
      index("idx_connector_permission_grants_custom").on(
        table.customConnectorId,
        table.orgId,
      ),
      foreignKey({
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
      check(
        "chk_connector_permission_grants_target",
        sql`num_nonnulls(${table.connectorSlug}, ${table.customConnectorId}) = 1`,
      ),
      check(
        "chk_connector_permission_grants_action",
        sql`${table.action} IN ('allow', 'deny')`,
      ),
      check(
        "chk_connector_permission_grants_expiry",
        sql`${table.action} = 'allow' OR ${table.expiresAt} IS NULL`,
      ),
    ];
  },
);
