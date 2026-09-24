import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { discordOrgInstallations } from "./discord-org-installation";

/** A verified Discord sender binding; organization ownership comes from its guild. */
export const discordOrgConnections = pgTable(
  "discord_org_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    guildId: varchar("guild_id", { length: 255 })
      .notNull()
      .references(
        () => {
          return discordOrgInstallations.guildId;
        },
        { onDelete: "cascade" },
      ),
    discordUserId: varchar("discord_user_id", { length: 255 }).notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
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
