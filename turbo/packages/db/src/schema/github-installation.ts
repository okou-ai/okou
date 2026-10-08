import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agent";
import type { GitHubInstallationRepoConfigs } from "@okouai/db/jsonb-contracts/github-installation";

/**
 * GitHub Installations table
 * Stores GitHub App installation data and default agent configuration.
 * One record per GitHub App installation (org or user account level).
 * User association is managed via the github_user_links table.
 */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: varchar("installation_id", { length: 255 }),
    appId: varchar("app_id", { length: 255 }),
    appSlug: varchar("app_slug", { length: 255 }),
    encryptedAccessToken: text("encrypted_access_token"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    orgId: text("org_id").notNull(),
    targetType: varchar("target_type", { length: 20 }),
    targetId: varchar("target_id", { length: 255 }),
    targetName: varchar("target_name", { length: 255 }),
    adminGithubUserId: varchar("admin_github_user_id", { length: 255 }),
    defaultAgentId: uuid("default_agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "cascade" },
    ),
    repoConfigs: jsonb("repo_configs").$type<GitHubInstallationRepoConfigs>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("github_installations_installation_id_unique")
        .on(table.installationId)
        .where(sql`installation_id IS NOT NULL`),
      index("idx_github_installations_org").on(table.orgId),
    ];
  },
);
