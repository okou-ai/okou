import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { slackOrgInstallations } from "./slack-org-installation";

/**
 * Org-aware Slack connections table.
 * Maps a Slack user to an internal user within a specific workspace.
 * Each Slack user can only be connected once per workspace.
 * Account-owned connections retain their execution organization independently
 * of installation. A null orgId identifies a legacy installation-owned link.
 */
export const slackOrgConnections = pgTable(
  "slack_org_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slackUserId: varchar("slack_user_id", { length: 255 }).notNull(),
    slackWorkspaceId: varchar("slack_workspace_id", { length: 255 }).notNull(),
    slackWorkspaceName: text("slack_workspace_name"),
    orgId: text("org_id"),
    // Outgoing API writers still create installation-owned links. Preserve
    // their FK while account-owned links can exist without an installation.
    legacyInstallationWorkspaceId: varchar("legacy_installation_workspace_id", {
      length: 255,
    })
      .generatedAlwaysAs(
        sql`CASE WHEN org_id IS NULL THEN slack_workspace_id ELSE NULL END`,
      )
      .references(() => {
        return slackOrgInstallations.slackWorkspaceId;
      }),
    userId: text("user_id").notNull(),
    dmWelcomeSent: boolean("dm_welcome_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_slack_org_connections_user_workspace").on(
        table.slackUserId,
        table.slackWorkspaceId,
      ),
      index("idx_slack_org_connections_workspace").on(table.slackWorkspaceId),
      index("idx_slack_org_connections_user_id_workspace").on(
        table.userId,
        table.slackWorkspaceId,
      ),
    ];
  },
);
