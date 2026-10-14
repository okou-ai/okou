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

import { discordOauthStates } from "./discord-oauth-state";

/** A verified account connection. Servers are conversation context, not owners. */
export const discordOrgConnections = pgTable(
  "discord_org_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Historical consent context; account ownership is always the organization.
    guildId: varchar("guild_id", { length: 255 }),
    orgId: text("org_id").notNull(),
    discordUserId: varchar("discord_user_id", { length: 255 }).notNull(),
    userId: text("user_id").notNull(),
    // Every binding references its genuine completed personal authorization.
    oauthGrantId: uuid("oauth_grant_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "fk_discord_connection_account_grant",
        columns: [
          table.oauthGrantId,
          table.userId,
          table.discordUserId,
          table.orgId,
        ],
        foreignColumns: [
          discordOauthStates.id,
          discordOauthStates.userId,
          discordOauthStates.verifiedDiscordUserId,
          discordOauthStates.orgId,
        ],
      }).onDelete("cascade"),
      unique("uq_discord_connections_org_sender").on(
        table.orgId,
        table.discordUserId,
      ),
      unique("uq_discord_connections_org_user").on(table.orgId, table.userId),
      foreignKey({
        name: "fk_discord_connection_oauth_grant",
        columns: [
          table.oauthGrantId,
          table.userId,
          table.discordUserId,
          table.guildId,
        ],
        foreignColumns: [
          discordOauthStates.id,
          discordOauthStates.userId,
          discordOauthStates.verifiedDiscordUserId,
          discordOauthStates.verifiedGuildId,
        ],
      }).onDelete("cascade"),
      unique("uq_discord_org_connections_guild_sender").on(
        table.guildId,
        table.discordUserId,
      ),
      unique("uq_discord_org_connections_guild_user").on(
        table.guildId,
        table.userId,
      ),
      unique("uq_discord_org_connections_owner").on(table.id, table.userId),
      unique("uq_discord_org_connections_sender_owner").on(
        table.id,
        table.discordUserId,
        table.userId,
      ),
      index("idx_discord_org_connections_user").on(table.userId),
      index("idx_discord_org_connections_sender").on(table.discordUserId),
    ];
  },
);
