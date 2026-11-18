import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgCustomConnectors } from "./org-custom-connector";
import { feishuOrgInstallationColumns } from "../columns/feishu-org-installation";

export const feishuOrgInstallations = pgTable(
  "feishu_org_installations",
  feishuOrgInstallationColumns(),
  (table) => {
    return [
      check(
        "chk_feishu_installation_type",
        sql`${table.installationType} IN ('custom', 'official') AND (${table.installationType} = 'custom' OR ${table.platform} = 'feishu')`,
      ),
      index("idx_feishu_org_installations_org").on(table.orgId),
      uniqueIndex("idx_feishu_org_installations_org_platform").on(
        table.orgId,
        table.platform,
        table.installationType,
      ),
      uniqueIndex("idx_feishu_org_installations_custom_connector").on(
        table.customConnectorId,
      ),
      uniqueIndex("idx_feishu_org_installations_app")
        .on(table.appId)
        .where(sql`${table.installationType} = 'custom'`),
      uniqueIndex("idx_feishu_org_installations_official_tenant")
        .on(table.appId, table.feishuTenantKey)
        .where(sql`${table.installationType} = 'official'`),
      index("idx_feishu_org_installations_tenant").on(table.feishuTenantKey),
      foreignKey({
        name: "fk_feishu_org_installations_custom_connector",
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("restrict"),
    ];
  },
);
