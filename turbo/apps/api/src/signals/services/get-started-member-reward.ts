import { randomUUID } from "node:crypto";
import {
  GET_STARTED_REWARDS,
  GET_STARTED_REWARD_TTL_MS,
} from "@okouai/api-contracts/contracts/get-started";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { GetStartedClaimRow } from "./get-started-rewards.service";

export function getStartedRewardAvailabilityQuery(
  claim: GetStartedClaimRow,
  rewardKey: string,
) {
  if (!claim.beneficiaryUserId || claim.rewardTarget !== "user") {
    throw new Error("Personal reward has no beneficiary");
  }
  const limit = GET_STARTED_REWARDS[claim.questKey].limit;
  return new QueryBuilder()
    .select({
      rewardKey: getStartedClaims.rewardKey,
      rewardSlot: getStartedClaims.rewardSlot,
    })
    .from(getStartedClaims)
    .where(
      or(
        eq(getStartedClaims.rewardKey, rewardKey),
        limit === null
          ? undefined
          : and(
              eq(getStartedClaims.beneficiaryUserId, claim.beneficiaryUserId),
              eq(getStartedClaims.questKey, claim.questKey),
              eq(getStartedClaims.status, "granted"),
            ),
      ),
    )
    .limit((limit ?? 0) + 1)
    .as("reward_availability");
}

/**
 * One conditional claim transition publishes at most one member grant. The
 * claim must still be unresolved under the observed lease; otherwise nothing
 * is written and the statement reports zero rows. Reward key and slot
 * uniqueness remain enforced by their unique indexes.
 */
export function getStartedMemberRewardSql(
  claim: GetStartedClaimRow,
  rewardKey: string,
  rewardSlot: number | null,
  evidenceText: string | undefined,
  at: Date,
) {
  if (!claim.beneficiaryUserId || claim.rewardTarget !== "user") {
    throw new Error(
      "Organization rewards must commit with the Slack installation",
    );
  }
  const grantId = randomUUID();
  const expiresAt = new Date(at.getTime() + GET_STARTED_REWARD_TTL_MS);
  let evidence = sql.empty();
  if (evidenceText !== undefined) {
    evidence = memberRewardEvidenceSql(evidenceText, at);
  }
  return sql`WITH claimed AS (
    UPDATE ${getStartedClaims} SET status = 'granted', reward_key = ${rewardKey}, reward_slot = ${rewardSlot},
    member_credit_grant_id = ${grantId}::uuid, org_credit_record_id = NULL,
    granted_at = ${sql.param(at, getStartedClaims.grantedAt)}, expires_at = ${sql.param(expiresAt, getStartedClaims.expiresAt)},
    completed_at = COALESCE(completed_at, ${sql.param(at, getStartedClaims.completedAt)}),
    updated_at = ${sql.param(at, getStartedClaims.updatedAt)}, reason = NULL, lease_id = NULL, lease_expires_at = NULL ${evidence}
    WHERE ${unresolvedClaimWhere(claim)}
    RETURNING ${getStartedClaims.id}
  ) INSERT INTO ${usagePackCreditGrants} (id, org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, expires_at)
    SELECT ${grantId}::uuid, ${claim.orgId}, ${claim.beneficiaryUserId}, 'bonus', ${`get-started:${claim.id}`}, ${claim.rewardAmount}, ${claim.rewardAmount}, ${sql.param(expiresAt, usagePackCreditGrants.expiresAt)}
    FROM claimed`;
}

/** The claim is still unresolved under the lease its redeemer observed. */
export function unresolvedClaimWhere(claim: GetStartedClaimRow) {
  return and(
    eq(getStartedClaims.id, claim.id),
    notInArray(getStartedClaims.status, ["granted", "ineligible", "rejected"]),
    claim.leaseId === null
      ? isNull(getStartedClaims.leaseId)
      : eq(getStartedClaims.leaseId, claim.leaseId),
  );
}

/**
 * Reads the organization wallet identity without a row lock. Member grants are
 * new rows with unique idempotency keys; settlement verifies its grant prefix
 * with xmin and an unseen-prefix probe, so a grant published concurrently is
 * ordered after that settlement rather than blocked by the wallet row.
 */
export function memberRewardWalletQuery(orgId: string) {
  return new QueryBuilder()
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .as("reward_wallet");
}

/** Automatic quests have one claim identity per user/source, also on older APIs. */
export function completedGetStartedQuestSql(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly questKey: "connector" | "checkin" | "imessage";
    readonly sourceKey: string;
  },
  at: Date,
) {
  if (args.questKey === "imessage" && args.sourceKey !== "agentphone-link") {
    throw new Error("Unexpected iMessage quest source");
  }
  const claimId = randomUUID();
  const grantId = randomUUID();
  const reward = GET_STARTED_REWARDS[args.questKey];
  const rewardKey = `${args.questKey}:${args.userId}:${args.sourceKey}`;
  const rewardSlot = args.questKey === "imessage" ? 1 : null;
  const expiresAt = new Date(at.getTime() + GET_STARTED_REWARD_TTL_MS);
  return sql`WITH claim AS (
    INSERT INTO ${getStartedClaims} (id, org_id, actor_user_id, beneficiary_user_id, quest_key, source_key,
      reward_amount, reward_target, status, reward_key, reward_slot, member_credit_grant_id,
      completed_at, granted_at, expires_at, next_attempt_at, created_at, updated_at)
    VALUES (${claimId}::uuid, ${args.orgId}, ${args.userId}, ${args.userId}, ${args.questKey}, ${args.sourceKey},
      ${reward.amount}, 'user', 'granted', ${rewardKey}, ${rewardSlot}, ${grantId}::uuid,
      ${sql.param(at, getStartedClaims.completedAt)}, ${sql.param(at, getStartedClaims.grantedAt)},
      ${sql.param(expiresAt, getStartedClaims.expiresAt)}, ${sql.param(at, getStartedClaims.nextAttemptAt)},
      ${sql.param(at, getStartedClaims.createdAt)}, ${sql.param(at, getStartedClaims.updatedAt)})
    ON CONFLICT (actor_user_id, quest_key, source_key) DO NOTHING RETURNING id
  ) INSERT INTO ${usagePackCreditGrants} (id, org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, expires_at)
    SELECT ${grantId}::uuid, ${args.orgId}, ${args.userId}, 'bonus', ${`get-started:${claimId}`}, ${reward.amount}, ${reward.amount},
      ${sql.param(expiresAt, usagePackCreditGrants.expiresAt)} FROM claim`;
}

function memberRewardEvidenceSql(evidenceText: string, at: Date) {
  return sql`, evidence_text = ${evidenceText}, reviewed_at = ${sql.param(at, getStartedClaims.reviewedAt)}`;
}
