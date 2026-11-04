import { GET_STARTED_REWARD_TTL_MS } from "@okouai/api-contracts/contracts/get-started";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { ensureGetStartedRewardWallet$ } from "./get-started-wallet.service";
import { expireOrgCredits$ } from "./org-credit-expiration.service";
import {
  pendingOrgCreditExpirationQuery,
  requireNoPendingOrgCreditExpiration,
} from "./org-credit-expiration";
import {
  slackRewardGrantFailureReason,
  slackRewardIdentity,
  slackRewardIneligibleValues,
  slackRewardUnavailableReason,
  unsettledSlackClaim,
} from "./slack-installation-reward";

type Claim = typeof getStartedClaims.$inferSelect;

const commitSlackReward$ = command(
  async ({ set }, claim: Claim, signal: AbortSignal) => {
    const at = nowDate();
    const recordId = randomUUID();
    const expiresAt = new Date(at.getTime() + GET_STARTED_REWARD_TTL_MS);
    // eslint-disable-next-line api/no-db-transaction -- Billing atomicity: the unique reward receipt, credit lot and wallet increment must roll back together when the wallet is absent or a fresh expiration check rejects; single-statement alternative: the post-wallet-wait expiration snapshot and rejected wallet publication require precommit whole-operation rollback.
    await set(writeDb$).transaction(async (tx) => {
      const [claimed] = await tx
        .update(getStartedClaims)
        .set({
          status: "granted",
          rewardKey: `slack:${claim.sourceKey}`,
          rewardSlot: null,
          orgCreditRecordId: recordId,
          grantedAt: at,
          expiresAt,
          reason: null,
          leaseId: null,
          leaseExpiresAt: null,
          updatedAt: at,
        })
        .where(
          and(
            eq(getStartedClaims.orgId, claim.orgId),
            unsettledSlackClaim(claim.id),
          ),
        )
        .returning({ id: getStartedClaims.id });
      signal.throwIfAborted();
      if (!claimed) {
        return;
      }
      await tx.insert(creditExpiresRecord).values({
        id: recordId,
        orgId: claim.orgId,
        source: "get_started_reward",
        amount: claim.rewardAmount,
        remaining: claim.rewardAmount,
        expiresAt,
        createdAt: at,
      });
      signal.throwIfAborted();
      const [wallet] = await tx
        .update(orgMetadata)
        .set({
          credits: sql`${orgMetadata.credits} + ${claim.rewardAmount}`,
          updatedAt: at,
        })
        .where(eq(orgMetadata.orgId, claim.orgId))
        .returning({ orgId: orgMetadata.orgId });
      signal.throwIfAborted();
      if (!wallet) {
        throw new Error("Slack reward wallet disappeared before publication");
      }
      const [pending] = await tx
        .select()
        .from(pendingOrgCreditExpirationQuery(claim.orgId, at));
      signal.throwIfAborted();
      requireNoPendingOrgCreditExpiration(claim.orgId, pending);
    });
    signal.throwIfAborted();
  },
);

const settleSlackReward$ = command(
  async ({ set }, claim: Claim, signal: AbortSignal): Promise<void> => {
    await set(ensureGetStartedRewardWallet$, claim.orgId, signal);
    await set(expireOrgCredits$, claim.orgId, signal);
    const db = set(writeDb$);
    const reward = slackRewardIdentity(
      claim.orgId,
      claim.actorUserId,
      claim.sourceKey,
      nowDate(),
    );
    const awards = await db
      .select({ rewardKey: getStartedClaims.rewardKey })
      .from(getStartedClaims)
      .where(reward.awardsWhere)
      .limit(2);
    signal.throwIfAborted();
    let reason = slackRewardUnavailableReason(reward.rewardKey, awards);
    if (!reason) {
      const result = await settle(set(commitSlackReward$, claim, signal));
      signal.throwIfAborted();
      reason = slackRewardGrantFailureReason(result);
    }
    if (reason) {
      await db
        .update(getStartedClaims)
        .set(slackRewardIneligibleValues(reason, nowDate()))
        .where(unsettledSlackClaim(claim.id));
      signal.throwIfAborted();
    }
  },
);

/** Both OAuth redelivery and the existing claims worker resume durable receipts. */
export const settleSlackWorkspaceRewards$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly workspaceId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const claims = await set(writeDb$)
      .select()
      .from(getStartedClaims)
      .where(
        and(
          eq(getStartedClaims.questKey, "slack"),
          eq(getStartedClaims.orgId, args.orgId),
          eq(getStartedClaims.sourceKey, args.workspaceId),
          inArray(getStartedClaims.status, ["pending", "reviewing"]),
        ),
      )
      .orderBy(getStartedClaims.createdAt, getStartedClaims.id)
      .limit(10);
    signal.throwIfAborted();
    for (const claim of claims) {
      await set(settleSlackReward$, claim, signal);
    }
  },
);

export const processPendingSlackRewards$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const claims = await set(writeDb$)
      .select()
      .from(getStartedClaims)
      .where(
        and(
          eq(getStartedClaims.questKey, "slack"),
          inArray(getStartedClaims.status, ["pending", "reviewing"]),
        ),
      )
      .orderBy(getStartedClaims.nextAttemptAt, getStartedClaims.id)
      .limit(10);
    signal.throwIfAborted();
    for (const claim of claims) {
      await set(settleSlackReward$, claim, signal);
    }
    return claims.length;
  },
);
