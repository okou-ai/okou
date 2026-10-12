import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** Organization-owned installation consent; no personal sender or capability is retained. */
export const discordOrgGrants = pgTable(
  "discord_org_grants",
  {
    id: uuid("id").primaryKey(),
    orgId: text("org_id").notNull(),
    initiatedByUserId: text("initiated_by_user_id"),
    requestedGuildId: text("requested_guild_id"),
    verifiedGuildId: varchar("verified_guild_id", { length: 255 }),
    verifiedBotUserId: varchar("verified_bot_user_id", { length: 255 }),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => {
    return [
      unique("uq_discord_org_grant_installation").on(
        table.id,
        table.orgId,
        table.verifiedGuildId,
        table.verifiedBotUserId,
        table.approvedAt,
      ),
      unique("uq_discord_org_grant_installer").on(
        table.id,
        table.initiatedByUserId,
      ),
      index("idx_discord_org_grants_org").on(table.orgId),
      index("idx_discord_org_grants_initiator").on(table.initiatedByUserId),
      index("idx_discord_org_grants_expiry").on(table.expiresAt),
      check(
        "chk_discord_org_grant_evidence",
        sql`(${table.verifiedGuildId} IS NULL) = (${table.verifiedBotUserId} IS NULL)`,
      ),
      check(
        "chk_discord_org_grant_approval",
        sql`${table.approvedAt} IS NULL OR (${table.verifiedGuildId} IS NOT NULL AND ${table.verifiedBotUserId} IS NOT NULL)`,
      ),
    ];
  },
);
