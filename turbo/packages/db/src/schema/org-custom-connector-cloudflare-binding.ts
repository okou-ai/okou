import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { cloudflareAccessConfigs } from "./cloudflare-access-config";
import { orgCustomConnectors } from "./org-custom-connector";

/** Organization network authority, separate from members' application credentials. */
export const orgCustomConnectorCloudflareBindings = pgTable(
  "org_custom_connector_cloudflare_bindings",
  {
    connectorId: uuid("connector_id").primaryKey(),
    orgId: text("org_id").notNull(),
    configId: uuid("config_id").notNull(),
    configScope: text("config_scope").notNull().default("organization"),
  },
  (table) => {
    return [
      foreignKey({
        name: "fk_custom_connector_cloudflare_connector",
        columns: [table.connectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
      foreignKey({
        name: "fk_custom_connector_cloudflare_config",
        columns: [table.configId, table.orgId, table.configScope],
        foreignColumns: [
          cloudflareAccessConfigs.id,
          cloudflareAccessConfigs.orgId,
          cloudflareAccessConfigs.scope,
        ],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
      index("idx_custom_connector_cloudflare_config").on(
        table.configId,
        table.orgId,
      ),
      check(
        "chk_custom_connector_cloudflare_scope",
        sql`${table.configScope} = 'organization'`,
      ),
    ];
  },
);
