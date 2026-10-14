import { sql, type SQLWrapper } from "drizzle-orm";

/** Reporting identity only; never changes ledger keys or settled amounts. */
export function modelUsageDisplayProviderSql(usage: {
  readonly provider: SQLWrapper;
}) {
  return sql`COALESCE(NULLIF(${usage.provider}, ''), 'unknown')`;
}
