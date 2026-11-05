import { pgTable, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teamsOrgConnectionColumns } from "../columns/teams-org-connection";

/**
 * Org-aware Microsoft Teams connections table.
 * Maps a Teams user to an internal user within a specific Teams tenant.
 */
export const teamsOrgConnections = pgTable(
  "teams_org_connections",
  teamsOrgConnectionColumns(),
  (table) => {
    return [
      uniqueIndex("idx_teams_org_connections_owner").on(
        table.orgId,
        table.userId,
      ),
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
