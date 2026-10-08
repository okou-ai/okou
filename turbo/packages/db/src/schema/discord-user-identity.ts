import { pgTable, text, unique, varchar } from "drizzle-orm/pg-core";

/** One verified Discord account owner, shared by that owner's guild bindings. */
export const discordUserIdentities = pgTable(
  "discord_user_identities",
  {
    discordUserId: varchar("discord_user_id", { length: 255 }).primaryKey(),
    userId: text("user_id").notNull(),
  },
  (table) => {
    return [
      unique("uq_discord_user_identity_owner").on(
        table.discordUserId,
        table.userId,
      ),
    ];
  },
);
