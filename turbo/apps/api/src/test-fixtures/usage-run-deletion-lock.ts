import { conversations } from "@okouai/db/schema/conversation";
import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

const pidSchema = z.object({ pid: z.int() });
const countSchema = z.object({ count: z.int() });

/** Infrastructure exception: HTTP cannot pause a real Run deletion between
 * owning its Run and removing its conversation. Hold only this API-created
 * conversation; no history, lifecycle, or accounting values are rewritten.
 */
export async function holdRunConversationDeletionForTest(
  runId: string,
  signal: AbortSignal,
) {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.runId, runId))
      .for("update");
    if (!owned) {
      throw new Error("Expected the API-created Run conversation");
    }
    const [holder] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      pidSchema,
    );
    if (!holder) {
      throw new Error("Missing conversation deletion lock holder");
    }
    started.resolve(holder.pid);
    await released.promise;
    signal.throwIfAborted();
  });
  const holderPid = await Promise.race([started.promise, done]);
  if (holderPid === undefined) {
    throw new Error("Conversation fixture finished before acquiring its lock");
  }
  return {
    done,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    deletionWaiterCount: async () => {
      signal.throwIfAborted();
      const [result] = await executeRawRows(
        db(),
        sql`SELECT ${count()}::int AS count
          FROM pg_stat_activity AS deletion
          WHERE ${holderPid} = ANY(pg_blocking_pids(deletion.pid))`,
        countSchema,
      );
      if (!result) {
        throw new Error("Missing Run deletion waiter count");
      }
      return result.count;
    },
    cleanupWaiterCount: async () => {
      signal.throwIfAborted();
      const [result] = await executeRawRows(
        db(),
        sql`SELECT ${count()}::int AS count
          FROM pg_stat_activity AS cleanup
          WHERE EXISTS (
            SELECT 1 FROM pg_stat_activity AS deletion
            WHERE ${holderPid} = ANY(pg_blocking_pids(deletion.pid))
              AND deletion.pid = ANY(pg_blocking_pids(cleanup.pid))
          )`,
        countSchema,
      );
      if (!result) {
        throw new Error("Missing account cleanup waiter count");
      }
      return result.count;
    },
  };
}
