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
 * Org-aware Slack installations table.
 * One record per Slack workspace. `org_id` is nullable until an admin
 * binds the workspace to an org via `/connect`.
 * Workspace:Org is 1:1 — enforced by a partial unique index on `org_id`.
 */
export const slackOrgInstallations = pgTable(
  "slack_org_installations",
  {
    slackWorkspaceId: varchar("slack_workspace_id", { length: 255 })
      .notNull()
      .primaryKey(),
    slackWorkspaceName: varchar("slack_workspace_name", { length: 255 }),
    orgId: text("org_id"),
    encryptedBotToken: text("encrypted_bot_token").notNull(),
    botUserId: varchar("bot_user_id", { length: 255 }).notNull(),
    installedByUserId: text("installed_by_user_id"),
    botScopes: text("bot_scopes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_slack_org_installations_org").on(table.orgId),
      uniqueIndex("idx_slack_org_installations_org_unique")
        .on(table.orgId)
        .where(sql`org_id IS NOT NULL`),
    ];
  },
);
