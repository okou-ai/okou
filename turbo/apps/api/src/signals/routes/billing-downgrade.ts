import { command } from "ccstate";
import { billingDowngradeContract } from "@okouai/api-contracts/contracts/billing";

import { env, optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import {
  badRequestMessage,
  conflict,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { downgradeSubscription$ } from "../services/billing-downgrade.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can manage billing",
      code: "FORBIDDEN",
    }),
  }),
});

const downgradeAuthed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  signal.throwIfAborted();

  const bodyResult = await get(bodyResultOf(billingDowngradeContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { targetTier } = bodyResult.data;
  const returnUrl = bodyResult.data.returnUrl ?? env("APP_URL");
  if (!billingRedirectAllowed(returnUrl)) {
    return badRequestMessage("returnUrl must match the platform origin");
  }

  const result = await set(
    downgradeSubscription$,
    { orgId: auth.orgId, targetTier, returnUrl },
    signal,
  );
  signal.throwIfAborted();

  if (!result.ok) {
    if (result.reason === "billing_changed") {
      return conflict(
        "Billing changed while downgrading; refresh and try again",
      );
    }
    if (result.reason === "no_subscription") {
      return conflict("Org has no active subscription");
    }
    return badRequestMessage(
      `Cannot downgrade from ${result.currentTier} to ${result.targetTier}: target tier is same or higher`,
    );
  }

  return {
    status: 200 as const,
    body:
      result.status === "scheduled"
        ? { success: true, effectiveDate: result.effectiveDate }
        : {
            status: "payment_method_required" as const,
            checkoutUrl: result.checkoutUrl,
          },
  };
});

const downgrade$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      downgradeAuthed$,
    ),
    signal,
  );
});

export const billingDowngradeRoutes: readonly RouteEntry[] = [
  {
    route: billingDowngradeContract.create,
    handler: downgrade$,
  },
];
