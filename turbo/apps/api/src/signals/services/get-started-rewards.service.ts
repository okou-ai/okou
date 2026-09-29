import {
  GET_STARTED_REWARDS,
  getStartedQuestKeySchema,
  type GetStartedClaim,
  type GetStartedQuestKey,
  type GetStartedStatus,
} from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { and, count, desc, eq, or, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

export type GetStartedClaimRow = typeof getStartedClaims.$inferSelect;

/**
 * Every custom connector a user connects shares this one connector-quest
 * source. Custom connector identity is user-controlled (any user can create,
 * delete, and recreate connectors with the same credentials), so a per-connector
 * source would let one user farm the reward without limit.
 */
export const CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY = "custom";

export function getStartedUtcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Consecutive check-in days, counting back from today.
 *
 * Check-in claims dedupe on `checkin:{userId}:{utcDay}`, so the day is already
 * in the reward key and the streak needs no schema of its own. A user who has
 * not checked in yet today still has a live streak -- it only breaks once a
 * whole day passes without a claim -- so the walk starts at today and is
 * allowed to begin at yesterday instead.
 */
export function countCheckinStreak(
  days: readonly string[],
  today: string,
): number {
  const seen = new Set(days);
  const cursor = new Date(`${today}T00:00:00.000Z`);
  if (!seen.has(today)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  let streak = 0;
  while (seen.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export function getStartedClaimResponse(
  row: GetStartedClaimRow,
): GetStartedClaim {
  return {
    id: row.id,
    questKey: row.questKey,
    status: row.status,
    rewardAmount: row.rewardAmount,
    rewardTarget: row.rewardTarget,
    reason: row.reason,
    postUrl: row.postUrl,
    submittedAt: row.createdAt.toISOString(),
    grantedAt: row.grantedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

export async function createGetStartedClaim(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly actorUserId?: string;
    readonly questKey: GetStartedQuestKey;
    readonly sourceKey: string;
    readonly completedAt?: Date;
    readonly invitationId?: string;
    readonly inviteeUserId?: string;
    readonly postUrl?: string;
    readonly runId?: string;
    readonly workflowId?: string;
    readonly sourceEventId?: string;
  },
): Promise<GetStartedClaimRow> {
  const reward = GET_STARTED_REWARDS[args.questKey];
  const actorUserId = args.actorUserId ?? args.userId;
  const [created] = await tx
    .insert(getStartedClaims)
    .values({
      orgId: args.orgId,
      actorUserId,
      beneficiaryUserId: reward.target === "user" ? args.userId : null,
      questKey: args.questKey,
      sourceKey: args.sourceKey,
      rewardAmount: reward.amount,
      rewardTarget: reward.target,
      completedAt: args.completedAt,
      invitationId: args.invitationId,
      inviteeUserId: args.inviteeUserId,
      postUrl: args.postUrl,
      runId: args.runId,
      workflowId: args.workflowId,
      sourceEventId: args.sourceEventId,
      nextAttemptAt: nowDate(),
      createdAt: nowDate(),
      updatedAt: nowDate(),
    })
    .onConflictDoNothing({
      target: [
        getStartedClaims.actorUserId,
        getStartedClaims.questKey,
        getStartedClaims.sourceKey,
      ],
    })
    .returning();
  if (created) {
    return created;
  }
  const [existing] = await tx
    .select()
    .from(getStartedClaims)
    .where(
      and(
        eq(getStartedClaims.actorUserId, actorUserId),
        eq(getStartedClaims.questKey, args.questKey),
        eq(getStartedClaims.sourceKey, args.sourceKey),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error("Get started claim was not persisted");
  }
  return existing;
}

type RewardAvailability =
  | {
      readonly kind: "ineligible";
      readonly reason: "already_redeemed" | "limit_reached";
    }
  | { readonly kind: "available"; readonly slots: readonly (number | null)[] };

export function getRewardAvailabilityFromAwards(
  claim: GetStartedClaimRow,
  rewardKey: string,
  awards: readonly {
    readonly rewardKey: string | null;
    readonly rewardSlot: number | null;
  }[],
): RewardAvailability {
  const limit = GET_STARTED_REWARDS[claim.questKey].limit;
  if (
    awards.some((award) => {
      return award.rewardKey === rewardKey;
    })
  ) {
    return { kind: "ineligible", reason: "already_redeemed" };
  }
  if (limit === null) {
    return { kind: "available", slots: [null] };
  }
  if (awards.length >= limit) {
    return { kind: "ineligible", reason: "limit_reached" };
  }
  if (claim.questKey === "invite") {
    const occupied = new Set(
      awards.map((award) => {
        return award.rewardSlot;
      }),
    );
    return {
      kind: "available",
      slots: Array.from({ length: limit }, (_, index) => {
        return index + 1;
      }).filter((slot) => {
        return !occupied.has(slot);
      }),
    };
  }
  return {
    kind: "available",
    slots: [claim.questKey === "slack" ? null : 1],
  };
}

export async function getStartedStatus(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly isAdmin: boolean;
  },
): Promise<GetStartedStatus> {
  const at = nowDate();
  const owner = or(
    eq(getStartedClaims.beneficiaryUserId, args.userId),
    and(
      eq(getStartedClaims.orgId, args.orgId),
      eq(getStartedClaims.questKey, "slack"),
    ),
  );
  const groups = await db
    .select({
      questKey: getStartedClaims.questKey,
      status: getStartedClaims.status,
      total: count(),
    })
    .from(getStartedClaims)
    .where(owner)
    .groupBy(getStartedClaims.questKey, getStartedClaims.status);
  const [today] = await db
    .select({ id: getStartedClaims.id })
    .from(getStartedClaims)
    .where(
      eq(
        getStartedClaims.rewardKey,
        `checkin:${args.userId}:${getStartedUtcDay(at)}`,
      ),
    )
    .limit(1);
  // The reward key ends in the UTC day, and ISO days sort chronologically, so
  // the most recent claims come back first without a date column of their own.
  const checkinDays = await db
    .select({ rewardKey: getStartedClaims.rewardKey })
    .from(getStartedClaims)
    .where(
      and(
        eq(getStartedClaims.beneficiaryUserId, args.userId),
        eq(getStartedClaims.questKey, "checkin"),
      ),
    )
    .orderBy(desc(getStartedClaims.rewardKey))
    .limit(400);
  const [share] = await db
    .select()
    .from(getStartedClaims)
    .where(
      and(
        eq(getStartedClaims.beneficiaryUserId, args.userId),
        eq(getStartedClaims.questKey, "share"),
      ),
    )
    .orderBy(
      desc(sql`${getStartedClaims.status} = 'granted'`),
      desc(getStartedClaims.createdAt),
      desc(getStartedClaims.id),
    )
    .limit(1);
  const recent = await db
    .select()
    .from(getStartedClaims)
    .where(
      and(
        owner,
        eq(getStartedClaims.orgId, args.orgId),
        eq(getStartedClaims.status, "granted"),
      ),
    )
    .orderBy(desc(getStartedClaims.grantedAt), desc(getStartedClaims.id))
    .limit(20);
  const quests = getStartedQuestKeySchema.options
    .filter((key) => {
      return args.isAdmin || (key !== "slack" && key !== "invite");
    })
    .map((key) => {
      const reward = GET_STARTED_REWARDS[key];
      const claimedCount =
        groups.find((group) => {
          return group.questKey === key && group.status === "granted";
        })?.total ?? 0;
      const pendingCount = groups
        .filter((group) => {
          return (
            group.questKey === key &&
            (group.status === "pending" || group.status === "reviewing")
          );
        })
        .reduce((total, group) => {
          return total + group.total;
        }, 0);
      return {
        key,
        rewardAmount: reward.amount,
        rewardTarget: reward.target,
        claimedCount,
        limit: reward.limit,
        earnedCredits: claimedCount * reward.amount,
        pendingCount,
        canEarnMore:
          key === "checkin"
            ? !today
            : reward.limit === null || claimedCount < reward.limit,
      };
    });
  return {
    serverNow: at.toISOString(),
    nextResetAt: new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1),
    ).toISOString(),
    claimedToday: Boolean(today),
    checkinStreak: countCheckinStreak(
      checkinDays.flatMap((row) => {
        // A check-in always carries its day in the reward key, but the column
        // is nullable for the quests that do not need one.
        return row.rewardKey === null ? [] : [row.rewardKey.slice(-10)];
      }),
      getStartedUtcDay(at),
    ),
    quests,
    shareClaim: share ? getStartedClaimResponse(share) : null,
    recentGrants: recent.map(getStartedClaimResponse),
  };
}
