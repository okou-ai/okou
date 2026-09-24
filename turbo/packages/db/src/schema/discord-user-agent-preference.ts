import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { agents } from "./agent";
import { discordOrgConnections } from "./discord-org-connection";

/** Agent selection for a verified member; a null selection uses the organization default. */
export const discordUserAgentPreferences = pgTable(
  "discord_user_agent_preferences",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    selectedAgentId: uuid("selected_agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.userId, table.orgId] }),
      foreignKey({
        name: "discord_user_agent_preferences_connection_owner_fk",
        columns: [table.connectionId, table.userId],
        foreignColumns: [
          discordOrgConnections.id,
          discordOrgConnections.userId,
        ],
      }).onDelete("cascade"),
      index("idx_discord_user_agent_preferences_connection").on(
        table.connectionId,
      ),
    ];
  },
);
