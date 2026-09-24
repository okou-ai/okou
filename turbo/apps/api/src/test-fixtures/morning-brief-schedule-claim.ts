import { randomUUID } from "node:crypto";

import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import {
  clearMorningBriefSettlementAttemptHookForTest,
  setMorningBriefSettlementAttemptHookForTest,
} from "../signals/services/morning-brief-schedule-claim.service";
import {
  clearWorkflowAutomationCommittedRunHookForTest,
  setWorkflowAutomationCommittedRunHookForTest,
  type WorkflowAutomationCommittedRunSnapshot,
} from "../signals/services/workflow-automation-launch.service";
import { withPreparedLaunchPersistenceObserverForTest } from "../signals/services/prepared-launch-persistence-observer.service";
import { createDeferredPromise } from "../signals/utils";

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

/**
 * Remove the journal binding from a real claimed Run to reproduce a pre-S7a
 * compatibility execution. Current production entry points always journal new
 * Morning Brief Runs, so no external API can construct this retained state.
 */
export async function removeMorningBriefScheduleClaimForCompatibilityFixture(args: {
  readonly automationId: string;
  readonly runId: string;
}): Promise<void> {
  const removed = await db()
    .delete(morningBriefScheduleClaims)
    .where(
      and(
        eq(morningBriefScheduleClaims.automationId, args.automationId),
        eq(morningBriefScheduleClaims.runId, args.runId),
      ),
    )
    .returning({ id: morningBriefScheduleClaims.id });
  if (removed.length !== 1) {
    throw new Error("Expected one Morning Brief compatibility claim");
  }
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
 * Fail one test-owned launch after its real atomic persistence statement.
 *
 * No public API can force a transaction failure at this exact boundary. The
 * case remains valuable because it proves the Run and journal binding roll
 * back atomically while setup and verification stay on production routes.
 */
export async function withWorkflowAutomationRunPersistenceFailureFixture(args: {
  readonly automationId: string;
  readonly work: () => Promise<void>;
}): Promise<{ readonly attempts: number }> {
  let attempts = 0;
  await withPreparedLaunchPersistenceObserverForTest((workflowAutomationId) => {
    if (workflowAutomationId !== args.automationId) {
      return;
    }
    attempts += 1;
    throw new Error("forced Morning Brief Run persistence rollback");
  }, args.work);
  return { attempts };
}
