import { AsyncLocalStorage } from "node:async_hooks";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
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

export async function setXResourceTransactionTimeouts(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT
    set_config('lock_timeout', '2s', true),
    set_config('statement_timeout', '5s', true),
    set_config('transaction_timeout', '15s', true)`);
}

/** Ingestion shares admission; cleanup excludes all admitted transactions. */
export async function lockXResourceAdmission(
  tx: Tx,
  mode: "shared" | "exclusive",
): Promise<void> {
  await tx.execute(
    mode === "shared"
      ? sql`SELECT pg_advisory_xact_lock_shared(hashtext('vm0'), hashtext('x_resource_reads_admission'))`
      : sql`SELECT pg_advisory_xact_lock(hashtext('vm0'), hashtext('x_resource_reads_admission'))`,
  );
}

/** Sample after waits. transaction_timestamp()/CURRENT_DATE can be stale. */
export async function readXResourceClock(tx: Tx): Promise<Date> {
  const testClock = scopedClock.peek()?.getStore();
  const expression = testClock
    ? sql`${timestampWithoutTimeZone(testClock())}::timestamp`
    : sql`clock_timestamp() AT TIME ZONE 'UTC'`;
  const [clock] = await tx
    .select({ at: expression.mapWith(agentRuns.createdAt) })
    .from(sql`(VALUES (1)) AS x_resource_clock`);
  if (!clock) {
    throw new Error("X resource database clock returned no row");
  }
  return clock.at;
}
