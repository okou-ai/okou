import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Retained audit of legacy member overdrafts transferred to the organization wallet. */
export const usagePackOverdraftTransfers = pgTable(
  "usage_pack_overdraft_transfers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // No cascading FK: removing a grant must not erase the transfer receipt.
    creditGrantId: uuid("credit_grant_id").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_usage_pack_overdraft_transfers_org").on(
        table.orgId,
        table.createdAt,
      ),
      check(
        "chk_usage_pack_overdraft_transfers_amount",
        sql`${table.amount} > 0`,
      ),
    ];
  },
);
