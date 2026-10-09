import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { discordOrgGrants } from "./discord-org-grant";

/** One configured Discord guild per organization; application credentials live outside this table. */
export const discordOrgInstallations = pgTable(
  "discord_org_installations",
  {
    guildId: varchar("guild_id", { length: 255 }).primaryKey(),
    guildName: varchar("guild_name", { length: 255 }),
    orgId: text("org_id").notNull(),
    botUserId: varchar("bot_user_id", { length: 255 }).notNull(),
    installedByUserId: text("installed_by_user_id"),
    orgGrantId: uuid("org_grant_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "fk_discord_installation_org_grant",
        columns: [
          table.orgGrantId,
          table.orgId,
          table.guildId,
          table.botUserId,
          table.createdAt,
        ],
        foreignColumns: [
          discordOrgGrants.id,
          discordOrgGrants.orgId,
          discordOrgGrants.verifiedGuildId,
          discordOrgGrants.verifiedBotUserId,
          discordOrgGrants.approvedAt,
        ],
      }).onDelete("cascade"),
      foreignKey({
        name: "fk_discord_installation_grant_installer",
        columns: [table.orgGrantId, table.installedByUserId],
        foreignColumns: [
          discordOrgGrants.id,
          discordOrgGrants.initiatedByUserId,
        ],
      })
        .onDelete("cascade")
        .onUpdate("cascade"),
      unique("uq_discord_org_installations_org").on(table.orgId),
      index("idx_discord_org_installations_installer_guild").on(
        table.installedByUserId,
        table.guildId,
      ),
    ];
  },
);
