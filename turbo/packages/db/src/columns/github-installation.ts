import { uuid, varchar, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import type { GitHubInstallationRepoConfigs } from "@okouai/db/jsonb-contracts/github-installation";

export function githubInstallationColumns() {
  return {
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
    repoConfigs: jsonb("repo_configs").$type<GitHubInstallationRepoConfigs>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
