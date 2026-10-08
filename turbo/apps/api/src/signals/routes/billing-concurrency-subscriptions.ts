import { command } from "ccstate";
import { billingConcurrencySubscriptionContract } from "@okouai/api-contracts/contracts/billing";

import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import {
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  cancelConcurrencySubscription$,
  changeConcurrencySubscription$,
  previewConcurrencySubscriptionChange$,
  restoreConcurrencySubscription$,
} from "../services/billing-concurrency-subscription.service";
import { getStripeClient } from "../external/stripe-client";
import { parseBillingPaymentMethodPreviewToken } from "../services/billing-purchase-preview-token.service";
import {
  revalidateBillingPurchase,
  routeBillingPurchasePreview,
  type BillingPurchasePaymentMethod,
} from "../services/billing-payment-method.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can manage concurrency subscriptions",
      code: "FORBIDDEN",
    }),
  }),
});

const previewConcurrencySubscriptionChangeAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(billingConcurrencySubscriptionContract.previewChange),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const previewEnabled = bodyResult.data.supportsInAppPreview === true;
    if (
      previewEnabled &&
      (!bodyResult.data.returnUrl ||
        !billingRedirectAllowed(bodyResult.data.returnUrl))
    ) {
      return badRequestMessage(
        "returnUrl must match the platform origin for in-app billing",
      );
    }
    const { subscriptionId } = get(
      pathParamsOf(billingConcurrencySubscriptionContract.previewChange),
    );
    const result = await set(
      previewConcurrencySubscriptionChange$,
      {
        orgId: auth.orgId,
        subscriptionId,
        quantity: bodyResult.data.quantity,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      switch (result.reason) {
        case "not_found": {
          return notFound("Concurrency subscription not found");
        }
        case "canceling": {
          return badRequestMessage(
            "Restore the concurrency subscription before changing slots",
          );
        }
        case "invalid_quantity": {
          return badRequestMessage(
            "Concurrency quantity cannot exceed 1000 slots",
          );
        }
        case "no_change": {
          return badRequestMessage(
            "New concurrency quantity must differ from the current quantity",
          );
        }
        case "pending_update": {
          return conflict(
            "Complete the pending concurrency update before changing slots",
          );
        }
        case "plan_ending": {
          return conflict(
            "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled.",
          );
        }
      }
    }

    if (previewEnabled && bodyResult.data.returnUrl) {
      const route = await routeBillingPurchasePreview(
        {
          stripe: getStripeClient(),
          orgId: auth.orgId,
          customerId: null,
          subscriptionId,
          operation: "concurrency",
          operationId: `${subscriptionId}:${bodyResult.data.quantity}`,
          returnUrl: bodyResult.data.returnUrl,
        },
        signal,
      );
      return {
        status: 200 as const,
        body: {
          ...result.preview,
          ...(route.paymentMethodPreviewToken
            ? { paymentMethodPreviewToken: route.paymentMethodPreviewToken }
            : {}),
        },
      };
    }
    return { status: 200 as const, body: result.preview };
  },
);

const previewConcurrencySubscriptionChangeRoute$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }

    return await set(
      authRoute(
        {
          requireOrganization: true,
          missingOrganizationStatus: 401,
          requiredCapability: "billing:write",
        },
        previewConcurrencySubscriptionChangeAuthed$,
      ),
      signal,
    );
  },
);

const confirmConcurrencySubscriptionChangeAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(billingConcurrencySubscriptionContract.confirmChange),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { subscriptionId } = get(
      pathParamsOf(billingConcurrencySubscriptionContract.confirmChange),
    );
    let paymentMethod: BillingPurchasePaymentMethod | undefined;
    if (bodyResult.data.paymentMethodPreviewToken) {
      const preview = parseBillingPaymentMethodPreviewToken(
        bodyResult.data.paymentMethodPreviewToken,
      );
      if (
        !preview ||
        preview.operation !== "concurrency" ||
        preview.operationId !==
          `${subscriptionId}:${bodyResult.data.quantity}` ||
        preview.orgId !== auth.orgId ||
        preview.subscriptionId !== subscriptionId ||
        new Date(preview.expiresAt) <= nowDate()
      ) {
        return conflict("Concurrency change preview is no longer valid");
      }
      const revalidated = await revalidateBillingPurchase(
        {
          stripe: getStripeClient(),
          orgId: auth.orgId,
          customerId: preview.customerId,
          subscriptionId,
          paymentMethodId: preview.paymentMethodId,
          operation: preview.operation,
          operationId: preview.operationId,
          returnUrl: preview.returnUrl,
        },
        signal,
      );
      if (revalidated.kind === "invalid_preview") {
        return conflict("Concurrency change preview is no longer valid");
      }
      if (revalidated.kind === "preview") {
        paymentMethod = revalidated;
      }
    }
    const result = await set(
      changeConcurrencySubscription$,
      {
        orgId: auth.orgId,
        subscriptionId,
        quantity: bodyResult.data.quantity,
        paymentMethod,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      switch (result.reason) {
        case "billing_changed": {
          return conflict(
            "Billing changed while updating concurrency; refresh and try again",
          );
        }
        case "not_found": {
          return notFound("Concurrency subscription not found");
        }
        case "canceling": {
          return badRequestMessage(
            "Restore the concurrency subscription before changing slots",
          );
        }
        case "invalid_quantity": {
          return badRequestMessage(
            "Concurrency quantity must be between 1 and 1000 slots",
          );
        }
        case "pending_update": {
          return conflict(
            "Complete the pending concurrency update before changing slots",
          );
        }
        case "plan_ending": {
          return conflict(
            "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled.",
          );
        }
      }
    }

    return { status: 200 as const, body: result.response };
  },
);

const confirmConcurrencySubscriptionChangeRoute$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }

    return await set(
      authRoute(
        {
          requireOrganization: true,
          missingOrganizationStatus: 401,
          requiredCapability: "billing:write",
        },
        confirmConcurrencySubscriptionChangeAuthed$,
      ),
      signal,
    );
  },
);

const cancelConcurrencySubscriptionAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const { subscriptionId } = get(
      pathParamsOf(billingConcurrencySubscriptionContract.cancel),
    );
    const result = await set(
      cancelConcurrencySubscription$,
      { orgId: auth.orgId, subscriptionId },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      switch (result.reason) {
        case "billing_changed": {
          return conflict(
            "Billing changed while updating concurrency; refresh and try again",
          );
        }
        case "not_found": {
          return notFound("Concurrency subscription not found");
        }
        case "pending_update": {
          return conflict(
            "Complete the pending subscription update before canceling concurrency",
          );
        }
        case "plan_ending": {
          return conflict(
            "Restore your Plan before canceling concurrency while a Plan downgrade or cancellation is scheduled.",
          );
        }
      }
    }

    return {
      status: 200 as const,
      body: {
        success: true as const,
        currentPeriodEnd: result.currentPeriodEnd,
      },
    };
  },
);

const cancelConcurrencySubscriptionRoute$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }

    return await set(
      authRoute(
        {
          requireOrganization: true,
          missingOrganizationStatus: 401,
          requiredCapability: "billing:write",
        },
        cancelConcurrencySubscriptionAuthed$,
      ),
      signal,
    );
  },
);

const restoreConcurrencySubscriptionAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const { subscriptionId } = get(
      pathParamsOf(billingConcurrencySubscriptionContract.restore),
    );
    const result = await set(
      restoreConcurrencySubscription$,
      { orgId: auth.orgId, subscriptionId },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      switch (result.reason) {
        case "billing_changed": {
          return conflict(
            "Billing changed while updating concurrency; refresh and try again",
          );
        }
        case "not_found": {
          return notFound("Concurrency subscription not found");
        }
        case "plan_ending": {
          return conflict(
            "Restore your Plan to keep concurrency active while a Plan downgrade or cancellation is scheduled.",
          );
        }
        case "pending_update": {
          return conflict(
            "Complete the pending subscription update before restoring concurrency",
          );
        }
      }
    }

    return {
      status: 200 as const,
      body: {
        success: true as const,
      },
    };
  },
);

const restoreConcurrencySubscriptionRoute$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }

    return await set(
      authRoute(
        {
          requireOrganization: true,
          missingOrganizationStatus: 401,
          requiredCapability: "billing:write",
        },
        restoreConcurrencySubscriptionAuthed$,
      ),
      signal,
    );
  },
);

export const billingConcurrencySubscriptionRoutes: readonly RouteEntry[] = [
  {
    route: billingConcurrencySubscriptionContract.previewChange,
    handler: previewConcurrencySubscriptionChangeRoute$,
  },
  {
    route: billingConcurrencySubscriptionContract.confirmChange,
    handler: confirmConcurrencySubscriptionChangeRoute$,
  },
  {
    route: billingConcurrencySubscriptionContract.cancel,
    handler: cancelConcurrencySubscriptionRoute$,
  },
  {
    route: billingConcurrencySubscriptionContract.restore,
    handler: restoreConcurrencySubscriptionRoute$,
  },
];
