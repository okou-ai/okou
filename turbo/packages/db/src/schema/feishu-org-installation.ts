import {
  foreignKey,
  index,
  pgTable,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agent";
import { orgCustomConnectors } from "./org-custom-connector";
import { feishuOrgInstallationColumns } from "../columns/feishu-org-installation";

export const feishuOrgInstallations = pgTable(
  "feishu_org_installations",
  {
    ...feishuOrgInstallationColumns(),
    // Retain the physical column until a later deployment can contract it.
    defaultAgentId: uuid("default_agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "cascade" },
    ),
  },
  (table) => {
    return [
      index("idx_feishu_org_installations_org").on(table.orgId),
      uniqueIndex("idx_feishu_org_installations_org_platform").on(
        table.orgId,
        table.platform,
      ),
      uniqueIndex("idx_feishu_org_installations_custom_connector").on(
        table.customConnectorId,
      ),
      uniqueIndex("idx_feishu_org_installations_app").on(table.appId),
      index("idx_feishu_org_installations_tenant").on(table.feishuTenantKey),
      foreignKey({
        name: "fk_feishu_org_installations_custom_connector",
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("restrict"),
    ];
  },
);
