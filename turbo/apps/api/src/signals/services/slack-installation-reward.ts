import { randomUUID } from "node:crypto";
import {
  GET_STARTED_REWARDS,
  GET_STARTED_REWARD_TTL_MS,
} from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, or, sql } from "drizzle-orm";

export function slackRewardIdentity(
  orgId: string,
  userId: string,
  workspaceId: string,
  at: Date,
) {
  return {
    values: {
      orgId,
      actorUserId: userId,
      beneficiaryUserId: null,
      questKey: "slack" as const,
      sourceKey: workspaceId,
      rewardAmount: GET_STARTED_REWARDS.slack.amount,
      rewardTarget: "org" as const,
      completedAt: at,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    },
    where: and(
      eq(getStartedClaims.actorUserId, userId),
      eq(getStartedClaims.questKey, "slack"),
      eq(getStartedClaims.sourceKey, workspaceId),
    ),
    awardsWhere: or(
      eq(getStartedClaims.rewardKey, `slack:${workspaceId}`),
      and(
        eq(getStartedClaims.orgId, orgId),
        eq(getStartedClaims.questKey, "slack"),
        eq(getStartedClaims.status, "granted"),
      ),
    ),
    rewardKey: `slack:${workspaceId}`,
  };
}

export function slackRewardUnavailableReason(
  rewardKey: string,
  awards: readonly { rewardKey: string | null }[],
) {
  return awards.some((award) => {
    return award.rewardKey === rewardKey;
  })
    ? "already_redeemed"
    : awards.length > 0
      ? "limit_reached"
      : null;
}

/** Executed only with the wallet and existing claim owned by the caller command. */
export function slackOrgRewardSql(
  claim: typeof getStartedClaims.$inferSelect,
  rewardKey: string,
  at: Date,
) {
  const recordId = randomUUID();
  const expiresAt = new Date(at.getTime() + GET_STARTED_REWARD_TTL_MS);
  return sql`WITH grant_record AS (
    INSERT INTO ${creditExpiresRecord} (id, org_id, source, amount, remaining, expires_at, created_at)
    VALUES (${recordId}::uuid, ${claim.orgId}, 'get_started_reward', ${claim.rewardAmount}, ${claim.rewardAmount},
      ${sql.param(expiresAt, creditExpiresRecord.expiresAt)}, ${sql.param(at, creditExpiresRecord.createdAt)})
    RETURNING id
  ), credited AS (
    UPDATE ${orgMetadata} SET credits = credits + ${claim.rewardAmount}, updated_at = ${sql.param(at, orgMetadata.updatedAt)}
    WHERE ${orgMetadata.orgId} = ${claim.orgId} AND EXISTS (SELECT 1 FROM grant_record)
    RETURNING org_id
  )
  UPDATE ${getStartedClaims} SET status = 'granted', reward_key = ${rewardKey}, reward_slot = NULL,
    org_credit_record_id = ${recordId}::uuid, granted_at = ${sql.param(at, getStartedClaims.grantedAt)},
    expires_at = ${sql.param(expiresAt, getStartedClaims.expiresAt)}, reason = NULL,
    completed_at = COALESCE(completed_at, ${sql.param(at, getStartedClaims.completedAt)}),
    lease_id = NULL, lease_expires_at = NULL, updated_at = ${sql.param(at, getStartedClaims.updatedAt)}
  WHERE ${getStartedClaims.id} = ${claim.id} AND EXISTS (SELECT 1 FROM credited)`;
}
