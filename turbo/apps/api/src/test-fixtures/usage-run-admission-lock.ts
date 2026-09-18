import { count, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { lockOrgCredits } from "../signals/services/usage-allowance.service";
import { createDeferredPromise } from "../signals/utils";

const pidSchema = z.object({ pid: z.int() });
const countSchema = z.object({ count: z.int() });

async function admittedCreatorCount(holderPid: number): Promise<number> {
  const [result] = await executeRawRows(
    db(),
    sql`SELECT ${count()}::int AS count
      FROM pg_stat_activity AS creator
      WHERE ${holderPid} = ANY(pg_blocking_pids(creator.pid))
        AND EXISTS (
          SELECT 1 FROM pg_locks AS admission
          WHERE admission.pid = creator.pid AND admission.granted
            AND admission.locktype = 'advisory'
            AND admission.mode = 'ShareLock'
        )
        AND EXISTS (
          SELECT 1 FROM pg_locks AS parent
          WHERE parent.pid = creator.pid AND parent.granted
            AND parent.relation = 'agents'::regclass
            AND parent.mode = 'RowShareLock'
        )`,
    countSchema,
  );
  if (!result) {
    throw new Error("Missing admitted Run creator count");
  }
  return result.count;
}

async function cleanupWaiterCount(holderPid: number): Promise<number> {
  const [result] = await executeRawRows(
    db(),
    sql`SELECT ${count()}::int AS count
      FROM pg_stat_activity AS cleanup
      WHERE EXISTS (
          SELECT 1 FROM pg_locks AS waiting
          WHERE waiting.pid = cleanup.pid AND NOT waiting.granted
        )
        AND EXISTS (
          SELECT 1 FROM pg_stat_activity AS creator
          WHERE ${holderPid} = ANY(pg_blocking_pids(creator.pid))
            AND creator.pid = ANY(pg_blocking_pids(cleanup.pid))
        )`,
    countSchema,
  );
  if (!result) {
    throw new Error("Missing Run-admission cleanup waiter count");
  }
  return result.count;
}

/** Infrastructure exception: HTTP cannot pause a Run's allowance activation
 * after it owns its Agent. Hold only the caller's org credit advisory lock;
 * the barrier additionally requires the real creator's subject and parent locks.
 */
export async function holdRunAllowanceAdmissionForTest(
  orgId: string,
  signal: AbortSignal,
) {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await lockOrgCredits(tx, orgId);
    const [holder] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      pidSchema,
    );
    if (!holder) {
      throw new Error("Missing Run-allowance admission lock holder");
    }
    started.resolve(holder.pid);
    await released.promise;
    signal.throwIfAborted();
  });
  const holderPid = await Promise.race([started.promise, done]);
  if (holderPid === undefined) {
    throw new Error("Run-admission fixture finished before taking its lock");
  }
  return {
    done,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    admittedCreatorCount: async () => {
      signal.throwIfAborted();
      return await admittedCreatorCount(holderPid);
    },
    cleanupWaiterCount: async () => {
      signal.throwIfAborted();
      return await cleanupWaiterCount(holderPid);
    },
  };
}
