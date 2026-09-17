import { sql } from "drizzle-orm";
import { check, date, pgTable, primaryKey, varchar } from "drizzle-orm/pg-core";

/** Shared daily reads for the single X billing account.
 * The consumer retains today and yesterday in UTC. No personal/financial FK:
 * deleting a run or account must not reset another customer's deduplication. */
export const xResourceReads = pgTable(
  "x_resource_reads",
  {
    utcDay: date("utc_day").notNull(),
    resourceType: varchar("resource_type", { length: 10 }).notNull(),
    resourceId: varchar("resource_id", { length: 32 }).notNull(),
  },
  (table) => {
    return [
      // The day prefix also supports bounded cleanup without another index.
      primaryKey({
        columns: [table.utcDay, table.resourceType, table.resourceId],
      }),
      check("x_resource_read_day_check", sql`isfinite(${table.utcDay})`),
      check(
        "x_resource_read_type_check",
        sql`${table.resourceType} IN ('post', 'user')`,
      ),
      check(
        "x_resource_read_id_check",
        sql`${table.resourceId} ~ '^[0-9]{1,32}$'`,
      ),
    ];
  },
);
