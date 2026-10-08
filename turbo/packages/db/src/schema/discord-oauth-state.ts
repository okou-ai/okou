import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const discordOauthFlow = pgEnum("discord_oauth_flow", [
  "install",
  "connect",
]);

/** Ephemeral one-use capability. Hashes never leave the authorization boundary. */
export const discordOauthStates = pgTable(
  "discord_oauth_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stateHash: text("state_hash").notNull().unique(),
    browserHash: text("browser_hash").notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    flow: discordOauthFlow("flow").notNull(),
    guildId: text("guild_id"),
    redirectUri: text("redirect_uri").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => {
    return [
      index("idx_discord_oauth_states_expiry").on(table.expiresAt),
      index("idx_discord_oauth_states_owner").on(table.userId, table.orgId),
    ];
  },
);
