import {
  pgTable,
  varchar,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Org-aware Microsoft Teams installations table.
 * One record per Teams tenant. `org_id` is nullable until an admin binds the
 * tenant installation to an org. Tenant:Org is 1:1, matching Slack workspace
 * install semantics without using connector credential storage.
 */
export const teamsOrgInstallations = pgTable(
  "teams_org_installations",
  {
    teamsTenantId: varchar("teams_tenant_id", { length: 255 })
      .notNull()
      .primaryKey(),
    teamsTenantName: varchar("teams_tenant_name", { length: 255 }),
    teamsTeamId: varchar("teams_team_id", { length: 255 }),
    teamsTeamName: varchar("teams_team_name", { length: 255 }),
    teamsAppId: varchar("teams_app_id", { length: 255 }),
    botId: varchar("bot_id", { length: 255 }),
    botName: varchar("bot_name", { length: 255 }),
    serviceUrl: text("service_url"),
    orgId: text("org_id"),
    installedByUserId: text("installed_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_teams_org_installations_org").on(table.orgId),
      uniqueIndex("idx_teams_org_installations_org_unique")
        .on(table.orgId)
        .where(sql`org_id IS NOT NULL`),
    ];
  },
);
