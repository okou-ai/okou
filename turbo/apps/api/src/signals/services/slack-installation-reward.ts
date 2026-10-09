import { randomUUID } from "node:crypto";
import {
  GET_STARTED_REWARDS,
  GET_STARTED_REWARD_TTL_MS,
} from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, notInArray, or, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { isUniqueViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
import { pendingOrgCreditExpirationQuery } from "./org-credit-expiration";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";

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
    conflict: {
      target: [
        getStartedClaims.actorUserId,
        getStartedClaims.questKey,
        getStartedClaims.sourceKey,
      ],
    },
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

/** Initial values only; the owning command inserts these iff it created the wallet. */
export function slackRewardWalletEntitlement(orgId: string) {
  return orgPlanEntitlementValues(
    { orgId, tier: "limited-free-1", source: "org_metadata_migration" },
    { stripeSubscriptionId: null, sourceMetadata: {} },
  );
}

export function slackRewardIneligibleValues(reason: string, at: Date) {
  return {
    status: "ineligible" as const,
    reason,
    updatedAt: at,
    leaseId: null,
    leaseExpiresAt: null,
  };
}

/** Terminal claims are never rewritten by a later completion. */
function unsettledSlackClaim(id: string) {
  return and(
    eq(getStartedClaims.id, id),
    notInArray(getStartedClaims.status, ["granted", "ineligible", "rejected"]),
  );
}

/**
 * One deterministic outcome for the caller's persisted Slack claim, in the
 * caller's transaction: already terminal, ineligible, granted, or deferred.
 *
 * - A concurrent grant for the same workspace (`uq_get_started_reward_key`) or
 *   organization (`uq_get_started_slack_org`) makes the grant statement fail
 *   inside its savepoint; the unique index already names the winner, so the
 *   claim becomes ineligible without re-reading or re-running.
 * - The caller expires the organization's due lots before this transaction.
 *   A lot that crossed its deadline in between leaves the claim pending, and
 *   the next Slack completion for this source settles it.
 */
export async function settleSlackRewardClaim(
  tx: Tx,
  identity: ReturnType<typeof slackRewardIdentity>,
  at: Date,
): Promise<void> {
  const [claim] = await tx
    .select()
    .from(getStartedClaims)
    .where(identity.where);
  if (!claim) {
    throw new Error("Slack completion claim was not persisted");
  }
  if (["granted", "ineligible", "rejected"].includes(claim.status)) {
    return;
  }
  const awards = await tx
    .select({ rewardKey: getStartedClaims.rewardKey })
    .from(getStartedClaims)
    .where(identity.awardsWhere)
    .limit(2);
  const reason = slackRewardUnavailableReason(identity.rewardKey, awards);
  if (reason) {
    await tx
      .update(getStartedClaims)
      .set(slackRewardIneligibleValues(reason, at))
      .where(unsettledSlackClaim(claim.id));
    return;
  }
  const [pending] = await tx
    .select()
    .from(pendingOrgCreditExpirationQuery(claim.orgId, at));
  if (pending) {
    return;
  }
  const granted = await settle(
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0248; new non-billing transactions are prohibited.
    tx.transaction(async (grantTx) => {
      await grantTx.execute(slackOrgRewardSql(claim, identity.rewardKey, at));
    }),
  );
  if (granted.ok) {
    return;
  }
  const lostReason = isUniqueViolation(
    granted.error,
    "uq_get_started_reward_key",
  )
    ? "already_redeemed"
    : isUniqueViolation(granted.error, "uq_get_started_slack_org")
      ? "limit_reached"
      : null;
  if (!lostReason) {
    throw granted.error;
  }
  await tx
    .update(getStartedClaims)
    .set(slackRewardIneligibleValues(lostReason, at))
    .where(unsettledSlackClaim(claim.id));
}
