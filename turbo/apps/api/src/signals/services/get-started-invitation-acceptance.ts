import { GET_STARTED_REWARDS } from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { usagePackInvitationPurchases } from "@okouai/db/schema/usage-pack-subscription";
import { and, eq, or } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

export interface AcceptedGetStartedInvitation {
  readonly orgId: string;
  readonly userId: string;
  readonly acceptedAt: Date;
  readonly invitationId?: string;
  readonly getStartedClaimId?: string;
  readonly purchaseId?: string;
}

/**
 * Plain read. Every transition the acceptance then makes on this claim is
 * conditional on it still being unresolved under the observed lease
 * (unresolvedClaimWhere); a zero-row transition means another redeemer won,
 * and its committed transition is the acceptance's deterministic outcome.
 */
export function acceptedInvitationClaimQuery(
  args: AcceptedGetStartedInvitation,
) {
  return new QueryBuilder()
    .select()
    .from(getStartedClaims)
    .where(
      and(
        eq(getStartedClaims.orgId, args.orgId),
        eq(getStartedClaims.questKey, "invite"),
        or(
          args.getStartedClaimId
            ? eq(getStartedClaims.id, args.getStartedClaimId)
            : undefined,
          args.invitationId
            ? eq(getStartedClaims.invitationId, args.invitationId)
            : undefined,
        ),
        args.invitationId || args.getStartedClaimId
          ? undefined
          : eq(getStartedClaims.sourceKey, `purchase:${args.purchaseId}`),
      ),
    )
    .limit(1)
    .as("accepted_invitation_claim");
}

export function acceptedInvitationPurchaseQuery(
  args: AcceptedGetStartedInvitation,
) {
  return new QueryBuilder()
    .select({
      id: usagePackInvitationPurchases.id,
      inviterUserId: usagePackInvitationPurchases.inviterUserId,
      invitationId: usagePackInvitationPurchases.clerkInvitationId,
    })
    .from(usagePackInvitationPurchases)
    .where(
      and(
        eq(usagePackInvitationPurchases.orgId, args.orgId),
        or(
          args.purchaseId
            ? eq(usagePackInvitationPurchases.id, args.purchaseId)
            : undefined,
          args.invitationId
            ? eq(
                usagePackInvitationPurchases.clerkInvitationId,
                args.invitationId,
              )
            : undefined,
        ),
      ),
    )
    .limit(1)
    .as("accepted_invitation_purchase");
}

export function acceptedInvitationClaimValues(
  args: AcceptedGetStartedInvitation,
  purchase: {
    readonly id: string;
    readonly inviterUserId: string;
    readonly invitationId: string | null;
  },
  at: Date,
) {
  return {
    orgId: args.orgId,
    actorUserId: purchase.inviterUserId,
    beneficiaryUserId: purchase.inviterUserId,
    questKey: "invite" as const,
    sourceKey: `purchase:${purchase.id}`,
    rewardAmount: GET_STARTED_REWARDS.invite.amount,
    rewardTarget: "user" as const,
    invitationId: purchase.invitationId ?? args.invitationId,
    nextAttemptAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

export function invitationAcceptanceValues(
  args: AcceptedGetStartedInvitation,
  invitationId: string | null,
  at: Date,
) {
  return {
    invitationId: args.invitationId ?? invitationId,
    inviteeUserId: args.userId,
    completedAt: args.acceptedAt,
    updatedAt: at,
  };
}

export function invitationClaimConflict(sourceKey: string) {
  return {
    target: [
      getStartedClaims.actorUserId,
      getStartedClaims.questKey,
      getStartedClaims.sourceKey,
    ],
    set: { sourceKey },
  };
}

export function requireInvitationRewardIdentity(
  args: AcceptedGetStartedInvitation,
  claim: { readonly invitationId: string | null },
) {
  if (
    claim.invitationId &&
    args.invitationId &&
    claim.invitationId !== args.invitationId
  ) {
    throw new Error("Invitation reward identity mismatch");
  }
}
