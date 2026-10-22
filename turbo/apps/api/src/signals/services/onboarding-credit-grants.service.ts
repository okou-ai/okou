import { logger } from "../../lib/log";
import type { UsagePackCreditGrantArgs } from "./usage-pack-credit.service";

const L = logger("onboarding-credit-grants.service");

export const LIMITED_FREE_ONBOARDING_CREDITS = 1000;

const ONBOARDING_CREDIT_SOURCE = "onboarding";
const ONBOARDING_CREDIT_IDEMPOTENCY_KEY = "limited-free-onboarding";
const ONBOARDING_CREDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function onboardingCreditsExpiresAt(grantedAt: Date): Date {
  return new Date(grantedAt.getTime() + ONBOARDING_CREDIT_TTL_MS);
}

export function onboardingCreditGrantPlan(
  orgId: string,
  userId: string,
  amount: number,
  expiresAt: Date,
) {
  const grant: UsagePackCreditGrantArgs = {
    orgId,
    userId,
    grantType: "bonus",
    idempotencyKey: `${ONBOARDING_CREDIT_IDEMPOTENCY_KEY}:${orgId}`,
    amount,
    expiresAt,
  };
  return {
    receipt: {
      orgId,
      source: ONBOARDING_CREDIT_SOURCE,
      stripeInvoiceId: ONBOARDING_CREDIT_IDEMPOTENCY_KEY,
      amount: 0,
      remaining: 0,
      expiresAt,
    },
    grant,
  };
}

export function logOnboardingCreditsAlreadyGranted(orgId: string): void {
  L.debug("Onboarding credits already granted", { orgId });
}
