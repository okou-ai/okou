import {
  pgTable,
  varchar,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teamsOrgConnectionColumns } from "../columns/teams-org-connection";
import { teamsOrgInstallations } from "./teams-org-installation";

/**
 * Org-aware Microsoft Teams connections table.
 * Maps a Teams user to an internal user within a specific Teams tenant.
 */
export const teamsOrgConnections = pgTable(
  "teams_org_connections",
  {
    ...teamsOrgConnectionColumns(),
    // Keep draining installation-owned writers constrained while independently
    // owned OAuth identities can exist before installation and after uninstall.
    // Remove this discriminator after the DB/API and row gates in #43729.
    legacyInstallationTenantId: varchar("legacy_installation_tenant_id", {
      length: 255,
    }).generatedAlwaysAs(
      sql`CASE WHEN org_id IS NULL THEN teams_tenant_id ELSE NULL END`,
    ),
  },
  (table) => {
    return [
      foreignKey({
        name: "teams_org_connections_teams_tenant_id_teams_org_installations_teams_tenant_id_fk",
        columns: [table.legacyInstallationTenantId],
        foreignColumns: [teamsOrgInstallations.teamsTenantId],
      }),
      uniqueIndex("idx_teams_org_connections_owner")
        .on(table.orgId, table.userId)
        .where(sql`${table.orgId} IS NOT NULL`),
      uniqueIndex("idx_teams_org_connections_user_tenant")
        .on(table.teamsUserId, table.teamsTenantId)
        .where(sql`teams_user_id IS NOT NULL`),
      uniqueIndex("idx_teams_org_connections_aad_tenant")
        .on(table.teamsAadObjectId, table.teamsTenantId)
        .where(sql`teams_aad_object_id IS NOT NULL`),
      index("idx_teams_org_connections_user_id_tenant").on(
        table.userId,
        table.teamsTenantId,
      ),
      index("idx_teams_org_connections_tenant").on(table.teamsTenantId),
    ];
  },
);
