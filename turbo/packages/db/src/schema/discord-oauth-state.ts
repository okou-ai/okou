import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const discordOauthFlow = pgEnum("discord_oauth_flow", [
  "install",
  "connect",
]);
export const discordOauthPhase = pgEnum("discord_oauth_phase", [
  "pending",
  "processing",
  "verified",
  "approved",
  "failed",
]);
export const discordOauthFailure = pgEnum("discord_oauth_failure", [
  "cancelled",
  "unavailable",
  "forbidden",
  "provider_error",
  "invalid_authorization",
  "guild_unverified",
  "bot_missing",
]);

/** One-use capabilities and verified consent grants; never OAuth codes/tokens. */
export const discordOauthStates = pgTable(
  "discord_oauth_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stateHash: text("state_hash").notNull().unique(),
    completionTokenHash: text("completion_token_hash"),
    approvalTokenHash: text("approval_token_hash"),
    phase: discordOauthPhase("phase").default("pending").notNull(),
    failureCode: discordOauthFailure("failure_code"),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    flow: discordOauthFlow("flow").notNull(),
    guildId: text("guild_id"),
    redirectUri: text("redirect_uri").notNull(),
    verifiedGuildId: varchar("verified_guild_id", { length: 20 }),
    verifiedGuildName: varchar("verified_guild_name", { length: 255 }),
    verifiedDiscordUserId: varchar("verified_discord_user_id", { length: 20 }),
    verifiedBotUserId: varchar("verified_bot_user_id", { length: 20 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => {
    return [
      unique("uq_discord_oauth_grant_owner").on(
        table.id,
        table.userId,
        table.verifiedDiscordUserId,
        table.verifiedGuildId,
      ),
      index("idx_discord_oauth_states_expiry").on(table.expiresAt),
      index("idx_discord_oauth_states_owner").on(table.userId, table.orgId),
      check(
        "chk_discord_oauth_evidence_phase",
        sql`(
      ${table.phase} IN ('verified', 'approved') AND
      ${table.verifiedGuildId} IS NOT NULL AND ${table.verifiedGuildName} IS NOT NULL AND
      ${table.verifiedDiscordUserId} IS NOT NULL AND ${table.verifiedBotUserId} IS NOT NULL
    ) OR (
      ${table.phase} NOT IN ('verified', 'approved') AND
      ${table.verifiedGuildId} IS NULL AND ${table.verifiedGuildName} IS NULL AND
      ${table.verifiedDiscordUserId} IS NULL AND ${table.verifiedBotUserId} IS NULL
    )`,
      ),
      check(
        "chk_discord_oauth_approval_phase",
        sql`(${table.phase} = 'verified') = (${table.approvalTokenHash} IS NOT NULL)`,
      ),
      check(
        "chk_discord_oauth_failure_phase",
        sql`(${table.phase} = 'failed') = (${table.failureCode} IS NOT NULL)`,
      ),
    ];
  },
);
