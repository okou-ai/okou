import type { GetStartedClaimRow } from "./get-started-rewards.service";

/** Stable financial fields; leases and later updatedAt changes are not part of the receipt. */
export function marketingRewardReceipt(claim: GetStartedClaimRow) {
  return {
    id: claim.id,
    orgId: claim.orgId,
    actorUserId: claim.actorUserId,
    beneficiaryUserId: claim.beneficiaryUserId,
    questKey: claim.questKey,
    sourceKey: claim.sourceKey,
    rewardKey: claim.rewardKey,
    rewardSlot: claim.rewardSlot,
    rewardTarget: claim.rewardTarget,
    rewardAmount: claim.rewardAmount,
    reason: claim.reason,
    status: claim.status,
    memberCreditGrantId: claim.memberCreditGrantId,
    orgCreditRecordId: claim.orgCreditRecordId,
    grantedAt: claim.grantedAt?.toISOString() ?? null,
    expiresAt: claim.expiresAt?.toISOString() ?? null,
    createdAt: claim.createdAt.toISOString(),
  };
}
