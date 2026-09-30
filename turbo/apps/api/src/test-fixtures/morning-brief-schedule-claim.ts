import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { asc, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { withPreparedLaunchPersistenceObserverForTest } from "../signals/services/prepared-launch-persistence-observer.service";

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
