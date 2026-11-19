import {
  GET_STARTED_REWARDS,
  getStartedQuestKeySchema,
  type GetStartedClaim,
} from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";

export type GetStartedClaimRow = typeof getStartedClaims.$inferSelect;

export function getStartedUtcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
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
