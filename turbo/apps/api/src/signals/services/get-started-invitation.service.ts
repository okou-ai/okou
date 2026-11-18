import { randomUUID } from "node:crypto";
import { GET_STARTED_REWARDS } from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { marketingRewardInvitationEventInsert } from "./marketing-reward-event-publication";

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
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const at = nowDate();
    const marketingRewardEventId = randomUUID();
    const linked = db
      .update(getStartedClaims)
      .set({ invitationId, updatedAt: at })
      .where(
        and(
          eq(getStartedClaims.id, claimId),
          eq(getStartedClaims.questKey, "invite"),
        ),
      )
      .returning();
    const { rowCount } = await db.execute(
      sql`WITH linked_invitation AS (${linked.getSQL()}) ${marketingRewardInvitationEventInsert(
        {
          id: marketingRewardEventId,
          environment: env("ENV"),
          type: "invitation.attributed",
          occurredAt: at.toISOString(),
        },
        sql`SELECT * FROM linked_invitation`,
      )}`,
    );
    signal.throwIfAborted();
    return rowCount === 1 ? marketingRewardEventId : undefined;
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
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const at = nowDate();
    const marketingRewardEventId = randomUUID();
    const revoked = db
      .update(getStartedClaims)
      .set({
        status: "ineligible",
        reason: "invitation_revoked",
        updatedAt: at,
      })
      .where(
        and(
          eq(getStartedClaims.orgId, args.orgId),
          eq(getStartedClaims.invitationId, args.invitationId),
          eq(getStartedClaims.questKey, "invite"),
          eq(getStartedClaims.status, "pending"),
        ),
      )
      .returning();
    const { rowCount } = await db.execute(
      sql`WITH revoked_invitation AS (${revoked.getSQL()}) ${marketingRewardInvitationEventInsert(
        {
          id: marketingRewardEventId,
          environment: env("ENV"),
          type: "invitation.revoked",
          occurredAt: at.toISOString(),
        },
        sql`SELECT * FROM revoked_invitation`,
      )}`,
    );
    signal.throwIfAborted();
    return rowCount === 1 ? marketingRewardEventId : undefined;
  },
);
