import { command } from "ccstate";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, sql } from "drizzle-orm";
import { usagePackAllocationChanges } from "@okouai/db/schema/usage-pack-subscription";

import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { getStripeClient } from "../external/stripe-client";
import {
  BILLING_RESTORE_PURPOSE,
  billingDefaultPaymentMethodStatus,
  createBillingSetupCheckout,
} from "./billing-payment-method.service";

const L = logger("BillingRestore");

type RestoreResult =
  | { readonly ok: true; readonly status: "restored" }
  | {
      readonly ok: true;
      readonly status: "payment_method_required";
      readonly checkoutUrl: string;
    }
  | { readonly ok: false; readonly reason: "no_subscription" }
  | { readonly ok: false; readonly reason: "not_scheduled" }
  | { readonly ok: false; readonly reason: "billing_changed" };

interface RestoreArgs {
  readonly orgId: string;
  readonly returnUrl?: string;
  readonly requirePaymentMethod?: boolean;
}

interface PlanRestoreState {
  readonly stripeSubscriptionId: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pendingSubscriptionScheduleId: string | null;
}

export function canRestorePlanSubscription(state: PlanRestoreState): boolean {
  return (
    state.stripeSubscriptionId !== null &&
    (state.cancelAtPeriodEnd || state.pendingSubscriptionScheduleId !== null)
  );
}

export const restoreSubscription$ = command(
  async (
    { set },
    args: RestoreArgs,
    signal: AbortSignal,
  ): Promise<RestoreResult> => {
    const db = set(writeDb$);
    const [org] = await db
      .select({
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier:
          orgMetadata.pendingSubscriptionTargetTier,
        billingSnapshot: sql`${orgMetadata}::text`.mapWith(pgTextDecoder),
        rowVersion: sql`${orgMetadata}.xmin::text`.mapWith(pgTextDecoder),
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!org?.stripeSubscriptionId) {
      return { ok: false, reason: "no_subscription" };
    }

    const pendingScheduleId = org.pendingSubscriptionScheduleId;
    if (!canRestorePlanSubscription(org)) {
      return { ok: false, reason: "not_scheduled" };
    }

    const stripe = getStripeClient();
    if (args.requirePaymentMethod !== false) {
      const paymentMethod = await billingDefaultPaymentMethodStatus({
        stripe,
        org,
      });
      signal.throwIfAborted();
      if (!paymentMethod.ready) {
        if (!paymentMethod.customerId) {
          throw new Error("Stripe subscription has no customer for restore");
        }
        if (!args.returnUrl) {
          throw new Error("returnUrl is required to collect a payment method");
        }

        const checkoutUrl = await createBillingSetupCheckout({
          stripe,
          purpose: BILLING_RESTORE_PURPOSE,
          orgId: args.orgId,
          customerId: paymentMethod.customerId,
          subscriptionId: org.stripeSubscriptionId,
          returnUrl: args.returnUrl,
        });
        signal.throwIfAborted();
        return { ok: true, status: "payment_method_required", checkoutUrl };
      }
    }

    if (pendingScheduleId) {
      await stripe.subscriptionSchedules.release(pendingScheduleId);
    } else {
      await stripe.subscriptions.update(org.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });
    }

    signal.throwIfAborted();
    const restoredAt = nowDate();
    const published = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(orgMetadata)
        .set({
          cancelAtPeriodEnd: false,
          pendingSubscriptionScheduleId: null,
          pendingSubscriptionTargetTier: null,
          pendingSubscriptionChangeAt: null,
          updatedAt: restoredAt,
        })
        .where(
          and(
            eq(orgMetadata.orgId, args.orgId),
            sql`${orgMetadata}::text = ${org.billingSnapshot}`,
            sql`${orgMetadata}.xmin::text = ${org.rowVersion}`,
          ),
        )
        .returning({ orgId: orgMetadata.orgId });
      if (!updated) {
        return false;
      }
      if (pendingScheduleId) {
        await tx
          .update(usagePackAllocationChanges)
          .set({
            status: "failed",
            failureReason: "scheduled_change_restored",
            completedAt: restoredAt,
            updatedAt: restoredAt,
          })
          .where(
            and(
              eq(usagePackAllocationChanges.orgId, args.orgId),
              eq(usagePackAllocationChanges.status, "scheduled"),
              eq(
                usagePackAllocationChanges.stripeScheduleId,
                pendingScheduleId,
              ),
            ),
          );
      }
      return true;
    });
    signal.throwIfAborted();
    if (!published) {
      return { ok: false, reason: "billing_changed" };
    }

    L.debug("scheduled subscription change restored", {
      orgId: args.orgId,
      stripeSubscriptionId: org.stripeSubscriptionId,
      pendingSubscriptionTargetTier: org.pendingSubscriptionTargetTier,
    });

    return { ok: true, status: "restored" };
  },
);
