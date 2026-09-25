import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { discordOrgConnections } from "./discord-org-connection";

/** Explicit DM organization selection, limited to this Discord sender's verified connections. */
export const discordUserDmPreferences = pgTable(
  "discord_user_dm_preferences",
  {
    discordUserId: varchar("discord_user_id", { length: 255 }).primaryKey(),
    connectionId: uuid("connection_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "discord_user_dm_preferences_sender_owner_fk",
        columns: [table.connectionId, table.discordUserId, table.userId],
        foreignColumns: [
          discordOrgConnections.id,
          discordOrgConnections.discordUserId,
          discordOrgConnections.userId,
        ],
      }).onDelete("cascade"),
      index("idx_discord_user_dm_preferences_connection").on(
        table.connectionId,
      ),
      index("idx_discord_user_dm_preferences_user").on(table.userId),
    ];
  },
);
