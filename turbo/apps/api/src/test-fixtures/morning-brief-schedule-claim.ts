import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { asc, eq } from "drizzle-orm";

import { db } from "../lib/db";

export interface MorningBriefScheduleClaimSnapshot {
  readonly id: string;
  readonly automationId: string;
  readonly orgId: string;
  readonly ownerUserId: string;
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
