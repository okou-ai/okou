import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const USAGE_PACK_CREDIT_GRANT_TYPES = ["purchased", "bonus"] as const;

export type UsagePackCreditGrantType =
  (typeof USAGE_PACK_CREDIT_GRANT_TYPES)[number];

/**
 * Member-owned usage pack credits. These grants are intentionally separate
 * from the shared organization balance and its expiring credit records.
 */
export const usagePackCreditGrants = pgTable(
  "usage_pack_credit_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    grantType: varchar("grant_type", { length: 20 })
      .$type<UsagePackCreditGrantType>()
      .notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    originalAmount: bigint("original_amount", { mode: "number" }).notNull(),
    remainingAmount: bigint("remaining_amount", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_usage_pack_credit_grants_idempotency").on(
        table.idempotencyKey,
      ),
      index("idx_usage_pack_credit_grants_member_spendable")
        .on(
          table.orgId,
          table.userId,
          table.grantType,
          table.expiresAt,
          table.id,
        )
        .where(sql`${table.remainingAmount} > 0`),
      check(
        "chk_usage_pack_credit_grants_type",
        sql`${table.grantType} IN ('purchased', 'bonus')`,
      ),
      check(
        "chk_usage_pack_credit_grants_original_amount",
        sql`${table.originalAmount} > 0`,
      ),
      check(
        "chk_usage_pack_credit_grants_remaining_amount",
        sql`${table.remainingAmount} <= ${table.originalAmount}`,
      ),
    ];
  },
);
