import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Short-lived codes that bind an inbound AgentPhone sender to one user and
 * organization. The plaintext code never leaves the issuing API response.
 */
export const agentphoneConnectionCodes = pgTable(
  "agentphone_connection_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    consumedPhoneHandle: varchar("consumed_phone_handle", { length: 254 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_agentphone_connection_codes_hash_expires").on(
        table.codeHash,
        table.expiresAt,
      ),
      index("idx_agentphone_connection_codes_expires").on(table.expiresAt),
      uniqueIndex("idx_agentphone_connection_codes_user_org").on(
        table.userId,
        table.orgId,
      ),
    ];
  },
);
