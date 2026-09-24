import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

/** One configured Discord guild per organization; application credentials live outside this table. */
export const discordOrgInstallations = pgTable(
  "discord_org_installations",
  {
    guildId: varchar("guild_id", { length: 255 }).primaryKey(),
    guildName: varchar("guild_name", { length: 255 }),
    orgId: text("org_id").notNull(),
    botUserId: varchar("bot_user_id", { length: 255 }).notNull(),
    installedByUserId: text("installed_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_discord_org_installations_org").on(table.orgId),
      index("idx_discord_org_installations_installer_guild").on(
        table.installedByUserId,
        table.guildId,
      ),
    ];
  },
);
