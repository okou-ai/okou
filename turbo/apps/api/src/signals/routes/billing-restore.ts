import { command } from "ccstate";
import { billingRestoreContract } from "@okouai/api-contracts/contracts/billing";

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
import { restoreSubscription$ } from "../services/billing-restore.service";
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

const restoreAuthed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  signal.throwIfAborted();

  const bodyResult = await get(bodyResultOf(billingRestoreContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const returnUrl = bodyResult.data.returnUrl ?? env("APP_URL");
  if (!billingRedirectAllowed(returnUrl)) {
    return badRequestMessage("returnUrl must match the platform origin");
  }

  const result = await set(
    restoreSubscription$,
    { orgId: auth.orgId, returnUrl },
    signal,
  );
  signal.throwIfAborted();

  if (!result.ok) {
    if (result.reason === "billing_changed") {
      return conflict("Billing changed while restoring; refresh and try again");
    }
    if (result.reason === "no_subscription") {
      return conflict("Org has no active subscription");
    }
    return conflict("Subscription has no scheduled billing change");
  }

  return {
    status: 200 as const,
    body:
      result.status === "restored"
        ? { status: "restored" as const }
        : {
            status: "payment_method_required" as const,
            checkoutUrl: result.checkoutUrl,
          },
  };
});

const restoreAuth$ = authRoute(
  { requireOrganization: true, missingOrganizationStatus: 401 },
  restoreAuthed$,
);

const restore$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(restoreAuth$, signal);
});

export const billingRestoreRoutes: readonly RouteEntry[] = [
  {
    route: billingRestoreContract.create,
    handler: restore$,
  },
];
