import { AsyncLocalStorage } from "node:async_hooks";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { ReadonlyDb } from "../external/db";
import { singleton } from "../../lib/singleton";
import { timestampWithoutTimeZone } from "../../lib/time";

const scopedClock = singleton(() => {
  return new AsyncLocalStorage<() => Date>();
});

const scopedAdmission = singleton(() => {
  return new AsyncLocalStorage<string | undefined>();
});

const scopedAdmissionAttempt = singleton(() => {
  return new AsyncLocalStorage<() => void>();
});

/** Preserve real contention within one test without blocking other tests. */
export async function withXResourceAdmissionScopeForTest<T>(
  scope: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedAdmission().run(scope, work);
}

export async function withXResourceAdmissionAttemptTrackingForTest<T>(
  onAttempt: () => void,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedAdmissionAttempt().run(onAttempt, work);
}

/** Infrastructure-only clock control, scoped to one test request/operation. */
export async function withXResourceClockForTest<T>(
  clock: () => Date,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedClock().run(clock, work);
}

// A held Clerk deletion is a durable receipt, not a completed account-erasure
// projection. Reject new usage from its old sandbox tokens without deleting
// the Run or following its Agent into another user's data.
export async function hasHeldClerkUserDeletion(
  db: Pick<ReadonlyDb, "select">,
  userId: string,
): Promise<boolean> {
  const [job] = await db
    .select({ id: backgroundJobs.id })
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.kind, "clerk-user-deletion"),
        eq(backgroundJobs.userId, userId),
      ),
    )
    .limit(1);
  return job !== undefined;
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
  scopedAdmissionAttempt.peek()?.getStore()?.();
  const scope = scopedAdmission.peek()?.getStore();
  const lockKey =
    scope === undefined
      ? "x_resource_reads_admission"
      : `x_resource_reads_admission:test:${scope}`;
  await tx.execute(
    mode === "shared"
      ? sql`SELECT pg_advisory_xact_lock_shared(hashtext('vm0'), hashtext(${lockKey}))`
      : sql`SELECT pg_advisory_xact_lock(hashtext('vm0'), hashtext(${lockKey}))`,
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
