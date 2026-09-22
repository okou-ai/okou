import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { and, eq, isNull } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";

/**
 * The live claim consumed before the sole provider POST.
 *
 * It is the only shape a collection runs under. A second, attempt-keyed shape
 * existed for the retained-source re-check that read a settled occurrence back;
 * that check is gone (#35949), so the lease is the whole question.
 */
export interface MorningBriefNativeActiveAuthority {
  readonly ownerEpoch: number;
  readonly membershipId: string;
  readonly leaseToken: string;
}

export type MorningBriefNativeCollectionAuthority =
  MorningBriefNativeActiveAuthority;

interface MorningBriefNativeCollectionBinding {
  readonly orgId: string;
  readonly userId: string;
  readonly scheduledFor: Date;
  readonly installationId: string;
  readonly automationId: string;
  readonly agentId: string;
  readonly chatThreadId: string | null;
  readonly authority: MorningBriefNativeCollectionAuthority;
}

type NativeAuthorityReader = Pick<ReadonlyDb, "select">;

function scheduleMatches(
  schedule: typeof morningBriefNativeSchedules.$inferSelect | undefined,
  binding: MorningBriefNativeCollectionBinding,
): boolean {
  return (
    schedule !== undefined &&
    (schedule.phase === "native" || schedule.phase === "rollback-draining") &&
    schedule.enabled &&
    schedule.ownerEpoch === binding.authority.ownerEpoch &&
    schedule.membershipId === binding.authority.membershipId &&
    schedule.agentId === binding.agentId &&
    schedule.chatThreadId === binding.chatThreadId &&
    schedule.legacyWorkflowId === binding.installationId &&
    schedule.legacyAutomationId === binding.automationId
  );
}

async function occurrenceMatches(
  db: NativeAuthorityReader,
  binding: MorningBriefNativeCollectionBinding,
): Promise<boolean> {
  const authority = binding.authority;
  const query = db
    .select({
      ownerEpoch: morningBriefNativeOccurrences.ownerEpoch,
      membershipId: morningBriefNativeOccurrences.membershipId,
      leaseToken: morningBriefNativeOccurrences.leaseToken,
    })
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, binding.orgId),
        eq(morningBriefNativeOccurrences.userId, binding.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, binding.scheduledFor),
        // A settled occurrence has released its claim, so the lease this
        // collection holds is no longer the current authority for it.
        isNull(morningBriefNativeOccurrences.settledAt),
      ),
    )
    .limit(1);
  const [occurrence] = await query;
  return (
    occurrence?.ownerEpoch === authority.ownerEpoch &&
    occurrence.membershipId === authority.membershipId &&
    occurrence.leaseToken === authority.leaseToken
  );
}

/** Revalidate native authority without holding locks across provider I/O. */
export async function morningBriefNativeCollectionAuthorityIsCurrent(
  db: Db,
  binding: MorningBriefNativeCollectionBinding,
): Promise<boolean> {
  const [schedule] = await db
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, binding.orgId),
        eq(morningBriefNativeSchedules.userId, binding.userId),
      ),
    )
    .limit(1);
  return (
    scheduleMatches(schedule, binding) && (await occurrenceMatches(db, binding))
  );
}
