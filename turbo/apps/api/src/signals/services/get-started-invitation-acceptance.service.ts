import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { getRewardAvailabilityFromAwards } from "./get-started-rewards.service";
import {
  getStartedMemberRewardSql,
  getStartedRewardAvailabilityQuery,
  memberRewardWalletQuery,
  unresolvedClaimWhere,
} from "./get-started-member-reward";
import {
  slackRewardIneligibleValues,
  slackRewardWalletEntitlement,
} from "./slack-installation-reward";
import {
  acceptedInvitationClaimQuery,
  acceptedInvitationPurchaseQuery,
  acceptedInvitationClaimValues,
  invitationClaimConflict,
  invitationAcceptanceValues,
  InvitationClaimTransitionLost,
  requireInvitationClaimTransition,
  requireInvitationRewardIdentity,
  type AcceptedGetStartedInvitation,
} from "./get-started-invitation-acceptance";

export class InvitationRewardSlotConflict extends Error {
  constructor(readonly orgId: string) {
    super(`Invitation reward for organization ${orgId} lost a concurrent slot`);
    this.name = "InvitationRewardSlotConflict";
  }
}

/** Signed acceptance, its durable claim and bonus all commit under one wallet owner. */
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
    const result = await settle(
      db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(orgMetadataCanonicalWrites)
          .values({ orgId: args.orgId })
          .onConflictDoNothing()
          .returning({ orgId: orgMetadata.orgId });
        await tx.select().from(memberRewardWalletQuery(args.orgId));
        if (inserted) {
          await tx
            .insert(orgPlanEntitlements)
            .values(slackRewardWalletEntitlement(args.orgId))
            .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
        }
        let [claim] = await tx
          .select()
          .from(acceptedInvitationClaimQuery(args));
        if (!claim) {
          if (!args.purchaseId && !args.invitationId) {
            return;
          }
          const [purchase] = await tx
            .select()
            .from(acceptedInvitationPurchaseQuery(args));
          if (!purchase) {
            return;
          }
          const values = acceptedInvitationClaimValues(
            args,
            purchase,
            nowDate(),
          );
          [claim] = await tx
            .insert(getStartedClaims)
            .values(values)
            .onConflictDoUpdate(invitationClaimConflict(values.sourceKey))
            .returning();
        }
        if (!claim) {
          throw new Error("Invitation reward claim was not persisted");
        }
        if (["granted", "ineligible", "rejected"].includes(claim.status)) {
          return;
        }
        requireInvitationRewardIdentity(args, claim);
        const at = nowDate();
        if (claim.beneficiaryUserId === args.userId) {
          const ineligible = await tx
            .update(getStartedClaims)
            .set(slackRewardIneligibleValues("self_invitation", at))
            .where(unresolvedClaimWhere(claim))
            .returning({ id: getStartedClaims.id });
          requireInvitationClaimTransition(claim.id, ineligible.length);
          return;
        }
        const rewardKey = `invite:${args.userId}`;
        const awards = await tx
          .select()
          .from(getStartedRewardAvailabilityQuery(claim, rewardKey));
        const availability = getRewardAvailabilityFromAwards(
          claim,
          rewardKey,
          awards,
        );
        if (availability.kind === "ineligible") {
          const ineligible = await tx
            .update(getStartedClaims)
            .set({
              ...slackRewardIneligibleValues(availability.reason, at),
              ...invitationAcceptanceValues(args, claim.invitationId, at),
            })
            .where(unresolvedClaimWhere(claim))
            .returning({ id: getStartedClaims.id });
          requireInvitationClaimTransition(claim.id, ineligible.length);
          return;
        }
        const slot = availability.slots[0];
        if (slot === undefined) {
          throw new Error("Invitation reward has no available slot");
        }
        // Conditional on the unresolved claim and its observed lease; the
        // grant row exists only if that transition happened.
        requireInvitationClaimTransition(
          claim.id,
          (
            await tx.execute(
              getStartedMemberRewardSql(claim, rewardKey, slot, undefined, at),
            )
          ).rowCount,
        );
        // The claim is now owned by this transaction's own transition.
        await tx
          .update(getStartedClaims)
          .set(invitationAcceptanceValues(args, claim.invitationId, at))
          .where(eq(getStartedClaims.id, claim.id));
        signal.throwIfAborted();
      }),
      signal,
    );
    signal.throwIfAborted();
    if (result.ok || result.error instanceof InvitationClaimTransitionLost) {
      // Another redeemer resolved or leased this claim after our read; its
      // committed transition is the deterministic outcome.
      return;
    }
    if (
      isUniqueViolation(result.error, "uq_get_started_reward_key") ||
      isUniqueViolation(result.error, "uq_get_started_reward_slot")
    ) {
      // A concurrent grant took this reward identity or inviter slot. The
      // whole acceptance rolled back and the claim stays unresolved; report a
      // deterministic conflict so the Clerk redelivery / membership recovery
      // cycle decides again, never an in-place re-read.
      throw new InvitationRewardSlotConflict(args.orgId);
    }
    throw result.error;
  },
);
