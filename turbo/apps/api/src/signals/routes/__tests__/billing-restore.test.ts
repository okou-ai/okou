import { randomUUID } from "node:crypto";

import {
  billingRestoreContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { billingRestoreRoutes } from "../billing-restore";
import { billingStatusRoutes } from "../billing-status";
import { createRouteMocks } from "./helpers/route-test";
import {
  postBillingDowngradeCheckoutCompleted,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [...billingRestoreRoutes, ...billingStatusRoutes],
});
const restore = app(billingRestoreContract);
const status = app(billingStatusContract);

const noScheduledChange = Object.freeze({
  error: {
    message: "Subscription has no scheduled billing change",
    code: "CONFLICT",
  },
});

interface Subscriber {
  readonly orgId: string;
  readonly userId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
}

function signIn(
  actor: { readonly orgId: string; readonly userId: string },
  role: "org:admin" | "org:member" = "org:admin",
): void {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId, role);
}

/** Stripe reports the paid Pro or Team subscription of a new organization. */
async function subscribe(
  tier: "pro" | "team",
  cancelAtPeriodEnd: boolean,
  currentPeriodEnd = new Date("2099-07-04T00:00:00.000Z"),
): Promise<Subscriber> {
  const subscriber = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
    customerId: `cus_${randomUUID().slice(0, 8)}`,
    subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
  };
  await postSubscriptionInvoicePaid(context.signal, {
    ...subscriber,
    tier,
    currentPeriodEnd,
    cancelAtPeriodEnd,
  });
  signIn(subscriber);
  return subscriber;
}

/** Stripe's current subscription and customer when the admin restores. */
function stripeAccount(
  subscriber: Subscriber,
  options: { readonly cancelAtPeriodEnd: boolean; readonly card: boolean },
): void {
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
    id: subscriber.subscriptionId,
    status: "active",
    customer: subscriber.customerId,
    cancel_at_period_end: options.cancelAtPeriodEnd,
    default_payment_method: options.card ? "pm_restore_card" : null,
    default_source: null,
    metadata: {},
  });
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: subscriber.customerId,
    invoice_settings: { default_payment_method: null },
    default_source: null,
    metadata: { orgId: subscriber.orgId },
  });
  context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
  context.mocks.stripe.subscriptions.update.mockResolvedValue({
    id: subscriber.subscriptionId,
  });
  context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({});
}

describe("POST /api/billing/restore", () => {
  it("billing-restore-002 refuses a member who is not an admin", async () => {
    signIn(
      { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` },
      "org:member",
    );

    const response = await accept(restore.create({ headers, body: {} }), [403]);
    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });
  });

  it("billing-restore-005 reports a conflict when nothing is scheduled to change", async () => {
    const subscriber = await subscribe("pro", false);
    stripeAccount(subscriber, { cancelAtPeriodEnd: false, card: true });

    const response = await accept(restore.create({ headers, body: {} }), [409]);
    expect(response.body).toStrictEqual(noScheduledChange);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("billing-restore-006 restores a Pro plan scheduled to cancel", async () => {
    const subscriber = await subscribe("pro", true);
    stripeAccount(subscriber, { cancelAtPeriodEnd: true, card: true });

    const restored = await accept(restore.create({ headers, body: {} }), [200]);
    expect(restored.body).toStrictEqual({ status: "restored" });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriber.subscriptionId,
      { cancel_at_period_end: false },
    );
    const billing = await accept(status.get({ headers }), [200]);
    expect(billing.body).toMatchObject({
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      canRestorePlan: false,
    });

    const repeated = await accept(restore.create({ headers, body: {} }), [409]);
    expect(repeated.body).toStrictEqual(noScheduledChange);
  });

  it("billing-restore-008 restores a Team plan by releasing its scheduled downgrade", async () => {
    const changeAt = new Date("2099-07-04T00:00:00.000Z");
    const subscriber = await subscribe("team", false, changeAt);
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    await postBillingDowngradeCheckoutCompleted(context.signal, {
      ...subscriber,
      tier: "team",
      currentPeriodEnd: changeAt,
      targetTier: "pro",
      scheduleId,
    });
    signIn(subscriber);
    stripeAccount(subscriber, { cancelAtPeriodEnd: false, card: true });

    const restored = await accept(restore.create({ headers, body: {} }), [200]);
    expect(restored.body).toStrictEqual({ status: "restored" });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    const billing = await accept(status.get({ headers }), [200]);
    expect(billing.body).toMatchObject({
      cancelAtPeriodEnd: false,
      scheduledChange: null,
    });
  });

  it("billing-restore-009 asks for a payment method and returns to the requested page", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const subscriber = await subscribe("pro", true);
    stripeAccount(subscriber, { cancelAtPeriodEnd: true, card: false });
    const checkoutUrl = `https://checkout.stripe.test/c/${randomUUID()}`;
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: `cs_${randomUUID().slice(0, 8)}`,
      url: checkoutUrl,
    });
    const extraHeaders = { origin: "https://app.okou.ai" };

    const fallback = await accept(
      restore.create({ headers, body: {}, extraHeaders }),
      [200],
    );
    const explicit = await accept(
      restore.create({
        headers,
        body: { returnUrl: "https://app.okou.ai/settings/billing" },
        extraHeaders,
      }),
      [200],
    );

    for (const response of [fallback, explicit]) {
      expect(response.body).toStrictEqual({
        status: "payment_method_required",
        checkoutUrl,
      });
    }
    const metadata = {
      purpose: "billing_restore",
      orgId: subscriber.orgId,
      subscriptionId: subscriber.subscriptionId,
    };
    const sessions = context.mocks.stripe.checkout.sessions.create.mock.calls;
    expect(
      sessions.map(([params]) => {
        return params;
      }),
    ).toStrictEqual([
      {
        mode: "setup",
        customer: subscriber.customerId,
        currency: "usd",
        success_url: "https://app.okou.ai",
        cancel_url: "https://app.okou.ai",
        metadata,
        setup_intent_data: { metadata },
      },
      {
        mode: "setup",
        customer: subscriber.customerId,
        currency: "usd",
        success_url: "https://app.okou.ai/settings/billing",
        cancel_url: "https://app.okou.ai/settings/billing",
        metadata,
        setup_intent_data: { metadata },
      },
    ]);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});
