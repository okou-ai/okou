import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { now } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import { billingRedeemContract } from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { testContext, accept } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { billingRedeemRoutes } from "../billing-redeem";
import { webhooksStripeRoutes } from "../webhooks-stripe";

const context = testContext();

const APP_ORIGIN = new URL(apiTestEnvironment.APP_URL).origin;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const CAMPAIGN = Object.freeze({
  priceId: "price_redeem_zero100",
  couponId: "coupon_redeem_zero100",
});
const redirects = Object.freeze({
  successUrl: `${APP_ORIGIN}/redeem/ZERO100?stripe=success`,
  cancelUrl: `${APP_ORIGIN}/redeem/ZERO100?stripe=cancel`,
});

function sessionId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function checkoutUrl(id: string): string {
  return `https://checkout.stripe.test/c/pay/${id}`;
}

function setup(role: "org:admin" | "org:member" | null = "org:admin") {
  const admin = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mockEnv("OKOU_ONE_TIME_CAMPAIGN", JSON.stringify({ ZERO100: CAMPAIGN }));
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_billing_redeem");
  if (role) {
    createRouteMocks(context).clerk.session(admin.userId, admin.orgId, role);
  }
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: admin.orgId,
    slug: `redeem-${admin.orgId.slice(-8)}`,
    name: "Billing Redeem Org",
    createdBy: admin.userId,
    createdAt: now(),
  });
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
  context.mocks.stripe.coupons.retrieve.mockResolvedValue({
    id: CAMPAIGN.couponId,
    valid: true,
  });
  context.mocks.stripe.prices.retrieve.mockResolvedValue({
    id: CAMPAIGN.priceId,
    active: true,
  });

  const appFor = setupApp({
    context,
    routes: [...billingRedeemRoutes, ...webhooksStripeRoutes],
  });
  const redeem = appFor(billingRedeemContract);
  const webhook = appFor(webhookStripeContract);

  function nextSession(id: string) {
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      id,
      url: checkoutUrl(id),
    });
  }

  function stripeReports(id: string, status: "open" | "expired" | "complete") {
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      id,
      status,
      url: status === "open" ? checkoutUrl(id) : null,
    });
  }

  async function request(campaign = "ZERO100") {
    return (
      await accept(
        redeem.create({ headers, params: { campaign }, body: redirects }),
        [200],
      )
    ).body;
  }

  /** The admin starts redemption, recording Stripe session `id`. */
  async function startRedemption(id: string) {
    nextSession(id);
    await expect(request()).resolves.toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl(id),
    });
    context.mocks.stripe.checkout.sessions.create.mockClear();
  }

  /** Stripe delivers a paid `checkout.session.completed` for session `id`. */
  async function completeCheckout(id: string) {
    const event = {
      id: `evt_${randomUUID()}`,
      created: Math.floor(now() / 1000),
      type: "checkout.session.completed",
      data: {
        object: {
          id,
          object: "checkout.session",
          mode: "payment",
          status: "complete",
          payment_status: "paid",
          customer: customerId,
          metadata: {
            orgId: admin.orgId,
            campaignKey: "ZERO100",
            purpose: "one_time_purchase",
          },
        },
      },
    };
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
    await accept(
      webhook.post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=billing-redeem" },
      }),
      [200],
    );
  }

  return {
    admin,
    redeem,
    request,
    nextSession,
    stripeReports,
    startRedemption,
    completeCheckout,
  };
}

describe("POST /api/billing/redeem/:campaign", () => {
  it("billing-redeem-001 rejects an unauthenticated caller", async () => {
    const { redeem } = setup(null);

    const response = await accept(
      redeem.create({
        headers: {},
        params: { campaign: "ZERO100" },
        body: redirects,
      }),
      [401],
    );

    expect(response.status).toBe(401);
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-redeem-002 reports an unknown campaign as misconfigured", async () => {
    const { request } = setup();

    await expect(request("UNKNOWN")).resolves.toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-redeem-005 asks a non-admin member for an admin", async () => {
    const { request } = setup("org:member");

    await expect(request()).resolves.toStrictEqual({
      status: "error",
      reason: "admin_required",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-redeem-019 refuses a success URL outside the app origin", async () => {
    const { redeem } = setup();

    const response = await accept(
      redeem.create({
        headers,
        params: { campaign: "ZERO100" },
        body: {
          successUrl: "https://evil.example.com/redeem/callback?stripe=success",
          cancelUrl: redirects.cancelUrl,
        },
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message: "successUrl and cancelUrl must match the platform origin",
      code: "BAD_REQUEST",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-redeem-006 opens a discounted Checkout once and resumes it on the next visit", async () => {
    const { admin, request, nextSession, stripeReports } = setup();
    const fresh = sessionId("cs_fresh");
    nextSession(fresh);

    await expect(request()).resolves.toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl(fresh),
    });
    const metadata = {
      orgId: admin.orgId,
      campaignKey: "ZERO100",
      purpose: "one_time_purchase",
    };
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        line_items: [{ price: CAMPAIGN.priceId, quantity: 1 }],
        discounts: [{ coupon: CAMPAIGN.couponId }],
        success_url: redirects.successUrl,
        cancel_url: redirects.cancelUrl,
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: expect.objectContaining(metadata),
        },
        metadata: expect.objectContaining(metadata),
      }),
    );

    stripeReports(fresh, "open");
    await expect(request()).resolves.toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl(fresh),
    });
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledWith(fresh);
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );
  });

  it("billing-redeem-010 expires the open session when the coupon is no longer valid", async () => {
    const { request, nextSession, stripeReports, startRedemption } = setup();
    const stale = sessionId("cs_open_invalid");
    await startRedemption(stale);
    stripeReports(stale, "open");
    context.mocks.stripe.coupons.retrieve.mockResolvedValueOnce({
      id: CAMPAIGN.couponId,
      valid: false,
      redeem_by: Math.floor(now() / 1000) - 86_400,
    });

    await expect(request()).resolves.toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      stale,
    );

    const replacement = sessionId("cs_replacement");
    nextSession(replacement);
    await expect(request()).resolves.toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl(replacement),
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );
  });

  it("billing-redeem-013 rotates to a new Checkout session after the old one expired", async () => {
    const { request, nextSession, stripeReports, startRedemption } = setup();
    const expired = sessionId("cs_expired");
    await startRedemption(expired);
    const fresh = sessionId("cs_fresh");
    stripeReports(expired, "expired");
    nextSession(fresh);

    await expect(request()).resolves.toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl(fresh),
    });

    stripeReports(fresh, "open");
    await expect(request()).resolves.toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl(fresh),
    });
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenLastCalledWith(fresh);
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );
  });

  it("billing-redeem-014 reports already granted once the purchase credits landed", async () => {
    const { request, startRedemption, completeCheckout } = setup();
    const granted = sessionId("cs_granted");
    await startRedemption(granted);
    await completeCheckout(granted);
    context.mocks.stripe.checkout.sessions.retrieve.mockClear();

    await expect(request()).resolves.toStrictEqual({
      status: "already_granted",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).not.toHaveBeenCalled();
  });

  it("billing-redeem-015 reports a misconfigured campaign when Stripe rejects the new session", async () => {
    const { request } = setup();
    context.mocks.stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Stripe.errors.StripeAPIError({
        type: "api_error",
        message: "Coupon ZERO100 is expired and cannot be applied.",
      }),
    );

    await expect(request()).resolves.toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("billing-redeem-017 reports processing while the completed payment awaits its webhook", async () => {
    const { request, stripeReports, startRedemption } = setup();
    const complete = sessionId("cs_complete");
    await startRedemption(complete);
    stripeReports(complete, "complete");

    await expect(request()).resolves.toStrictEqual({ status: "processing" });
  });
});
