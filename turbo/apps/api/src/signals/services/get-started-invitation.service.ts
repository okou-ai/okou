import { randomUUID } from "node:crypto";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { usagePackInvitationPurchases } from "@okouai/db/schema/usage-pack-subscription";
import { and, eq, or } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  createGetStartedClaim,
  getStartedRewardsEnabled,
  grantGetStartedClaim,
  type GetStartedClaimRow,
} from "./get-started-rewards.service";

export function prepareGetStartedInvitation(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly purchaseId?: string;
  },
) {
  return db.transaction((tx) => {
    return createGetStartedClaim(tx, {
      ...args,
      questKey: "invite",
      sourceKey: args.purchaseId ? `purchase:${args.purchaseId}` : randomUUID(),
    });
  });
}

export async function linkGetStartedInvitation(
  db: Db,
  claimId: string,
  invitationId: string,
): Promise<void> {
  await db
    .update(getStartedClaims)
    .set({ invitationId, updatedAt: nowDate() })
    .where(eq(getStartedClaims.id, claimId));
}

export async function revokeGetStartedInvitation(
  db: Db,
  args: { readonly orgId: string; readonly invitationId: string },
): Promise<void> {
  await db
    .update(getStartedClaims)
    .set({
      status: "ineligible",
      reason: "invitation_revoked",
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(getStartedClaims.orgId, args.orgId),
        eq(getStartedClaims.invitationId, args.invitationId),
        eq(getStartedClaims.questKey, "invite"),
        eq(getStartedClaims.status, "pending"),
      ),
    );
}

/** Awaited by signed Clerk webhooks: a failed transaction remains retryable by Clerk. */
export async function acceptGetStartedInvitation(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly acceptedAt: Date;
    readonly invitationId?: string;
    readonly getStartedClaimId?: string;
    readonly purchaseId?: string;
  },
): Promise<void> {
  if (!args.invitationId && !args.getStartedClaimId && !args.purchaseId) {
    return;
  }
  await db.transaction(async (tx) => {
    const [existingClaim] = await tx
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
          // A purchase-only membership event must resolve its specific purchase below.
          args.invitationId || args.getStartedClaimId
            ? undefined
            : eq(getStartedClaims.sourceKey, `purchase:${args.purchaseId}`),
        ),
      )
      .limit(1);
    let claim: GetStartedClaimRow | undefined = existingClaim;
    if (!claim) {
      if (!args.purchaseId && !args.invitationId) {
        return;
      }
      const [purchase] = await tx
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
        .limit(1);
      if (!purchase) {
        return;
      }
      const created = await createGetStartedClaim(tx, {
        orgId: args.orgId,
        userId: purchase.inviterUserId,
        questKey: "invite",
        sourceKey: `purchase:${purchase.id}`,
        invitationId: purchase.invitationId ?? args.invitationId,
      });
      if (!created) {
        return;
      }
      claim = created;
    }
    if (["granted", "ineligible"].includes(claim.status)) {
      return;
    }
    if (!(await getStartedRewardsEnabled(tx, claim.orgId, claim.actorUserId))) {
      return;
    }
    if (
      claim.invitationId &&
      args.invitationId &&
      claim.invitationId !== args.invitationId
    ) {
      throw new Error("Invitation reward identity mismatch");
    }
    if (claim.beneficiaryUserId === args.userId) {
      await tx
        .update(getStartedClaims)
        .set({
          status: "ineligible",
          reason: "self_invitation",
          updatedAt: nowDate(),
        })
        .where(eq(getStartedClaims.id, claim.id));
      return;
    }
    // The shared grant service serializes inviter slots and invited-account uniqueness.
    const granted = await grantGetStartedClaim(
      tx,
      claim,
      `invite:${args.userId}`,
    );
    await tx
      .update(getStartedClaims)
      .set({
        invitationId: args.invitationId ?? claim.invitationId,
        inviteeUserId: args.userId,
        completedAt: args.acceptedAt,
        updatedAt: nowDate(),
      })
      .where(eq(getStartedClaims.id, granted.id));
  });
}
