import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Tx } from "../../lib/db-types";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "./org-plan-entitlements.service";

const L = logger("onboarding-credit-grants.service");

export const LIMITED_FREE_ONBOARDING_CREDITS = 1000;

const ONBOARDING_CREDIT_SOURCE = "onboarding";
const ONBOARDING_CREDIT_IDEMPOTENCY_KEY = "limited-free-onboarding";
const ONBOARDING_CREDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type DbTransaction = Tx;

export function onboardingCreditsExpiresAt(grantedAt: Date): Date {
  return new Date(grantedAt.getTime() + ONBOARDING_CREDIT_TTL_MS);
}

async function grantOrgCredits(
  tx: DbTransaction,
  orgId: string,
  amount: number,
): Promise<void> {
  await writeOrgMetadataWithDefaultPlanEntitlement(
    tx,
    orgId,
    async (writeTx) => {
      return await writeTx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId,
          credits: amount,
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: {
            credits: sql`${orgMetadata.credits} + ${amount}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
    },
  );
}

export async function grantOnboardingCredits(
  tx: DbTransaction,
  orgId: string,
  amount: number,
  expiresAt: Date,
): Promise<void> {
  const rows = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId,
      source: ONBOARDING_CREDIT_SOURCE,
      stripeInvoiceId: ONBOARDING_CREDIT_IDEMPOTENCY_KEY,
      amount,
      remaining: amount,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });

  if (rows.length === 0) {
    L.debug("Onboarding credits already granted", { orgId });
    return;
  }

  await grantOrgCredits(tx, orgId, amount);
}
