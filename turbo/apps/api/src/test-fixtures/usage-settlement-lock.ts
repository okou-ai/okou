import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

const pidSchema = z.object({ pid: z.int() });
const countSchema = z.object({ count: z.int() });

async function settlementWaiterCount(holderPid: number): Promise<number> {
  const [result] = await executeRawRows(
    db(),
    sql`SELECT ${count()}::int AS count
      FROM pg_stat_activity AS settlement
      WHERE ${holderPid} = ANY(pg_blocking_pids(settlement.pid))`,
    countSchema,
  );
  if (!result) {
    throw new Error("Missing settlement waiter count");
  }
  return result.count;
}

async function cleanupWaiterCount(holderPid: number): Promise<number> {
  const [result] = await executeRawRows(
    db(),
    sql`SELECT ${count()}::int AS count
      FROM pg_stat_activity AS cleanup
      WHERE cleanup.wait_event_type = 'Lock'
        AND EXISTS (
          SELECT 1 FROM pg_locks AS waiting_lock
          WHERE waiting_lock.pid = cleanup.pid AND NOT waiting_lock.granted
            AND clock_timestamp() - waiting_lock.waitstart > interval '100 milliseconds'
        )
        AND EXISTS (
          SELECT 1 FROM pg_stat_activity AS settlement
          WHERE ${holderPid} = ANY(pg_blocking_pids(settlement.pid))
            AND settlement.pid = ANY(pg_blocking_pids(cleanup.pid))
        )`,
    countSchema,
  );
  if (!result) {
    throw new Error("Missing cleanup waiter count");
  }
  return result.count;
}

/** Infrastructure exception: HTTP cannot pause a credit deduction after the
 * real settlement has updated its usage rows. Lock only the caller's owned
 * organization metadata, without changing its balance or settlement state.
 */
export async function holdUsageSettlementCreditWriteForTest(
  orgId: string,
  signal: AbortSignal,
) {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    const [owned] = await tx
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .for("update");
    if (!owned) {
      throw new Error("Expected the test-owned organization metadata");
    }
    const [holder] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      pidSchema,
    );
    if (!holder) {
      throw new Error("Missing settlement credit-write lock holder");
    }
    started.resolve(holder.pid);
    await released.promise;
    signal.throwIfAborted();
  });
  const holderPid = await Promise.race([started.promise, done]);
  if (holderPid === undefined) {
    throw new Error("Credit-write fixture finished before taking its lock");
  }
  return {
    done,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    settlementWaiterCount: async () => {
      signal.throwIfAborted();
      return await settlementWaiterCount(holderPid);
    },
    cleanupWaiterCount: async () => {
      signal.throwIfAborted();
      return await cleanupWaiterCount(holderPid);
    },
  };
}
