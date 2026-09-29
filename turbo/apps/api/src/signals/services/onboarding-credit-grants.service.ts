import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";

import { settle } from "../utils";
import {
  OrgCreditExpirationRequired,
  pendingOrgCreditExpirationQuery,
  requireNoPendingOrgCreditExpiration,
} from "./org-credit-expiration";
import { expireOrgCredits$ } from "./org-credit-expiration.service";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";

const LIMITED_FREE_ONBOARDING_CREDITS = 1000;

const ONBOARDING_CREDIT_SOURCE = "onboarding";
const ONBOARDING_CREDIT_IDEMPOTENCY_KEY = "limited-free-onboarding";
const ONBOARDING_CREDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function onboardingCreditsExpiresAt(grantedAt: Date): Date {
  return new Date(grantedAt.getTime() + ONBOARDING_CREDIT_TTL_MS);
}

/** The grant identity and its balance change commit together before publication. */
const commitOnboardingCredits$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({ orgId })
        .onConflictDoNothing()
        .returning({ orgId: orgMetadata.orgId });
      const [metadata] = await tx
        .select({
          tier: orgMetadata.tier,
          defaultAgentId: orgMetadata.defaultAgentId,
        })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .for("update");
      if (!metadata) {
        throw new Error(
          "Organization disappeared before onboarding credit grant",
        );
      }
      if (inserted) {
        await tx
          .insert(orgPlanEntitlements)
          .values(
            orgPlanEntitlementValues(
              {
                orgId,
                tier: "limited-free-1",
                source: "org_metadata_bootstrap",
              },
              { stripeSubscriptionId: null, sourceMetadata: {} },
            ),
          )
          .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
      }
      if (
        metadata.defaultAgentId ||
        ["pro", "team", "custom"].includes(metadata.tier)
      ) {
        return;
      }
      const [existingGrant] = await tx
        .select({ id: creditExpiresRecord.id })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, orgId),
            eq(creditExpiresRecord.source, ONBOARDING_CREDIT_SOURCE),
            eq(
              creditExpiresRecord.stripeInvoiceId,
              ONBOARDING_CREDIT_IDEMPOTENCY_KEY,
            ),
          ),
        )
        .limit(1);
      if (existingGrant) {
        return;
      }
      const [expired] = await tx
        .select()
        .from(pendingOrgCreditExpirationQuery(orgId, nowDate()));
      requireNoPendingOrgCreditExpiration(orgId, expired);
      const [grant] = await tx
        .insert(creditExpiresRecord)
        .values({
          orgId,
          source: ONBOARDING_CREDIT_SOURCE,
          stripeInvoiceId: ONBOARDING_CREDIT_IDEMPOTENCY_KEY,
          amount: LIMITED_FREE_ONBOARDING_CREDITS,
          remaining: LIMITED_FREE_ONBOARDING_CREDITS,
          expiresAt: onboardingCreditsExpiresAt(nowDate()),
        })
        .onConflictDoNothing()
        .returning({ id: creditExpiresRecord.id });
      if (grant) {
        await tx
          .update(orgMetadata)
          .set({
            credits: sql`${orgMetadata.credits} + ${LIMITED_FREE_ONBOARDING_CREDITS}`,
            updatedAt: nowDate(),
          })
          .where(eq(orgMetadata.orgId, orgId));
      }
    });
    signal.throwIfAborted();
  },
);

export const grantOnboardingCredits$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await settle(set(commitOnboardingCredits$, orgId, signal));
      signal.throwIfAborted();
      if (result.ok) {
        return;
      }
      if (!(result.error instanceof OrgCreditExpirationRequired)) {
        throw result.error;
      }
      await set(expireOrgCredits$, orgId, signal);
    }
    throw new OrgCreditExpirationRequired(orgId);
  },
);
