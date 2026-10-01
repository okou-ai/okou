import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  type GetStartedClaimRow,
  getRewardAvailabilityFromAwards,
} from "./get-started-rewards.service";
import {
  getStartedMemberRewardSql,
  getStartedRewardAvailabilityQuery,
  unresolvedClaimWhere,
} from "./get-started-member-reward";
import { slackRewardIneligibleValues } from "./slack-installation-reward";
import { ensureGetStartedRewardWallet$ } from "./get-started-wallet.service";
import {
  acceptedInvitationClaimQuery,
  acceptedInvitationPurchaseQuery,
  acceptedInvitationClaimValues,
  invitationClaimConflict,
  invitationAcceptanceValues,
  requireInvitationRewardIdentity,
  type AcceptedGetStartedInvitation,
} from "./get-started-invitation-acceptance";

export class InvitationRewardSlotConflict extends Error {
  constructor(readonly orgId: string) {
    super(`Invitation reward for organization ${orgId} lost a concurrent slot`);
    this.name = "InvitationRewardSlotConflict";
  }
}

const publishAcceptedReward$ = command(
  async (
    { set },
    plan: {
      readonly claim: GetStartedClaimRow;
      readonly rewardKey: string;
      readonly slot: number | null;
      readonly at: Date;
      readonly acceptance: ReturnType<typeof invitationAcceptanceValues>;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { rowCount } = await db.execute(
      getStartedMemberRewardSql(
        plan.claim,
        plan.rewardKey,
        plan.slot,
        undefined,
        plan.at,
        plan.acceptance,
      ),
    );
    signal.throwIfAborted();
    return rowCount;
  },
);

/** Signed acceptance and its bonus publish through one fenced claim transition. */
export const acceptGetStartedInvitation$ = command(
  async (
    { set },
    args: AcceptedGetStartedInvitation,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.invitationId && !args.getStartedClaimId && !args.purchaseId) {
      return;
    }
    const db = set(writeDb$);
    await set(ensureGetStartedRewardWallet$, args.orgId, signal);
    let [claim] = await db.select().from(acceptedInvitationClaimQuery(args));
    signal.throwIfAborted();
    if (!claim) {
      if (!args.purchaseId && !args.invitationId) {
        return;
      }
      const [purchase] = await db
        .select()
        .from(acceptedInvitationPurchaseQuery(args));
      signal.throwIfAborted();
      if (!purchase) {
        return;
      }
      const values = acceptedInvitationClaimValues(args, purchase, nowDate());
      // An interrupted acceptance may leave a pending claim. Signed redelivery
      // and existing membership recovery both rediscover this business identity.
      [claim] = await db
        .insert(getStartedClaims)
        .values(values)
        .onConflictDoUpdate(invitationClaimConflict(values.sourceKey))
        .returning();
      signal.throwIfAborted();
    }
    if (!claim) {
      throw new Error("Invitation reward claim was not persisted");
    }
    if (["granted", "ineligible", "rejected"].includes(claim.status)) {
      return;
    }
    requireInvitationRewardIdentity(args, claim);
    const at = nowDate();
    const acceptance = invitationAcceptanceValues(args, claim.invitationId, at);
    if (claim.beneficiaryUserId === args.userId) {
      await db
        .update(getStartedClaims)
        .set(slackRewardIneligibleValues("self_invitation", at))
        .where(unresolvedClaimWhere(claim));
      signal.throwIfAborted();
      return;
    }
    const rewardKey = `invite:${args.userId}`;
    const awards = await db
      .select()
      .from(getStartedRewardAvailabilityQuery(claim, rewardKey));
    signal.throwIfAborted();
    const availability = getRewardAvailabilityFromAwards(
      claim,
      rewardKey,
      awards,
    );
    if (availability.kind === "ineligible") {
      await db
        .update(getStartedClaims)
        .set({
          ...slackRewardIneligibleValues(availability.reason, at),
          ...acceptance,
        })
        .where(unresolvedClaimWhere(claim));
      signal.throwIfAborted();
      return;
    }
    const slot = availability.slots[0];
    if (slot === undefined) {
      throw new Error("Invitation reward has no available slot");
    }
    // Acceptance provenance belongs to the same UPDATE as the grant: a stale
    // delivery never changes the attribution of another redeemer's result.
    const result = await settle(
      set(
        publishAcceptedReward$,
        {
          claim,
          rewardKey,
          slot,
          at,
          acceptance,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (result.ok) {
      if (result.value !== 0 && result.value !== 1) {
        throw new Error("Invitation reward grant was not committed");
      }
      return;
    }
    if (
      isUniqueViolation(result.error, "uq_get_started_reward_key") ||
      isUniqueViolation(result.error, "uq_get_started_reward_slot")
    ) {
      // Only this grant statement rolled back. Signed redelivery and
      // membership recovery rediscover the durable pending claim, as in R1.
      throw new InvitationRewardSlotConflict(args.orgId);
    }
    throw result.error;
  },
);
