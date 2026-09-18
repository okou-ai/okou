import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

const backendRowSchema = z.object({ pid: z.int() });
const waiterRowSchema = z.object({ pid: z.int(), query: z.string() });

/** One backend that is waiting for a lock, and the statement it waits on. */
export interface WorkflowAutomationThreadLockWaiter {
  readonly pid: number;
  readonly query: string;
}

/**
 * Hold the binding row that automation thread reuse and thread deletion both
 * have to lock.
 *
 * No product endpoint can suspend a transaction between the two row locks whose
 * order is under test, so this fixture parks both callers on the second lock and
 * lets the test observe which one they each reached. It changes no persisted
 * state: every outcome is still asserted through the public routes.
 */
export async function holdWorkflowAutomationThreadBindingFixture(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly waiters: () => Promise<
    readonly WorkflowAutomationThreadLockWaiter[]
  >;
}> {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    const [binding] = await tx
      .select({ id: workflowUserAutomationThreads.id })
      .from(workflowUserAutomationThreads)
      .where(
        and(
          eq(workflowUserAutomationThreads.orgId, args.orgId),
          eq(workflowUserAutomationThreads.userId, args.userId),
          eq(workflowUserAutomationThreads.workflowId, args.workflowId),
        ),
      )
      .for("update");
    if (!binding) {
      throw new Error("Expected the workflow automation thread binding");
    }
    const [backend] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      backendRowSchema,
    );
    if (!backend) {
      throw new Error("Expected the binding lock holder pid");
    }
    started.resolve(backend.pid);
    await released.promise;
  });
  const holderPid = await Promise.race([
    started.promise,
    (async () => {
      await done;
      throw new Error("Binding lock ended before becoming ready");
    })(),
  ]);

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve();
      }
    },
    done,
    // Waiting behind another waiter is the same arrival evidence as waiting on
    // the holder directly: a caller that already owns the thread row is the one
    // the next caller queues on.
    waiters: async () => {
      return await executeRawRows(
        db(),
        sql`
          WITH RECURSIVE waiter(pid) AS (
            SELECT activity.pid
              FROM pg_stat_activity AS activity
             WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
            UNION
            SELECT activity.pid
              FROM pg_stat_activity AS activity
              JOIN waiter ON waiter.pid = ANY(pg_blocking_pids(activity.pid))
          )
          SELECT activity.pid AS "pid", activity.query AS "query"
            FROM waiter
            JOIN pg_stat_activity AS activity ON activity.pid = waiter.pid
           WHERE activity.wait_event_type = 'Lock'
        `,
        waiterRowSchema,
      );
    },
  };
}
