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
import { and, count, desc, eq, like, or, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { settle } from "../utils";
import { createUsagePackCreditGrant } from "./usage-pack-credit.service";
import { grantOrgCredits } from "./onboarding-credit-grants.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

export type GetStartedClaimRow = typeof getStartedClaims.$inferSelect;

/**
 * Every custom connector a user connects shares this one connector-quest
 * source. Custom connector identity is user-controlled (any user can create,
 * delete, and recreate connectors with the same credentials), so a per-connector
 * source would let one user farm the reward without limit.
 */
export const CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY = "custom";

// Before CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY, custom connector claims used
// `custom:<connectorId>`. A granted legacy claim still uses up the shared one.
const LEGACY_CUSTOM_CONNECTOR_SOURCE_PATTERN = `${CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY}:%`;

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
  const availability = await getRewardAvailability(tx, claim, rewardKey);
  if (availability.kind === "ineligible") {
    return markIneligible(tx, claim.id, availability.reason);
  }
  if (claim.questKey === "connector" || claim.questKey === "checkin") {
    // These exact identities already select one claim through
    // uq_get_started_claim_source, so its row lock owns the whole grant.
    return persistGetStartedGrant(tx, claim, rewardKey, null, evidenceText);
  }

  // Invitations have 15 slots shared across organizations. Granted claims keep
  // their slots after expiry or source deletion. Each candidate is attempted
  // once; a conflict consumes that slot, not the other available slots.
  // Never retry other database failures.
  for (const rewardSlot of availability.slots) {
    const granted = await settle(
      tx.transaction((grantTx) => {
        return persistGetStartedGrant(
          grantTx,
          claim,
          rewardKey,
          rewardSlot,
          evidenceText,
        );
      }),
    );
    if (granted.ok) {
      return granted.value;
    }
    const error = granted.error;
    if (
      !isUniqueViolation(error, "uq_get_started_reward_key") &&
      !isUniqueViolation(error, "uq_get_started_reward_slot") &&
      !isUniqueViolation(error, "uq_get_started_slack_org")
    ) {
      throw error;
    }

    // The savepoint has rolled back both credits and the claim update. Check
    // the reward identity first even when PostgreSQL reports the slot index.
    const current = await getRewardAvailability(tx, claim, rewardKey);
    if (current.kind === "ineligible") {
      return markIneligible(tx, claim.id, current.reason);
    }
    if (
      claim.questKey !== "invite" ||
      !isUniqueViolation(error, "uq_get_started_reward_slot") ||
      current.slots.includes(rewardSlot)
    ) {
      throw error;
    }
  }
  throw new Error("Get started invitation conflicts did not exhaust its slots");
}

type RewardAvailability =
  | {
      readonly kind: "ineligible";
      readonly reason: "already_redeemed" | "limit_reached";
    }
  | { readonly kind: "available"; readonly slots: readonly (number | null)[] };

async function getRewardAvailability(
  tx: Tx,
  claim: GetStartedClaimRow,
  rewardKey: string,
): Promise<RewardAvailability> {
  const limit = GET_STARTED_REWARDS[claim.questKey].limit;
  const ownerAwards =
    limit === null
      ? undefined
      : and(
          claim.rewardTarget === "org"
            ? eq(getStartedClaims.orgId, claim.orgId)
            : eq(
                getStartedClaims.beneficiaryUserId,
                requiredBeneficiary(claim),
              ),
          eq(getStartedClaims.questKey, claim.questKey),
          eq(getStartedClaims.status, "granted"),
        );
  const legacyCustomConnectorAwards =
    claim.questKey === "connector" &&
    claim.sourceKey === CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY
      ? and(
          eq(getStartedClaims.beneficiaryUserId, requiredBeneficiary(claim)),
          eq(getStartedClaims.questKey, "connector"),
          eq(getStartedClaims.status, "granted"),
          like(
            getStartedClaims.sourceKey,
            LEGACY_CUSTOM_CONNECTOR_SOURCE_PATTERN,
          ),
        )
      : undefined;
  // Read identity and capacity from the same snapshot so a concurrent grant
  // cannot appear only in the capacity check and hide already_redeemed.
  const awards = await tx
    .select({
      rewardKey: getStartedClaims.rewardKey,
      rewardSlot: getStartedClaims.rewardSlot,
      questKey: getStartedClaims.questKey,
      sourceKey: getStartedClaims.sourceKey,
      status: getStartedClaims.status,
    })
    .from(getStartedClaims)
    .where(
      or(
        eq(getStartedClaims.rewardKey, rewardKey),
        ownerAwards,
        legacyCustomConnectorAwards,
      ),
    );
  if (
    awards.some((award) => {
      return (
        award.rewardKey === rewardKey ||
        (legacyCustomConnectorAwards !== undefined &&
          award.questKey === "connector" &&
          award.status === "granted" &&
          award.sourceKey.startsWith(
            `${CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY}:`,
          ))
      );
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

async function persistGetStartedGrant(
  tx: Tx,
  claim: GetStartedClaimRow,
  rewardKey: string,
  rewardSlot: number | null,
  evidenceText: string | undefined,
): Promise<GetStartedClaimRow> {
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
      rewardSlot,
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
    readonly questKey: "connector" | "slack" | "imessage" | "checkin";
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
