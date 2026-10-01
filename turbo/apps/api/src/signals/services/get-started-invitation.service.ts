import { randomUUID } from "node:crypto";
import { GET_STARTED_REWARDS } from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

export const prepareGetStartedInvitation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly purchaseId?: string;
    },
    signal?: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const sourceKey = args.purchaseId
      ? `purchase:${args.purchaseId}`
      : randomUUID();
    const at = nowDate();
    const reward = GET_STARTED_REWARDS.invite;
    const [claim] = await db
      .insert(getStartedClaims)
      .values({
        orgId: args.orgId,
        actorUserId: args.userId,
        beneficiaryUserId: args.userId,
        questKey: "invite",
        sourceKey,
        rewardAmount: reward.amount,
        rewardTarget: reward.target,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [
          getStartedClaims.actorUserId,
          getStartedClaims.questKey,
          getStartedClaims.sourceKey,
        ],
        set: { sourceKey },
        setWhere: eq(getStartedClaims.orgId, args.orgId),
      })
      .returning();
    signal?.throwIfAborted();
    if (!claim) {
      throw new Error(
        "Invitation reward claim belongs to another organization",
      );
    }
    return claim;
  },
);

export const linkGetStartedInvitation$ = command(
  async (
    { set },
    claimId: string,
    invitationId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    await db
      .update(getStartedClaims)
      .set({ invitationId, updatedAt: nowDate() })
      .where(eq(getStartedClaims.id, claimId));
  },
);

export const invalidateGetStartedInvitationClaim$ = command(
  async (
    { set },
    args: {
      readonly claimId: string;
      readonly reason: "invitation_create_failed" | "invitee_unavailable";
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    await db
      .update(getStartedClaims)
      .set({ status: "ineligible", reason: args.reason, updatedAt: nowDate() })
      .where(
        and(
          eq(getStartedClaims.id, args.claimId),
          eq(getStartedClaims.questKey, "invite"),
          eq(getStartedClaims.status, "pending"),
        ),
      );
  },
);

export const revokeGetStartedInvitation$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly invitationId: string },
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
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
  },
);
