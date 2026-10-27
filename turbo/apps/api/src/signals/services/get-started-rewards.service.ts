import {
  GET_STARTED_REWARDS,
  getStartedQuestKeySchema,
  type GetStartedClaim,
  type GetStartedStatus,
} from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { and, count, desc, eq, inArray, or } from "drizzle-orm";

import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";

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
    // Retired share receipts are never selected for a response.
    questKey: getStartedQuestKeySchema.parse(row.questKey),
    status: row.status,
    rewardAmount: row.rewardAmount,
    rewardTarget: row.rewardTarget,
    reason: row.reason,
    submittedAt: row.createdAt.toISOString(),
    grantedAt: row.grantedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
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
  // A retired share receipt is never granted again.
  const limit =
    GET_STARTED_REWARDS[getStartedQuestKeySchema.parse(claim.questKey)].limit;
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

function getStartedQuests(
  groups: readonly {
    readonly questKey: GetStartedClaimRow["questKey"];
    readonly status: GetStartedClaimRow["status"];
    readonly total: number;
  }[],
  isAdmin: boolean,
  claimedToday: boolean,
): GetStartedStatus["quests"] {
  return getStartedQuestKeySchema.options
    .filter((key) => {
      return isAdmin || (key !== "slack" && key !== "invite");
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
            ? !claimedToday
            : reward.limit === null || claimedCount < reward.limit,
      };
    });
}

export const getStartedStatus$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly isAdmin: boolean;
    },
    signal: AbortSignal,
  ): Promise<GetStartedStatus> => {
    const db = get(db$);
    const at = nowDate();
    const owner = or(
      eq(getStartedClaims.beneficiaryUserId, args.userId),
      and(
        eq(getStartedClaims.orgId, args.orgId),
        eq(getStartedClaims.questKey, "slack"),
      ),
    );
    const [groups, [today], checkinDays, recent] = await Promise.all([
      db
        .select({
          questKey: getStartedClaims.questKey,
          status: getStartedClaims.status,
          total: count(),
        })
        .from(getStartedClaims)
        .where(owner)
        .groupBy(getStartedClaims.questKey, getStartedClaims.status),
      db
        .select({ id: getStartedClaims.id })
        .from(getStartedClaims)
        .where(
          eq(
            getStartedClaims.rewardKey,
            `checkin:${args.userId}:${getStartedUtcDay(at)}`,
          ),
        )
        .limit(1),
      // The reward key ends in the UTC day, and ISO days sort chronologically, so
      // the most recent claims come back first without a date column of their own.
      db
        .select({ rewardKey: getStartedClaims.rewardKey })
        .from(getStartedClaims)
        .where(
          and(
            eq(getStartedClaims.beneficiaryUserId, args.userId),
            eq(getStartedClaims.questKey, "checkin"),
          ),
        )
        .orderBy(desc(getStartedClaims.rewardKey))
        .limit(400),
      db
        .select()
        .from(getStartedClaims)
        .where(
          and(
            owner,
            eq(getStartedClaims.orgId, args.orgId),
            eq(getStartedClaims.status, "granted"),
            inArray(
              getStartedClaims.questKey,
              getStartedQuestKeySchema.options,
            ),
          ),
        )
        .orderBy(desc(getStartedClaims.grantedAt), desc(getStartedClaims.id))
        .limit(20),
    ]);
    signal.throwIfAborted();
    const quests = getStartedQuests(groups, args.isAdmin, Boolean(today));
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
      recentGrants: recent.map(getStartedClaimResponse),
    };
  },
);
