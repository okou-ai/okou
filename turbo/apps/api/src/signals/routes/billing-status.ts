import { computed } from "ccstate";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";

import { optionalEnv } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import {
  getStripeClient,
  isStripeResourceMissingError,
} from "../external/stripe-client";
import { orgBillingStatus } from "../services/billing-status.service";
import { activeConcurrencyPriceId } from "../services/org-concurrency-entitlements.service";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

async function loadConcurrencyUnitAmountCents(): Promise<number | undefined> {
  const priceId = activeConcurrencyPriceId();
  if (!priceId || !optionalEnv("STRIPE_SECRET_KEY")) {
    return undefined;
  }

  const result = await settle(getStripeClient().prices.retrieve(priceId));
  if (!result.ok) {
    if (isStripeResourceMissingError(result.error)) {
      return undefined;
    }
    throw result.error;
  }

  const price = result.value;
  if (price.id !== priceId) {
    throw new Error(
      `Stripe returned concurrency Price ${price.id} for ${priceId}`,
    );
  }
  if (!price.active) {
    throw new Error(`Concurrency Price ${priceId} is inactive`);
  }
  if (
    price.currency !== "usd" ||
    price.unit_amount === null ||
    !Number.isSafeInteger(price.unit_amount) ||
    price.unit_amount <= 0
  ) {
    throw new Error(
      `Concurrency Price ${priceId} must have a positive integer USD unit amount`,
    );
  }
  if (
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1
  ) {
    throw new Error(`Concurrency Price ${priceId} must recur every month`);
  }
  return price.unit_amount;
}

const billingStatusOrgId$ = computed((get) => {
  return get(organizationAuthContext$).orgId;
});

const billingStatus$ = orgBillingStatus(billingStatusOrgId$);

const getBillingStatusInner$ = computed(async (get) => {
  const body = await get(billingStatus$);
  const concurrencyUnitAmountCents = body.canBuyConcurrency
    ? await loadConcurrencyUnitAmountCents()
    : undefined;
  return {
    status: 200 as const,
    body: {
      ...body,
      ...(concurrencyUnitAmountCents !== undefined
        ? { concurrencyUnitAmountCents }
        : {}),
    },
  };
});

export const billingStatusRoutes: readonly RouteEntry[] = [
  {
    route: billingStatusContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "billing:read",
      },
      getBillingStatusInner$,
    ),
  },
];
