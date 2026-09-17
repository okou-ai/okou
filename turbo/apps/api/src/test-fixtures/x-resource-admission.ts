import { xResourceReads } from "@okouai/db/schema/x-resource-usage";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import {
  lockXResourceAdmission,
  setXResourceTransactionTimeouts,
  withXResourceClockForTest,
} from "../signals/services/x-resource-usage-lifecycle";
import { createDeferredPromise } from "../signals/utils";

/** Scope a database-clock override to one test-owned API operation. */
export async function withXResourceClock<T>(
  clock: () => Date,
  work: () => Promise<T>,
): Promise<T> {
  return await withXResourceClockForTest(clock, work);
}

const holderRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ count: z.int() });

/** Infrastructure exception: HTTP callers cannot pause admission while holding
 * its database lock or advance the database clock at that boundary. Tests use
 * this fixture only to prove cleanup waits, then samples its admission clock.
 */
export async function holdXResourceAdmissionForTest(signal: AbortSignal) {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await lockXResourceAdmission(tx, "shared");
    signal.throwIfAborted();
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      holderRowSchema,
    );
    signal.throwIfAborted();
    const holder = rows[0];
    if (!holder) {
      throw new Error("Missing X resource admission lock holder");
    }
    started.resolve(holder.pid);
    await released.promise;
  });
  const holderPid = await Promise.race([started.promise, done]);
  if (holderPid === undefined) {
    throw new Error("Admission lock fixture finished before acquiring lock");
  }
  return {
    done,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    waiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`SELECT ${count()}::int AS count
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'advisory'
            AND NOT waiting.granted
            AND waiting.mode = 'ExclusiveLock'
            AND (waiting.classid, waiting.objid, waiting.objsubid) IN (
              SELECT held.classid, held.objid, held.objsubid
              FROM pg_locks AS held
              WHERE held.locktype = 'advisory'
                AND held.pid = ${holderPid}
                AND held.granted
            )`,
        waiterCountRowSchema,
      );
      signal.throwIfAborted();
      const result = rows[0];
      if (!result) {
        throw new Error("Missing X resource admission waiter count");
      }
      return result.count;
    },
  };
}

/** Infrastructure exception: an HTTP caller cannot pause an uncommitted
 * resource insert and remove it before committing. The caller must supply a
 * uniquely owned resource key. Releasing the fixture leaves no committed row,
 * so the blocked production ON CONFLICT insert must claim the resource itself.
 */
export async function holdXResourceClaimForTest(
  resource: {
    readonly resourceId: string;
    readonly utcDay: string;
    readonly resourceType: "post" | "user";
  },
  signal: AbortSignal,
) {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await setXResourceTransactionTimeouts(tx);
    signal.throwIfAborted();
    await tx.insert(xResourceReads).values(resource);
    signal.throwIfAborted();
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      holderRowSchema,
    );
    signal.throwIfAborted();
    const holder = rows[0];
    if (!holder) {
      throw new Error("Missing X resource claim holder");
    }
    started.resolve(holder.pid);
    await released.promise;
    signal.throwIfAborted();
    await tx
      .delete(xResourceReads)
      .where(
        and(
          eq(xResourceReads.utcDay, resource.utcDay),
          eq(xResourceReads.resourceType, resource.resourceType),
          eq(xResourceReads.resourceId, resource.resourceId),
        ),
      );
    signal.throwIfAborted();
  });
  const holderPid = await Promise.race([started.promise, done]);
  if (holderPid === undefined) {
    throw new Error("Resource claim fixture finished before inserting its row");
  }
  return {
    done,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    blockedWaiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`SELECT ${count()}::int AS count
          FROM pg_stat_activity AS waiting
          WHERE ${holderPid} = ANY(pg_blocking_pids(waiting.pid))`,
        waiterCountRowSchema,
      );
      signal.throwIfAborted();
      const result = rows[0];
      if (!result) {
        throw new Error("Missing X resource claim waiter count");
      }
      return result.count;
    },
    blockedRunDeletionCount: async () => {
      // A terminal Run's cleanup skips cancellation updates. Observe Clerk's
      // downstream admission or Run wait behind this upload beyond the former
      // 100ms timeout, rather than sleeping or releasing the resource gate
      // before the old lifecycle/preflight bug can occur.
      const rows = await executeRawRows(
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
              SELECT 1 FROM pg_stat_activity AS upload
              WHERE ${holderPid} = ANY(pg_blocking_pids(upload.pid))
                AND upload.pid = ANY(pg_blocking_pids(cleanup.pid))
            )`,
        waiterCountRowSchema,
      );
      signal.throwIfAborted();
      const result = rows[0];
      if (!result) {
        throw new Error("Missing X resource Run deletion waiter count");
      }
      return result.count;
    },
  };
}
