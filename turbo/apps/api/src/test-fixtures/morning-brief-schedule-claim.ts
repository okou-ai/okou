import { randomUUID } from "node:crypto";

import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import {
  claimMorningBriefSchedule,
  clearMorningBriefSettlementAttemptHookForTest,
  setMorningBriefSettlementAttemptHookForTest,
} from "../signals/services/morning-brief-schedule-claim.service";
import {
  clearWorkflowAutomationCommittedRunHookForTest,
  recordWorkflowAutomationLastRun,
  setWorkflowAutomationCommittedRunHookForTest,
  type WorkflowAutomationCommittedRunSnapshot,
} from "../signals/services/workflow-automation-launch.service";
import { createDeferredPromise } from "../signals/utils";

const claimPidRowSchema = z.object({ pid: z.int() });
const claimWaiterRowSchema = z.object({ waiterCount: z.int() });
const sequenceStateRowSchema = z.object({
  lastValue: z.int(),
  isCalled: z.boolean(),
});

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

export function holdWorkflowAutomationCommittedRunFixture(args: {
  readonly automationId: string;
  readonly signal: AbortSignal;
  readonly rejectOnRelease?: boolean;
}): {
  readonly arrival: Promise<WorkflowAutomationCommittedRunSnapshot>;
  readonly release: () => void;
} {
  const arrival = createDeferredPromise<WorkflowAutomationCommittedRunSnapshot>(
    args.signal,
  );
  const release = createDeferredPromise<void>(args.signal);
  setWorkflowAutomationCommittedRunHookForTest(async (snapshot) => {
    if (snapshot.automationId !== args.automationId) {
      return;
    }
    arrival.resolve(snapshot);
    await release.promise;
    if (args.rejectOnRelease) {
      throw new Error("Forced post-commit workflow launch failure");
    }
  });
  return {
    arrival: arrival.promise,
    release: () => {
      clearWorkflowAutomationCommittedRunHookForTest();
      if (!release.settled()) {
        release.resolve(undefined);
      }
    },
  };
}

export function observeMorningBriefSettlementAttemptsFixture(args: {
  readonly automationId: string;
}): {
  readonly readArrivals: () => number;
  readonly release: () => void;
} {
  let arrivals = 0;
  setMorningBriefSettlementAttemptHookForTest((snapshot) => {
    if (snapshot.automationId === args.automationId) {
      arrivals += 1;
    }
    return Promise.resolve();
  });
  return {
    readArrivals: () => {
      return arrivals;
    },
    release: clearMorningBriefSettlementAttemptHookForTest,
  };
}

/**
 * Fail one real settlement update after the callback handler reaches the row.
 * The nontransactional sequence proves the rolled-back handler arrival while
 * leaving callback delivery bookkeeping free to persist a retryable failure.
 */
export async function installMorningBriefSettlementFailureFixture(args: {
  readonly automationId: string;
}): Promise<{
  readonly readAttempts: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const suffix = randomUUID().replaceAll("-", "");
  const suffixKey = suffix.slice(0, 10);
  const sequenceName = `mb_settlement_failure_attempts_${suffixKey}`;
  const functionName = `fail_mb_settlement_once_${suffix}`;
  const triggerName = `fail_mb_settlement_${suffixKey}_${args.automationId.replaceAll("-", "")}`;

  await db().execute(sql`CREATE SEQUENCE ${sql.identifier(sequenceName)}`);
  await db().execute(sql`
    CREATE FUNCTION ${sql.identifier(functionName)}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF replace(NEW.automation_id::text, '-', '') = split_part(TG_NAME, '_', 5)
         AND OLD.settlement = 'unsettled'
         AND NEW.settlement <> OLD.settlement THEN
        IF nextval(('mb_settlement_failure_attempts_' || split_part(TG_NAME, '_', 4))::regclass) = 1 THEN
          RAISE EXCEPTION 'forced Morning Brief settlement failure';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $function$
  `);
  await db().execute(sql`
    CREATE TRIGGER ${sql.identifier(triggerName)}
      AFTER UPDATE ON morning_brief_schedule_claims
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
  `);

  let released = false;
  return {
    readAttempts: async () => {
      const rows = await executeRawRows(
        db(),
        sql`SELECT last_value::int AS "lastValue", is_called AS "isCalled" FROM ${sql.identifier(sequenceName)}`,
        sequenceStateRowSchema,
      );
      const [row] = rows;
      if (!row) {
        throw new Error("Expected the settlement failure sequence");
      }
      return row.isCalled ? row.lastValue : 0;
    },
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await db().execute(
        sql`DROP TRIGGER IF EXISTS ${sql.identifier(triggerName)} ON morning_brief_schedule_claims`,
      );
      await db().execute(
        sql`DROP FUNCTION IF EXISTS ${sql.identifier(functionName)}()`,
      );
      await db().execute(
        sql`DROP SEQUENCE IF EXISTS ${sql.identifier(sequenceName)}`,
      );
    },
  };
}

/**
 * Install a scoped PostgreSQL trigger that raises after the real Run INSERT.
 *
 * No public API can ask PostgreSQL to fail at this exact statement boundary.
 * The trigger is scoped to one automation, and a nontransactional sequence
 * records arrival even though the surrounding launch transaction rolls back.
 */
export async function installWorkflowAutomationRunInsertFailureFixture(args: {
  readonly automationId: string;
}): Promise<{
  readonly readAttempts: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const suffix = randomUUID().replaceAll("-", "");
  const automationKey = args.automationId.replaceAll("-", "");
  const functionName = `test_mb_run_insert_fn_${suffix}`;
  const suffixKey = suffix.slice(0, 8);
  const triggerName = `test_mb_run_insert_${automationKey}_${suffixKey}`;
  const sequenceName = `test_mb_run_insert_seq_${suffixKey}`;
  await db().transaction(async (tx) => {
    await tx.execute(sql`CREATE SEQUENCE ${sql.identifier(sequenceName)}`);
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.workflow_automation_id IS NOT NULL
           AND replace(NEW.workflow_automation_id::text, '-', '') = split_part(TG_NAME, '_', 5) THEN
          PERFORM nextval(('test_mb_run_insert_seq_' || split_part(TG_NAME, '_', 6))::regclass);
          RAISE EXCEPTION 'forced Morning Brief Run INSERT rollback';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      AFTER INSERT ON agent_runs
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
  });

  let released = false;
  return {
    readAttempts: async () => {
      const rows = await executeRawRows(
        db(),
        sql`SELECT last_value::int AS "lastValue", is_called AS "isCalled" FROM ${sql.identifier(sequenceName)}`,
        sequenceStateRowSchema,
      );
      const [row] = rows;
      if (!row) {
        throw new Error("Expected the Run INSERT failure sequence");
      }
      return row.isCalled ? row.lastValue : 0;
    },
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await db().transaction(async (tx) => {
        await tx.execute(
          sql`DROP TRIGGER ${sql.identifier(triggerName)} ON agent_runs`,
        );
        await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
        await tx.execute(sql`DROP SEQUENCE ${sql.identifier(sequenceName)}`);
      });
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
