import { agentRuns } from "@okouai/db/runtime/agent-run";
import { sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

/** Sample the database clock, not a transaction's potentially stale timestamp. */
export function xResourceClockQuery() {
  const expression = sql`clock_timestamp() AT TIME ZONE 'UTC'`;
  return new QueryBuilder()
    .select({ at: expression.mapWith(agentRuns.createdAt).as("at") })
    .from(sql`(VALUES (1)) AS x_resource_clock`)
    .as("x_resource_clock_sample");
}
