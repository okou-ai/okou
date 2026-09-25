import { AsyncLocalStorage } from "node:async_hooks";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import { singleton } from "../../lib/singleton";
import { timestampWithoutTimeZone } from "../../lib/time";

const scopedClock = singleton(() => {
  return new AsyncLocalStorage<() => Date>();
});

/** Infrastructure-only clock control, scoped to one test request/operation. */
export async function withXResourceClockForTest<T>(
  clock: () => Date,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedClock().run(clock, work);
}

/** Sample the database clock, not a transaction's potentially stale timestamp. */
export async function readXResourceClock(db: Db | Tx): Promise<Date> {
  const testClock = scopedClock.peek()?.getStore();
  const expression = testClock
    ? sql`${timestampWithoutTimeZone(testClock())}::timestamp`
    : sql`clock_timestamp() AT TIME ZONE 'UTC'`;
  const [clock] = await db
    .select({ at: expression.mapWith(agentRuns.createdAt) })
    .from(sql`(VALUES (1)) AS x_resource_clock`);
  if (!clock) {
    throw new Error("X resource database clock returned no row");
  }
  return clock.at;
}
