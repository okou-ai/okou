import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { claimMorningBriefSchedule } from "../signals/services/morning-brief-schedule-claim.service";
import { recordWorkflowAutomationLastRun } from "../signals/services/workflow-automation-launch.service";
import { createDeferredPromise } from "../signals/utils";

const claimPidRowSchema = z.object({ pid: z.int() });
const claimWaiterRowSchema = z.object({ waiterCount: z.int() });

interface MorningBriefScheduleClaimSnapshot {
  readonly id: string;
  readonly automationId: string;
  readonly orgId: string | null;
  readonly ownerUserId: string | null;
  readonly scheduledAnchorAt: Date;
  readonly claimedAt: Date;
  readonly claimSequence: number;
  readonly queueEventId: string | null;
  readonly runId: string | null;
  readonly queueDisposition: string;
  readonly settlement: string;
  readonly settledAt: Date | null;
}

/** Every journaled occurrence of one automation, oldest claim first. */
export async function readMorningBriefScheduleClaimsFixture(
  automationId: string,
): Promise<readonly MorningBriefScheduleClaimSnapshot[]> {
  return await db()
    .select({
      id: morningBriefScheduleClaims.id,
      automationId: morningBriefScheduleClaims.automationId,
      orgId: morningBriefScheduleClaims.orgId,
      ownerUserId: morningBriefScheduleClaims.ownerUserId,
      scheduledAnchorAt: morningBriefScheduleClaims.scheduledAnchorAt,
      claimedAt: morningBriefScheduleClaims.claimedAt,
      claimSequence: morningBriefScheduleClaims.claimSequence,
      queueEventId: morningBriefScheduleClaims.queueEventId,
      runId: morningBriefScheduleClaims.runId,
      queueDisposition: morningBriefScheduleClaims.queueDisposition,
      settlement: morningBriefScheduleClaims.settlement,
      settledAt: morningBriefScheduleClaims.settledAt,
    })
    .from(morningBriefScheduleClaims)
    .where(eq(morningBriefScheduleClaims.automationId, automationId))
    .orderBy(asc(morningBriefScheduleClaims.claimSequence));
}

/** The automation fields the late last-run write is allowed to touch. */
export async function readWorkflowAutomationLastRunFixture(
  automationId: string,
): Promise<{
  readonly lastRunId: string | null;
  readonly lastRunAt: Date | null;
  readonly updatedAt: Date;
}> {
  const [row] = await db()
    .select({
      lastRunId: workflowAutomations.lastRunId,
      lastRunAt: workflowAutomations.lastRunAt,
      updatedAt: workflowAutomations.updatedAt,
    })
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, automationId))
    .limit(1);
  if (!row) {
    throw new Error("Expected the workflow automation fixture row");
  }
  return row;
}

/**
 * Hold a real newer claim open.
 *
 * The production claim is executed inside an uncommitted transaction, so it
 * owns the automation row lock and its journal row exists but is invisible to
 * anything that started earlier. That is the exact interleaving a late
 * last-run write has to survive.
 */
export async function holdNewerMorningBriefClaimFixture(args: {
  readonly automationId: string;
  readonly owner: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly workflowId: string;
  };
  readonly scheduledAnchorAt: Date;
  readonly claimedAt: Date;
  readonly signal: AbortSignal;
}): Promise<{
  readonly commit: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const release = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const attempt = await claimMorningBriefSchedule(tx, {
      automationId: args.automationId,
      owner: args.owner,
      scheduledAnchorAt: args.scheduledAnchorAt,
      claimedAt: args.claimedAt,
    });
    if (attempt.kind !== "claimed") {
      throw new Error("Expected the newer Morning Brief claim to succeed");
    }
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      claimPidRowSchema,
    );
    const pid = rows[0]?.pid;
    if (!pid) {
      throw new Error("Expected the newer claim holder pid");
    }
    started.resolve(pid);
    await release.promise;
  });
  const holderPid = await started.promise;
  return {
    commit: () => {
      if (!release.settled()) {
        release.resolve(undefined);
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
        claimWaiterRowSchema,
      );
      const [row] = rows;
      if (!row || rows.length !== 1) {
        throw new Error("Expected one newer claim waiter count row");
      }
      return row.waiterCount;
    },
  };
}

/** Drive the production late last-run write directly. */
export async function recordWorkflowAutomationLastRunFixture(args: {
  readonly automationId: string;
  readonly runId: string;
}): Promise<void> {
  await recordWorkflowAutomationLastRun(db(), {
    automationId: args.automationId,
    runId: args.runId,
    recordLastRunId: true,
    recordLastRunAt: false,
    disableClaimedOnceSchedule: false,
  });
}
