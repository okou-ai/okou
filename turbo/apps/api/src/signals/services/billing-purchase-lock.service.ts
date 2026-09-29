import { sql } from "drizzle-orm";

/** Outgoing Plan and usage-pack writers still require this shared boundary. */
export function billingPurchaseCompatibilityLockSql(orgId: string) {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing_purchase:${orgId}`}, 0))`;
}
