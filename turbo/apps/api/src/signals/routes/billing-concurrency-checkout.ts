import { command } from "ccstate";
import { billingConcurrencyCheckoutContract } from "@okouai/api-contracts/contracts/billing";

import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { nowDate } from "../../lib/time";
import {
  badRequestMessage,
  conflict,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { asc, eq } from "drizzle-orm";
import {
  activeConcurrencyPriceId,
  activeConcurrencySubscriptionPredicate,
  type ActiveConcurrencySubscription,
} from "../services/org-concurrency-entitlements.service";
import {
  previewInitialConcurrencyPurchase$,
  orgPlanSubscriptionId$,
  startConcurrencyPurchase$,
} from "../services/billing-checkout.service";
import { previewConcurrencySubscriptionChange$ } from "../services/billing-concurrency-subscription.service";
import { parseBillingPaymentMethodPreviewToken } from "../services/billing-purchase-preview-token.service";
import {
  revalidateBillingPurchase,
  routeBillingPurchasePreview,
  type BillingPurchasePaymentMethod,
} from "../services/billing-payment-method.service";
import { getStripeClient } from "../external/stripe-client";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can buy concurrency",
      code: "FORBIDDEN",
    }),
  }),
});

type ConcurrencyPurchaseTarget =
  | {
      readonly ok: true;
      readonly priceId: string;
      readonly existingSubscription: ActiveConcurrencySubscription | undefined;
    }
  | { readonly ok: false; readonly message: string };

const loadConcurrencyPurchaseTarget$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<ConcurrencyPurchaseTarget> => {
    const db = set(writeDb$);
    const [capabilities] = await db
      .select({
        canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
        restrictedBuiltInModels: orgPlanEntitlements.restrictedBuiltInModels,
      })
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!capabilities) {
      const [org] = await db
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      signal.throwIfAborted();
      if (org) {
        throw new Error(`Missing org plan entitlement for ${orgId}`);
      }
    } else if (capabilities.restrictedBuiltInModels === null) {
      throw new Error(
        `Unexpected NULL restricted_built_in_models for org plan entitlement ${orgId}`,
      );
    }
    if (capabilities?.canBuyConcurrency !== true) {
      return {
        ok: false,
        message:
          "Additional concurrency is only available for Team or Custom workspaces",
      };
    }
    const priceId = activeConcurrencyPriceId();
    if (!priceId) {
      return { ok: false, message: "Concurrency price not configured" };
    }
    const rows = await db
      .select({
        id: orgConcurrencySubscriptions.stripeSubscriptionId,
        quantity: orgConcurrencySubscriptions.slots,
        currentPeriodEnd: orgConcurrencySubscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: orgConcurrencySubscriptions.cancelAtPeriodEnd,
        scheduledQuantity: orgConcurrencySubscriptions.scheduledSlots,
        scheduledChangeAt: orgConcurrencySubscriptions.scheduledChangeAt,
      })
      .from(orgConcurrencySubscriptions)
      .where(activeConcurrencySubscriptionPredicate(orgId, nowDate()))
      .orderBy(
        asc(orgConcurrencySubscriptions.createdAt),
        asc(orgConcurrencySubscriptions.stripeSubscriptionId),
      );
    signal.throwIfAborted();
    const subscriptions = rows.filter((row) => {
      return row.quantity > 0;
    });
    const existingSubscription = subscriptions.find((subscription) => {
      return !subscription.cancelAtPeriodEnd;
    });
    if (!existingSubscription && subscriptions.length > 0) {
      return {
        ok: false,
        message:
          "Restore the existing concurrency subscription before buying more slots",
      };
    }
    return { ok: true, priceId, existingSubscription };
  },
);

type ReadyConcurrencyPurchaseTarget = Extract<
  ConcurrencyPurchaseTarget,
  { readonly ok: true }
>;

const loadConcurrencyPaymentPreview$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly target: ReadyConcurrencyPurchaseTarget;
      readonly quantity: number;
      readonly supportsInAppPreview: boolean;
      readonly returnUrl: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "missing_subscription" }
    | {
        readonly kind: "ready";
        readonly paymentMethodPreviewToken?: string;
      }
  > => {
    const subscriptionId =
      args.target.existingSubscription?.id ??
      (await set(orgPlanSubscriptionId$, args.orgId, signal));
    signal.throwIfAborted();
    if (!subscriptionId) {
      return { kind: "missing_subscription" };
    }
    if (!args.supportsInAppPreview || !args.returnUrl) {
      return { kind: "ready" };
    }
    const targetQuantity = args.target.existingSubscription
      ? args.target.existingSubscription.quantity + args.quantity
      : args.quantity;
    const route = await routeBillingPurchasePreview(
      {
        stripe: getStripeClient(),
        orgId: args.orgId,
        customerId: null,
        subscriptionId,
        operation: "concurrency",
        operationId: `${subscriptionId}:${targetQuantity}`,
        returnUrl: args.returnUrl,
      },
      signal,
    );
    return {
      kind: "ready",
      ...(route.paymentMethodPreviewToken
        ? { paymentMethodPreviewToken: route.paymentMethodPreviewToken }
        : {}),
    };
  },
);

const revalidateConcurrencyPaymentPreview$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly target: ReadyConcurrencyPurchaseTarget;
      readonly quantity: number;
      readonly paymentMethodPreviewToken: string;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "continue";
        readonly paymentMethod?: BillingPurchasePaymentMethod;
      }
    | { readonly kind: "invalid_preview" }
  > => {
    const subscriptionId =
      args.target.existingSubscription?.id ??
      (await set(orgPlanSubscriptionId$, args.orgId, signal));
    signal.throwIfAborted();
    const targetQuantity = args.target.existingSubscription
      ? args.target.existingSubscription.quantity + args.quantity
      : args.quantity;
    const preview = parseBillingPaymentMethodPreviewToken(
      args.paymentMethodPreviewToken,
    );
    if (
      !subscriptionId ||
      !preview ||
      preview.operation !== "concurrency" ||
      preview.operationId !== `${subscriptionId}:${targetQuantity}` ||
      preview.orgId !== args.orgId ||
      preview.subscriptionId !== subscriptionId ||
      new Date(preview.expiresAt) <= nowDate()
    ) {
      return { kind: "invalid_preview" };
    }
    const revalidated = await revalidateBillingPurchase(
      {
        stripe: getStripeClient(),
        orgId: args.orgId,
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
      return { kind: "invalid_preview" };
    }
    return revalidated.kind === "hosted_invoice"
      ? { kind: "continue" }
      : { kind: "continue", paymentMethod: revalidated };
  },
);

const concurrencyCheckoutPreviewAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(billingConcurrencyCheckoutContract.preview),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { supportsInAppPreview, returnUrl } = bodyResult.data;
    const previewEnabled = supportsInAppPreview === true;
    if (previewEnabled && (!returnUrl || !billingRedirectAllowed(returnUrl))) {
      return badRequestMessage(
        "returnUrl must match the platform origin for in-app billing",
      );
    }

    const target = await set(
      loadConcurrencyPurchaseTarget$,
      auth.orgId,
      signal,
    );
    if (!target.ok) {
      return badRequestMessage(target.message);
    }

    const paymentPreview = await set(
      loadConcurrencyPaymentPreview$,
      {
        orgId: auth.orgId,
        target,
        quantity: bodyResult.data.quantity,
        supportsInAppPreview: previewEnabled,
        returnUrl,
      },
      signal,
    );
    if (paymentPreview.kind === "missing_subscription") {
      return badRequestMessage(
        "An active Plan subscription is required to buy concurrency",
      );
    }

    const result = target.existingSubscription
      ? await set(
          previewConcurrencySubscriptionChange$,
          {
            orgId: auth.orgId,
            subscriptionId: target.existingSubscription.id,
            quantity:
              target.existingSubscription.quantity + bodyResult.data.quantity,
          },
          signal,
        )
      : await set(
          previewInitialConcurrencyPurchase$,
          {
            orgId: auth.orgId,
            priceId: target.priceId,
            quantity: bodyResult.data.quantity,
          },
          signal,
        );
    signal.throwIfAborted();
    if (!result.ok) {
      switch (result.reason) {
        case "invalid_quantity": {
          return badRequestMessage(
            "Concurrency quantity cannot exceed 1000 slots",
          );
        }
        case "missing_plan_subscription":
        case "not_found": {
          return badRequestMessage(
            "An active Plan subscription is required to buy concurrency",
          );
        }
        case "canceling": {
          return badRequestMessage(
            "Restore the concurrency subscription before buying more slots",
          );
        }
        case "no_change": {
          return badRequestMessage("Concurrency quantity must change");
        }
        case "pending_update": {
          return conflict(
            "Complete the pending concurrency update before adding slots",
          );
        }
        case "plan_ending": {
          return conflict(
            "Your Plan is scheduled to end before this concurrency change can take effect. Restore your Plan first, then try again.",
          );
        }
      }
    }

    return {
      status: 200 as const,
      body: {
        ...result.preview,
        ...(paymentPreview.paymentMethodPreviewToken
          ? {
              paymentMethodPreviewToken:
                paymentPreview.paymentMethodPreviewToken,
            }
          : {}),
      },
    };
  },
);

const concurrencyCheckoutPreview$ = command(
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
        concurrencyCheckoutPreviewAuthed$,
      ),
      signal,
    );
  },
);

const concurrencyCheckoutAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(billingConcurrencyCheckoutContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { quantity, paymentMethodPreviewToken, successUrl, cancelUrl } =
      bodyResult.data;

    if (
      !billingRedirectAllowed(successUrl) ||
      !billingRedirectAllowed(cancelUrl)
    ) {
      return badRequestMessage(
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    const target = await set(
      loadConcurrencyPurchaseTarget$,
      auth.orgId,
      signal,
    );
    if (!target.ok) {
      return badRequestMessage(target.message);
    }

    let paymentMethod: BillingPurchasePaymentMethod | undefined;
    if (paymentMethodPreviewToken) {
      const revalidated = await set(
        revalidateConcurrencyPaymentPreview$,
        {
          orgId: auth.orgId,
          target,
          quantity,
          paymentMethodPreviewToken,
        },
        signal,
      );
      if (revalidated.kind === "invalid_preview") {
        return conflict("Concurrency purchase preview is no longer valid");
      }
      paymentMethod = revalidated.paymentMethod;
    }

    const purchase = await set(
      startConcurrencyPurchase$,
      {
        orgId: auth.orgId,
        quantity,
        priceId: target.priceId,
        hasScheduledConcurrencyChange:
          target.existingSubscription?.scheduledQuantity !== null &&
          target.existingSubscription?.scheduledQuantity !== undefined,
        successUrl,
        paymentMethod,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!purchase.ok) {
      switch (purchase.reason) {
        case "invalid_quantity": {
          return badRequestMessage(
            "Concurrency quantity cannot exceed 1000 slots",
          );
        }
        case "missing_plan_subscription": {
          return badRequestMessage(
            "An active Plan subscription is required to buy concurrency",
          );
        }
        case "pending_update": {
          return conflict(
            "Complete the pending concurrency update before adding slots",
          );
        }
        case "plan_ending": {
          return conflict(
            "Your Plan is scheduled to end before this concurrency change can take effect. Restore your Plan first, then try again.",
          );
        }
      }
    }

    return { status: 200 as const, body: { url: purchase.url } };
  },
);

const concurrencyCheckout$ = command(async ({ set }, signal: AbortSignal) => {
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
      concurrencyCheckoutAuthed$,
    ),
    signal,
  );
});

export const billingConcurrencyCheckoutRoutes: readonly RouteEntry[] = [
  {
    route: billingConcurrencyCheckoutContract.preview,
    handler: concurrencyCheckoutPreview$,
  },
  {
    route: billingConcurrencyCheckoutContract.create,
    handler: concurrencyCheckout$,
  },
];
