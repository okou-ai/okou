import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  getRewardAvailabilityFromAwards,
  type GetStartedClaimRow,
} from "./get-started-rewards.service";
import {
  getStartedRewardAvailabilityQuery,
  getStartedMemberRewardSql,
  unresolvedClaimWhere,
} from "./get-started-member-reward";
import { slackRewardIneligibleValues } from "./slack-installation-reward";
import { ensureGetStartedRewardWallet$ } from "./get-started-wallet.service";

const currentClaim$ = command(
  async (
    { set },
    id: string,
    signal: AbortSignal,
  ): Promise<GetStartedClaimRow> => {
    const db = set(writeDb$);
    const [current] = await db
      .select()
      .from(getStartedClaims)
      .where(eq(getStartedClaims.id, id));
    signal.throwIfAborted();
    if (!current) {
      throw new Error("Get started claim disappeared during redemption");
    }
    return current;
  },
);

const publishReward$ = command(
  async (
    { set },
    plan: {
      readonly claim: GetStartedClaimRow;
      readonly rewardKey: string;
      readonly slot: number | null;
      readonly evidenceText?: string;
      readonly at: Date;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { rowCount } = await db.execute(
      getStartedMemberRewardSql(
        plan.claim,
        plan.rewardKey,
        plan.slot,
        plan.evidenceText,
        plan.at,
      ),
    );
    signal.throwIfAborted();
    return rowCount;
  },
);

/** The observed claim transition and its member grant commit in one statement. */
export const grantGetStartedClaim$ = command(
  async (
    { set },
    args: {
      readonly claim: GetStartedClaimRow;
      readonly rewardKey: string;
      readonly evidenceText?: string;
    },
    signal: AbortSignal,
  ): Promise<GetStartedClaimRow> => {
    const db = set(writeDb$);
    await set(ensureGetStartedRewardWallet$, args.claim.orgId, signal);
    const [claim] = await db
      .select()
      .from(getStartedClaims)
      .where(
        and(
          eq(getStartedClaims.id, args.claim.id),
          eq(getStartedClaims.orgId, args.claim.orgId),
        ),
      );
    signal.throwIfAborted();
    if (!claim) {
      throw new Error("Get started claim disappeared before redemption");
    }
    if (
      claim.leaseId !== args.claim.leaseId ||
      ["granted", "ineligible", "rejected"].includes(claim.status)
    ) {
      return claim;
    }
    const awards = await db
      .select()
      .from(getStartedRewardAvailabilityQuery(claim, args.rewardKey));
    signal.throwIfAborted();
    const availability = getRewardAvailabilityFromAwards(
      claim,
      args.rewardKey,
      awards,
    );
    if (availability.kind === "ineligible") {
      const [ineligible] = await db
        .update(getStartedClaims)
        .set(slackRewardIneligibleValues(availability.reason, nowDate()))
        .where(unresolvedClaimWhere(claim))
        .returning();
      signal.throwIfAborted();
      return ineligible ?? (await set(currentClaim$, claim.id, signal));
    }
    const slot = availability.slots[0];
    if (slot === undefined) {
      throw new Error("Get started reward has no available slot");
    }
    const result = await settle(
      set(
        publishReward$,
        {
          claim,
          rewardKey: args.rewardKey,
          slot,
          evidenceText: args.evidenceText,
          at: nowDate(),
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (result.ok) {
      if (result.value !== 0 && result.value !== 1) {
        throw new Error("Get started grant was not committed");
      }
      return await set(currentClaim$, claim.id, signal);
    }
    if (
      !isUniqueViolation(result.error, "uq_get_started_reward_key") &&
      !isUniqueViolation(result.error, "uq_get_started_reward_slot")
    ) {
      throw result.error;
    }
    // Keep the original lease: a stale reviewer must never decline a replacement owner.
    const reason = isUniqueViolation(result.error, "uq_get_started_reward_key")
      ? "already_redeemed"
      : "limit_reached";
    const [ineligible] = await db
      .update(getStartedClaims)
      .set(slackRewardIneligibleValues(reason, nowDate()))
      .where(unresolvedClaimWhere(claim))
      .returning();
    signal.throwIfAborted();
    return ineligible ?? (await set(currentClaim$, claim.id, signal));
  },
);
