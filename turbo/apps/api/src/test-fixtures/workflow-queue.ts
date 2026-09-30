import { agentRuns } from "@okouai/db/runtime/agent-run";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

export async function readWorkflowRunTriggerSourceFixture(
  runId: string,
): Promise<string | null> {
  const [run] = await db()
    .select({ triggerSource: agentRuns.triggerSource })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return run?.triggerSource ?? null;
}

const automationPidRowSchema = z.object({ pid: z.int() });
const automationWaiterRowSchema = z.object({ waiterCount: z.int() });
const automationCancelRowSchema = z.object({ cancelled: z.boolean() });

interface HeldWorkflowAutomationRow {
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly cancelBlockedWaiters: () => Promise<number>;
}

/**
 * Hold one automation row lock open.
 *
 * No production API can keep this row locked while another caller waits, so
 * this fixture creates the real wait that a settlement has to cross before it
 * may sample its recurrence clock.
 */
export async function holdWorkflowAutomationRowFixture(args: {
  readonly automationId: string;
  readonly signal: AbortSignal;
}): Promise<HeldWorkflowAutomationRow> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await tx
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.automationId))
      .for("update");
    if (rows.length !== 1) {
      throw new Error("Expected one workflow automation fixture row");
    }
    const pids = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      automationPidRowSchema,
    );
    const pid = pids[0]?.pid;
    if (!pid) {
      throw new Error("Expected the automation lock holder pid");
    }
    started.resolve(pid);
    await released.promise;
  });
  const holderPid = await started.promise;
  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_stat_activity AS activity
          WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        `,
        automationWaiterRowSchema,
      );
      const [row] = rows;
      if (!row || rows.length !== 1) {
        throw new Error("Expected one automation waiter count row");
      }
      return row.waiterCount;
    },
    // No production API can fail a claim transaction at this exact point. Only
    // queries blocked on this fixture's own row lock are cancelled.
    cancelBlockedWaiters: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT pg_cancel_backend(activity.pid) AS "cancelled"
          FROM pg_stat_activity AS activity
          WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        `,
        automationCancelRowSchema,
      );
      return rows.filter((row) => {
        return row.cancelled;
      }).length;
    },
  };
}
