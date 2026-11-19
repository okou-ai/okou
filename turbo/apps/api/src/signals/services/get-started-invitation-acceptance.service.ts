import { randomUUID } from "node:crypto";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { GetStartedClaimRow } from "./get-started-rewards.service";
import { unresolvedClaimWhere } from "./get-started-member-reward";
import { ensureGetStartedRewardWallet$ } from "./get-started-wallet.service";
import { marketingRewardInvitationEventInsert } from "./marketing-reward-event-publication";
import {
  acceptedInvitationClaimQuery,
  acceptedInvitationPurchaseQuery,
  acceptedInvitationClaimValues,
  invitationClaimConflict,
  invitationAcceptanceValues,
  requireInvitationRewardIdentity,
  type AcceptedGetStartedInvitation,
} from "./get-started-invitation-acceptance";

const publishUnfundedAcceptance$ = command(
  async (
    { set },
    args: {
      readonly claim: GetStartedClaimRow;
      readonly acceptance: ReturnType<typeof invitationAcceptanceValues>;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const marketingRewardEventId = randomUUID();
    const accepted = db
      .update(getStartedClaims)
      .set({
        reason: null,
        ...args.acceptance,
      })
      .where(unresolvedClaimWhere(args.claim))
      .returning();
    const { rowCount } = await db.execute(
      sql`WITH accepted_invitation AS (${accepted.getSQL()}) ${marketingRewardInvitationEventInsert(
        {
          id: marketingRewardEventId,
          environment: env("ENV"),
          type: "invitation.accepted",
          occurredAt: args.acceptance.completedAt.toISOString(),
        },
        sql`SELECT * FROM accepted_invitation`,
      )}`,
    );
    signal.throwIfAborted();
    return rowCount === 1 ? marketingRewardEventId : undefined;
  },
);

/** Signed acceptance and its source fact publish through one fenced claim transition. */
export const acceptGetStartedInvitation$ = command(
  async (
    { set },
    args: AcceptedGetStartedInvitation,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
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
    if (!claim.beneficiaryUserId) {
      throw new Error("Invitation reward has no original inviter");
    }
    return await set(publishUnfundedAcceptance$, { claim, acceptance }, signal);
  },
);
