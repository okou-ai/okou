import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { and, eq, isNull } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";

/** The live claim consumed before the sole provider POST. */
export interface MorningBriefNativeActiveAuthority {
  readonly ownerEpoch: number;
  readonly membershipId: string;
  readonly leaseToken: string;
  readonly generationAttemptId?: never;
}

/** The durable attempt used by readback and delivery after claim settlement. */
export interface MorningBriefNativeRetainedAuthority {
  readonly ownerEpoch: number;
  readonly membershipId: string;
  readonly leaseToken?: never;
  readonly generationAttemptId: string;
}

export type MorningBriefNativeCollectionAuthority =
  | MorningBriefNativeActiveAuthority
  | MorningBriefNativeRetainedAuthority;

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

function authorityCanReadSettledResult(args: {
  readonly settledAt: Date | null;
  readonly outcome: string | null;
  readonly authority: MorningBriefNativeCollectionAuthority;
}): boolean {
  if (args.authority.leaseToken !== undefined) {
    return args.settledAt === null;
  }
  return args.settledAt === null || args.outcome === "delivered";
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
      generationAttemptId: morningBriefNativeOccurrences.generationAttemptId,
      settledAt: morningBriefNativeOccurrences.settledAt,
      outcome: morningBriefNativeOccurrences.outcome,
    })
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, binding.orgId),
        eq(morningBriefNativeOccurrences.userId, binding.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, binding.scheduledFor),
        authority.leaseToken === undefined
          ? eq(
              morningBriefNativeOccurrences.generationAttemptId,
              authority.generationAttemptId,
            )
          : isNull(morningBriefNativeOccurrences.settledAt),
      ),
    )
    .limit(1);
  const [occurrence] = await query;
  return (
    occurrence?.ownerEpoch === authority.ownerEpoch &&
    occurrence.membershipId === authority.membershipId &&
    (authority.leaseToken === undefined
      ? occurrence.generationAttemptId === authority.generationAttemptId
      : occurrence.leaseToken === authority.leaseToken) &&
    authorityCanReadSettledResult({
      settledAt: occurrence.settledAt,
      outcome: occurrence.outcome,
      authority,
    })
  );
}

/** Resolve the epoch and membership frozen with one persisted attempt. */
export async function loadMorningBriefNativeRetainedAuthority(
  db: NativeAuthorityReader,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly scheduledFor: Date;
    readonly generationAttemptId: string;
  },
): Promise<MorningBriefNativeRetainedAuthority | undefined> {
  const [occurrence] = await db
    .select({
      ownerEpoch: morningBriefNativeOccurrences.ownerEpoch,
      membershipId: morningBriefNativeOccurrences.membershipId,
      settledAt: morningBriefNativeOccurrences.settledAt,
      outcome: morningBriefNativeOccurrences.outcome,
    })
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, args.orgId),
        eq(morningBriefNativeOccurrences.userId, args.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
        eq(
          morningBriefNativeOccurrences.generationAttemptId,
          args.generationAttemptId,
        ),
      ),
    )
    .limit(1);
  if (
    occurrence === undefined ||
    (occurrence.settledAt !== null && occurrence.outcome !== "delivered")
  ) {
    return undefined;
  }
  return {
    ownerEpoch: occurrence.ownerEpoch,
    membershipId: occurrence.membershipId,
    generationAttemptId: args.generationAttemptId,
  };
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
