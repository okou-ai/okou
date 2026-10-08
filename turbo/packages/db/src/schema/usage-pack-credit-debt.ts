import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** Append-only member liabilities. Grants keep their original payment provenance. */
export const usagePackCreditDebtEntries = pgTable(
  "usage_pack_credit_debt_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    kind: varchar("kind", { length: 30 })
      .$type<"overdraft" | "repayment" | "legacy_overdraft">()
      .notNull(),
    // Audit identities intentionally survive deletion of a run or a source grant.
    creditGrantId: uuid("credit_grant_id"),
    usageEventId: uuid("usage_event_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_usage_pack_credit_debt_entries_member").on(
      table.orgId,
      table.userId,
    ),
    check(
      "chk_usage_pack_credit_debt_entries_kind",
      sql`${table.kind} IN ('overdraft', 'repayment', 'legacy_overdraft')`,
    ),
    check(
      "chk_usage_pack_credit_debt_entries_amount",
      sql`(${table.kind} = 'repayment' AND ${table.amount} < 0 AND ${table.creditGrantId} IS NOT NULL) OR (${table.kind} IN ('overdraft', 'legacy_overdraft') AND ${table.amount} > 0)`,
    ),
  ],
);
