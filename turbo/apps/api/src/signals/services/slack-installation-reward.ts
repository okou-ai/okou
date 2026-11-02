import { GET_STARTED_REWARDS } from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { and, eq, notInArray, or, sql, type SQL } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
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

/** Persist completion with its source publication, before financial settlement. */
export function pendingSlackRewardSql(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workspaceId: string;
  },
  at: Date,
  source: SQL,
) {
  const reward = slackRewardIdentity(
    args.orgId,
    args.userId,
    args.workspaceId,
    at,
  );
  return sql`INSERT INTO ${getStartedClaims} (
    org_id, actor_user_id, quest_key, source_key, reward_amount, reward_target,
    completed_at, next_attempt_at, created_at, updated_at
  ) SELECT ${args.orgId}, ${args.userId}, 'slack', ${args.workspaceId},
      ${reward.values.rewardAmount}, 'org', ${sql.param(at, getStartedClaims.completedAt)},
      ${sql.param(at, getStartedClaims.nextAttemptAt)}, ${sql.param(at, getStartedClaims.createdAt)},
      ${sql.param(at, getStartedClaims.updatedAt)} FROM (${source}) AS completed_slack_source WHERE true
    ON CONFLICT (actor_user_id, quest_key, source_key) DO NOTHING RETURNING id`;
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
export function unsettledSlackClaim(id: string) {
  return and(
    eq(getStartedClaims.id, id),
    notInArray(getStartedClaims.status, ["granted", "ineligible", "rejected"]),
  );
}

/** Only the financial uniqueness constraints represent a lost reward race. */
export function slackRewardGrantFailureReason(
  result:
    { readonly ok: true } | { readonly ok: false; readonly error: unknown },
): ReturnType<typeof slackRewardUnavailableReason> {
  if (result.ok) {
    return null;
  }
  const error = result.error;
  if (isUniqueViolation(error, "uq_get_started_reward_key")) {
    return "already_redeemed";
  }
  if (
    isUniqueViolation(error, "uq_get_started_slack_org") ||
    isUniqueViolation(error, "uq_credit_expires_slack_reward_org")
  ) {
    return "limit_reached";
  }
  throw error;
}
