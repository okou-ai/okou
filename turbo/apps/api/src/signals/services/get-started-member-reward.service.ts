import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
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
  memberRewardWalletQuery,
  getStartedRewardAvailabilityQuery,
  getStartedMemberRewardSql,
} from "./get-started-member-reward";
import {
  slackRewardWalletEntitlement,
  slackRewardIneligibleValues,
} from "./slack-installation-reward";

/** No grant becomes visible without the wallet owner used by settlement. */
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
    // Fifteen inviter slots plus one final observation after all slots fill.
    for (let attempt = 0; attempt < 16; attempt++) {
      const result = await settle(
        db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(orgMetadataCanonicalWrites)
            .values({ orgId: args.claim.orgId })
            .onConflictDoNothing()
            .returning({ orgId: orgMetadata.orgId });
          await tx.select().from(memberRewardWalletQuery(args.claim.orgId));
          if (inserted) {
            await tx
              .insert(orgPlanEntitlements)
              .values(slackRewardWalletEntitlement(args.claim.orgId))
              .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
          }
          const [claim] = await tx
            .select()
            .from(getStartedClaims)
            .where(
              and(
                eq(getStartedClaims.id, args.claim.id),
                eq(getStartedClaims.orgId, args.claim.orgId),
              ),
            )
            .for("update");
          if (!claim) {
            throw new Error("Get started claim disappeared before redemption");
          }
          if (
            (args.claim.leaseId !== null &&
              claim.leaseId !== args.claim.leaseId) ||
            ["granted", "ineligible", "rejected"].includes(claim.status)
          ) {
            return claim;
          }
          const awards = await tx
            .select()
            .from(getStartedRewardAvailabilityQuery(claim, args.rewardKey));
          const availability = getRewardAvailabilityFromAwards(
            claim,
            args.rewardKey,
            awards,
          );
          if (availability.kind === "ineligible") {
            const [ineligible] = await tx
              .update(getStartedClaims)
              .set(slackRewardIneligibleValues(availability.reason, nowDate()))
              .where(eq(getStartedClaims.id, claim.id))
              .returning();
            if (!ineligible) {
              throw new Error(
                "Get started claim disappeared during redemption",
              );
            }
            return ineligible;
          }
          const slot = availability.slots[0];
          if (slot === undefined) {
            throw new Error("Get started reward has no available slot");
          }
          const granted = (
            await tx.execute(
              getStartedMemberRewardSql(
                claim,
                args.rewardKey,
                slot,
                args.evidenceText,
                nowDate(),
              ),
            )
          ).rowCount;
          if (granted !== 1) {
            throw new Error("Get started grant was not committed");
          }
          const [current] = await tx
            .select()
            .from(getStartedClaims)
            .where(eq(getStartedClaims.id, claim.id));
          if (!current) {
            throw new Error("Get started granted claim disappeared");
          }
          signal.throwIfAborted();
          return current;
        }),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok) {
        return result.value;
      }
      if (
        !isUniqueViolation(result.error, "uq_get_started_reward_key") &&
        !isUniqueViolation(result.error, "uq_get_started_reward_slot")
      ) {
        throw result.error;
      }
    }
    throw new Error(
      "Get started reward did not converge within its available slots",
    );
  },
);
