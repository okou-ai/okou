import {
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { connectors } from "./connector";
import { feishuOrgInstallations } from "./feishu-org-installation";

/**
 * Org-aware Feishu/Lark connections table.
 * Maps a Feishu open identity to an internal user, independently of the bot
 * installation that first received it.
 */
export const feishuOrgConnections = pgTable(
  "feishu_org_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Installation ownership is recorded for routing, not for identity: an
    // independent account keeps its scope after the bot is uninstalled.
    installationId: uuid("installation_id"),
    orgId: text("org_id"),
    // Keep draining installation-owned writers constrained while independently
    // owned identities can exist before installation and after uninstall.
    // Remove this discriminator after the writer, row and rollback gates land.
    legacyInstallationId: uuid("legacy_installation_id").generatedAlwaysAs(
      sql`CASE WHEN org_id IS NULL THEN installation_id ELSE NULL END`,
    ),
    feishuOpenId: varchar("feishu_open_id", { length: 255 }).notNull(),
    userId: text("user_id").notNull(),
    connectorId: uuid("connector_id").references(
      () => {
        return connectors.id;
      },
      { onDelete: "set null" },
    ),
    feishuUserName: varchar("feishu_user_name", { length: 255 }),
    dmWelcomeSent: boolean("dm_welcome_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "feishu_org_connections_installation_id_feishu_org_installations_id_fk",
        columns: [table.legacyInstallationId],
        foreignColumns: [feishuOrgInstallations.id],
      }).onDelete("cascade"),
      uniqueIndex("idx_feishu_org_connections_owner")
        .on(table.orgId, table.userId)
        .where(sql`${table.orgId} IS NOT NULL`),
      uniqueIndex("idx_feishu_org_connections_user_installation").on(
        table.feishuOpenId,
        table.installationId,
      ),
      index("idx_feishu_org_connections_user_id_installation").on(
        table.userId,
        table.installationId,
      ),
      index("idx_feishu_org_connections_installation").on(table.installationId),
      uniqueIndex("idx_feishu_org_connections_connector")
        .on(table.connectorId)
        .where(sql`${table.connectorId} IS NOT NULL`),
    ];
  },
);
