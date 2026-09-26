import {
  boolean,
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

export const feishuOrgConnections = pgTable(
  "feishu_org_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(
        () => {
          return feishuOrgInstallations.id;
        },
        { onDelete: "cascade" },
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
