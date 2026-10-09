import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";

import { logger } from "../../lib/log";
import type { Tx } from "../../lib/db-types";
import { createUsagePackCreditGrant } from "./usage-pack-credit.service";

const L = logger("onboarding-credit-grants.service");

export const LIMITED_FREE_ONBOARDING_CREDITS = 1000;

const ONBOARDING_CREDIT_SOURCE = "onboarding";
const ONBOARDING_CREDIT_IDEMPOTENCY_KEY = "limited-free-onboarding";
const ONBOARDING_CREDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type DbTransaction = Tx;

export function onboardingCreditsExpiresAt(grantedAt: Date): Date {
  return new Date(grantedAt.getTime() + ONBOARDING_CREDIT_TTL_MS);
}

export async function grantOnboardingUsagePackCredits(
  tx: DbTransaction,
  orgId: string,
  userId: string,
  amount: number,
  expiresAt: Date,
): Promise<void> {
  // Keep the shared receipt identity so legacy grants and rolling API versions
  // cannot award onboarding twice. This reservation carries no org credits.
  const rows = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId,
      source: ONBOARDING_CREDIT_SOURCE,
      stripeInvoiceId: ONBOARDING_CREDIT_IDEMPOTENCY_KEY,
      amount: 0,
      remaining: 0,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });

  if (rows.length === 0) {
    L.debug("Onboarding credits already granted", { orgId });
    return;
  }

  await createUsagePackCreditGrant(tx, {
    orgId,
    userId,
    grantType: "bonus",
    idempotencyKey: `${ONBOARDING_CREDIT_IDEMPOTENCY_KEY}:${orgId}`,
    amount,
    expiresAt,
  });
}
