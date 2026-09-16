import {
  GET_STARTED_REWARDS,
  GET_STARTED_REWARD_TTL_MS,
  getStartedQuestKeySchema,
  type GetStartedClaim,
  type GetStartedQuestKey,
  type GetStartedStatus,
} from "@okouai/api-contracts/contracts/get-started";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { and, count, desc, eq, or, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { createUsagePackCreditGrant } from "./usage-pack-credit.service";
import { grantOrgCredits } from "./onboarding-credit-grants.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

export type GetStartedClaimRow = typeof getStartedClaims.$inferSelect;

/** Resolve the same registry and persisted overrides used by the App. */
export async function getStartedRewardsEnabled(
  db: Pick<Db, "select">,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(db, orgId, userId);
  return isFeatureEnabled(FeatureSwitchKey.GetStartedQuests, context);
}

export function getStartedUtcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
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
): Promise<GetStartedClaimRow | null> {
  if (!(await getStartedRewardsEnabled(tx, args.orgId, args.userId))) {
    return null;
  }
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

async function lockRedemption(
  tx: Tx,
  claim: GetStartedClaimRow,
  rewardKey: string,
): Promise<void> {
  const owner =
    claim.rewardTarget === "org" ? claim.orgId : claim.beneficiaryUserId;
  const keys = [
    `get-started:owner:${claim.questKey}:${owner}`,
    `get-started:reward:${rewardKey}`,
  ].sort();
  for (const key of keys) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
}

async function markIneligible(
  tx: Tx,
  id: string,
  reason: string,
): Promise<GetStartedClaimRow> {
  const [row] = await tx
    .update(getStartedClaims)
    .set({
      status: "ineligible",
      reason,
      updatedAt: nowDate(),
      leaseId: null,
      leaseExpiresAt: null,
    })
    .where(eq(getStartedClaims.id, id))
    .returning();
  if (!row) {
    throw new Error("Get started claim disappeared during redemption");
  }
  return row;
}

/** Call in the transaction owning completion, or a worker's short finalization transaction. */
export async function grantGetStartedClaim(
  tx: Tx,
  input: GetStartedClaimRow,
  rewardKey: string,
  evidenceText?: string,
): Promise<GetStartedClaimRow> {
  await lockRedemption(tx, input, rewardKey);
  const [claim] = await tx
    .select()
    .from(getStartedClaims)
    .where(eq(getStartedClaims.id, input.id))
    .for("update");
  if (!claim) {
    throw new Error("Get started claim disappeared before redemption");
  }
  if (input.leaseId !== null && claim.leaseId !== input.leaseId) {
    return claim;
  }
  if (
    claim.status === "granted" ||
    claim.status === "ineligible" ||
    claim.status === "rejected"
  ) {
    return claim;
  }
  const [existing] = await tx
    .select({ id: getStartedClaims.id })
    .from(getStartedClaims)
    .where(eq(getStartedClaims.rewardKey, rewardKey))
    .limit(1);
  if (existing) {
    return markIneligible(tx, claim.id, "already_redeemed");
  }

  const ownerCondition =
    claim.rewardTarget === "org"
      ? eq(getStartedClaims.orgId, claim.orgId)
      : eq(getStartedClaims.beneficiaryUserId, requiredBeneficiary(claim));
  const [awards] = await tx
    .select({ total: count() })
    .from(getStartedClaims)
    .where(
      and(
        ownerCondition,
        eq(getStartedClaims.questKey, claim.questKey),
        eq(getStartedClaims.status, "granted"),
      ),
    );
  if (!awards) {
    throw new Error("Get started award count is missing");
  }
  const limit = GET_STARTED_REWARDS[claim.questKey].limit;
  if (limit !== null && awards.total >= limit) {
    return markIneligible(tx, claim.id, "limit_reached");
  }

  const grantedAt = nowDate();
  const expiresAt = new Date(grantedAt.getTime() + GET_STARTED_REWARD_TTL_MS);
  let memberCreditGrantId: string | null = null;
  let orgCreditRecordId: string | null = null;
  if (claim.rewardTarget === "user") {
    const grant = await createUsagePackCreditGrant(tx, {
      orgId: claim.orgId,
      userId: requiredBeneficiary(claim),
      grantType: "bonus",
      idempotencyKey: `get-started:${claim.id}`,
      amount: claim.rewardAmount,
      expiresAt,
    });
    memberCreditGrantId = grant.id;
  } else {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`credit_${claim.orgId}`}))`,
    );
    const [record] = await tx
      .insert(creditExpiresRecord)
      .values({
        orgId: claim.orgId,
        source: "get_started_reward",
        amount: claim.rewardAmount,
        remaining: claim.rewardAmount,
        expiresAt,
        createdAt: grantedAt,
      })
      .returning({ id: creditExpiresRecord.id });
    if (!record) {
      throw new Error("Get started organization credit was not persisted");
    }
    orgCreditRecordId = record.id;
    await grantOrgCredits(tx, claim.orgId, claim.rewardAmount);
  }
  const [granted] = await tx
    .update(getStartedClaims)
    .set({
      status: "granted",
      rewardKey,
      rewardSlot:
        claim.questKey === "invite"
          ? awards.total + 1
          : claim.questKey === "workflow" || claim.questKey === "share"
            ? 1
            : null,
      memberCreditGrantId,
      orgCreditRecordId,
      grantedAt,
      expiresAt,
      ...(evidenceText === undefined
        ? {}
        : { evidenceText, reviewedAt: grantedAt }),
      completedAt: claim.completedAt ?? grantedAt,
      updatedAt: grantedAt,
      reason: null,
      leaseId: null,
      leaseExpiresAt: null,
    })
    .where(eq(getStartedClaims.id, claim.id))
    .returning();
  if (!granted) {
    throw new Error("Get started grant was not committed");
  }
  return granted;
}

function requiredBeneficiary(claim: GetStartedClaimRow): string {
  if (!claim.beneficiaryUserId) {
    throw new Error("Personal reward has no beneficiary");
  }
  return claim.beneficiaryUserId;
}

export async function awardCompletedGetStartedQuest(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly questKey: "connector" | "slack" | "checkin";
    readonly sourceKey: string;
  },
): Promise<GetStartedClaimRow | null> {
  const claim = await createGetStartedClaim(tx, {
    ...args,
    completedAt: nowDate(),
  });
  if (!claim) {
    return null;
  }
  const rewardKey =
    args.questKey === "slack"
      ? `slack:${args.sourceKey}`
      : `${args.questKey}:${args.userId}:${args.sourceKey}`;
  return grantGetStartedClaim(tx, claim, rewardKey);
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
    quests,
    shareClaim: share ? getStartedClaimResponse(share) : null,
    recentGrants: recent.map(getStartedClaimResponse),
  };
}
