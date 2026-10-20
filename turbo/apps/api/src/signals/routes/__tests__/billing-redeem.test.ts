import { randomUUID } from "node:crypto";

import StripeSDK from "stripe";
import { billingRedeemContract } from "@okouai/api-contracts/contracts/billing";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import { postOneTimePurchaseCompleted } from "./helpers/stripe-billing-webhook";
import { billingRedeemRoutes } from "../billing-redeem";

const context = testContext();
const mocks = createRouteMocks(context);

const CAMPAIGN = "ZERO100";
const PRICE_ID = "price_test_campaign";
const COUPON_ID = "ZERO100";
const APP_ORIGIN = "http://app.localhost:3002";
const SUCCESS_URL = `${APP_ORIGIN}/redeem/${CAMPAIGN}?stripe=success`;
const CANCEL_URL = `${APP_ORIGIN}/redeem/${CAMPAIGN}`;

interface RedeemFixture {
  readonly orgId: string;
  readonly userId: string;
}

function redeemFixture(): RedeemFixture {
  return { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` };
}

function checkoutUrl(sessionId: string): string {
  return `https://stripe.test/checkout/${sessionId}`;
}

function setRedeemEnv(): void {
  mockOptionalEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  mockEnv("APP_URL", APP_ORIGIN);
  mockEnv(
    "OKOU_ONE_TIME_CAMPAIGN",
    JSON.stringify({ [CAMPAIGN]: { priceId: PRICE_ID, couponId: COUPON_ID } }),
  );
}

function postRedeem(options?: {
  readonly campaign?: string;
  readonly successUrl?: string;
  readonly headers?: { readonly authorization?: string };
}) {
  const client = setupApp({ context, routes: billingRedeemRoutes })(
    billingRedeemContract,
  );
  return client.create({
    params: { campaign: options?.campaign ?? CAMPAIGN },
    body: {
      successUrl: options?.successUrl ?? SUCCESS_URL,
      cancelUrl: CANCEL_URL,
    },
    headers: options?.headers ?? { authorization: "Bearer clerk-session" },
  });
}

/**
 * Seed the org's promo-redemption row the way production creates it: a first
 * redeem call under a checkout.sessions.create mock returning the desired
 * session id. Clears the create mock afterwards so tests can assert on calls
 * made after seeding.
 */
async function seedOpenRedemption(sessionId: string): Promise<void> {
  context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
    id: sessionId,
    url: checkoutUrl(sessionId),
  });
  const response = await accept(postRedeem(), [200]);
  expect(response.body).toStrictEqual({
    status: "ready",
    checkoutUrl: checkoutUrl(sessionId),
  });
  context.mocks.stripe.checkout.sessions.create.mockClear();
}

describe("POST /api/billing/redeem/:campaign", () => {
  beforeEach(() => {
    setRedeemEnv();
    // Default-safe coupon/price responses; specific tests override.
    context.mocks.stripe.coupons.retrieve.mockResolvedValue({
      id: COUPON_ID,
      valid: true,
    });
    context.mocks.stripe.prices.retrieve.mockResolvedValue({
      id: PRICE_ID,
      active: true,
    });
    // Unique per test: org_metadata.stripe_customer_id carries a unique
    // constraint and rows persist across tests.
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: `cus_${randomUUID()}`,
    });
  });

  it("returns 401 when the caller is unauthenticated", async () => {
    const response = await accept(postRedeem({ headers: {} }), [401]);

    expect(response.status).toBe(401);
  });

  it("returns campaign_misconfigured for an unknown campaign", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await accept(postRedeem({ campaign: "UNKNOWN" }), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  // Web returns 400 when the caller has no active org (resolveOrg throws).
  // Api hardens to 401 via authRoute({ missingOrganizationStatus: 401 }) —
  // intentional Wave 6 cutover convention, documented in PR body.
  it("returns 401 when the caller has no active org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const response = await accept(postRedeem(), [401]);

    expect(response.status).toBe(401);
  });

  it("lets unexpected (non-Stripe) errors propagate so Sentry captures the full stack", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.create.mockRejectedValue(
      new Error("boom: database unreachable"),
    );

    // The service only catches Stripe.errors.StripeError. Plain errors bubble
    // up to the framework's default error handler and become a generic 500.
    const response = await accept(postRedeem(), [500]);

    expect(response.status).toBe(500);
  });

  it("returns admin_required for non-admin org members", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "admin_required",
    });
  });

  it("creates a Stripe Checkout session on first visit and records the row", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_fresh_1",
      url: checkoutUrl("cs_fresh_1"),
    });

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_fresh_1"),
    });

    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        discounts: [{ coupon: COUPON_ID }],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: {
            orgId: fixture.orgId,
            campaignKey: CAMPAIGN,
            purpose: "one_time_purchase",
          },
        },
        metadata: {
          orgId: fixture.orgId,
          campaignKey: CAMPAIGN,
          purpose: "one_time_purchase",
        },
      }),
    );

    // The row was recorded: a follow-up call resumes the recorded session
    // instead of creating a new one.
    context.mocks.stripe.checkout.sessions.create.mockClear();
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_fresh_1",
      status: "open",
      url: checkoutUrl("cs_fresh_1"),
    });

    const resumed = await accept(postRedeem(), [200]);

    expect(resumed.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_fresh_1"),
    });
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledWith("cs_fresh_1");
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("resumes to the same Stripe URL when the existing session is still open", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await seedOpenRedemption("cs_open_1");
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_1",
      status: "open",
      url: checkoutUrl("cs_open_1"),
    });

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_open_1"),
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("drops the cached session and returns campaign_misconfigured when the coupon was deleted", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await seedOpenRedemption("cs_open_stale");
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_stale",
      status: "open",
      url: checkoutUrl("cs_open_stale"),
    });
    context.mocks.stripe.coupons.retrieve.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: `No such coupon: '${COUPON_ID}'`,
        code: "resource_missing",
      }),
    );

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_stale",
    );

    // The cached row is gone: once the campaign is healthy again, a follow-up
    // call creates a fresh session instead of resuming the stale one.
    context.mocks.stripe.coupons.retrieve.mockResolvedValue({
      id: COUPON_ID,
      valid: true,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_after_cleanup",
      url: checkoutUrl("cs_after_cleanup"),
    });

    const followUp = await accept(postRedeem(), [200]);

    expect(followUp.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_after_cleanup"),
    });
  });

  it("still drops the cached session row when expiring it in Stripe fails", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await seedOpenRedemption("cs_open_expire_fails");
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_expire_fails",
      status: "open",
      url: checkoutUrl("cs_open_expire_fails"),
    });
    context.mocks.stripe.coupons.retrieve.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: `No such coupon: '${COUPON_ID}'`,
        code: "resource_missing",
      }),
    );
    context.mocks.stripe.checkout.sessions.expire.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "Session can no longer be expired",
        code: "session_expired",
      }),
    );

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_expire_fails",
    );

    // Row dropped despite the failed expire: a follow-up call creates a
    // fresh session instead of resuming the stale one.
    context.mocks.stripe.coupons.retrieve.mockResolvedValue({
      id: COUPON_ID,
      valid: true,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_after_cleanup",
      url: checkoutUrl("cs_after_cleanup"),
    });

    const followUp = await accept(postRedeem(), [200]);

    expect(followUp.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_after_cleanup"),
    });
  });

  it("drops the cached session and returns campaign_misconfigured when the coupon is no longer valid", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await seedOpenRedemption("cs_open_invalid");
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_invalid",
      status: "open",
      url: checkoutUrl("cs_open_invalid"),
    });
    context.mocks.stripe.coupons.retrieve.mockResolvedValue({
      id: COUPON_ID,
      valid: false,
      redeem_by: Math.floor(now() / 1000) - 60,
    });

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_invalid",
    );

    // Row dropped: a follow-up call creates a fresh session once the coupon
    // is valid again.
    context.mocks.stripe.coupons.retrieve.mockResolvedValue({
      id: COUPON_ID,
      valid: true,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_after_cleanup",
      url: checkoutUrl("cs_after_cleanup"),
    });

    const followUp = await accept(postRedeem(), [200]);

    expect(followUp.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_after_cleanup"),
    });
  });

  it("drops the cached session and returns campaign_misconfigured when the price was deleted", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await seedOpenRedemption("cs_open_price_gone");
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_price_gone",
      status: "open",
      url: checkoutUrl("cs_open_price_gone"),
    });
    context.mocks.stripe.prices.retrieve.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: `No such price: '${PRICE_ID}'`,
        code: "resource_missing",
      }),
    );

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_price_gone",
    );

    // Row dropped: a follow-up call creates a fresh session once the price
    // exists again.
    context.mocks.stripe.prices.retrieve.mockResolvedValue({
      id: PRICE_ID,
      active: true,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_after_cleanup",
      url: checkoutUrl("cs_after_cleanup"),
    });

    const followUp = await accept(postRedeem(), [200]);

    expect(followUp.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_after_cleanup"),
    });
  });

  it("drops the cached session and returns campaign_misconfigured when the price is archived", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await seedOpenRedemption("cs_open_price_archived");
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_price_archived",
      status: "open",
      url: checkoutUrl("cs_open_price_archived"),
    });
    context.mocks.stripe.prices.retrieve.mockResolvedValue({
      id: PRICE_ID,
      active: false,
    });

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_price_archived",
    );

    // Row dropped: a follow-up call creates a fresh session once the price
    // is active again.
    context.mocks.stripe.prices.retrieve.mockResolvedValue({
      id: PRICE_ID,
      active: true,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_after_cleanup",
      url: checkoutUrl("cs_after_cleanup"),
    });

    const followUp = await accept(postRedeem(), [200]);

    expect(followUp.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_after_cleanup"),
    });
  });

  it("rotates to a new Stripe session when the existing one has expired", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await seedOpenRedemption("cs_expired_1");
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_expired_1",
      status: "expired",
      url: null,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_fresh_2",
      url: checkoutUrl("cs_fresh_2"),
    });

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_fresh_2"),
    });

    // The row was rotated: the next call resumes against the new session id.
    context.mocks.stripe.checkout.sessions.retrieve.mockClear();
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_fresh_2",
      status: "open",
      url: checkoutUrl("cs_fresh_2"),
    });

    const resumed = await accept(postRedeem(), [200]);

    expect(resumed.body).toStrictEqual({
      status: "ready",
      checkoutUrl: checkoutUrl("cs_fresh_2"),
    });
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledWith("cs_fresh_2");
  });

  it("returns already_granted when credits have landed", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await seedOpenRedemption("cs_granted_1");
    // Land the credits the way production does: the Stripe
    // checkout.session.completed webhook records the grant.
    const granted = await postOneTimePurchaseCompleted(context.signal, {
      orgId: fixture.orgId,
      credits: 100_000,
      sessionId: "cs_granted_1",
    });
    expect(granted).toBeTruthy();
    // The webhook helper swaps in its own campaign env; restore this suite's.
    setRedeemEnv();

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({ status: "already_granted" });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).not.toHaveBeenCalled();
  });

  it("returns campaign_misconfigured when Stripe rejects the session at create time with a non-invalid-request error", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.create.mockRejectedValue(
      new StripeSDK.errors.StripeAPIError({
        type: "api_error",
        message: "Coupon ZERO100 is expired and cannot be applied.",
      }),
    );

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("returns campaign_misconfigured when Stripe coupon is missing at create time", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.create.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "No such coupon: 'ZERO100'",
        code: "resource_missing",
        param: "discounts[0][coupon]",
      }),
    );

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("returns processing when Stripe session is complete but webhook hasn't landed yet", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await seedOpenRedemption("cs_complete_1");
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_complete_1",
      status: "complete",
      url: null,
    });

    const response = await accept(postRedeem(), [200]);

    expect(response.body).toStrictEqual({ status: "processing" });
  });

  // ---- Test #19 — validates the pre-auth wrap pattern ----
  // The outer command must short-circuit before authRoute runs, surfacing
  // 200/billing_unavailable to an unauthenticated caller when
  // STRIPE_SECRET_KEY is missing.
  it("returns billing_unavailable before auth when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    // No mocks.clerk.session() — caller is unauthenticated.

    const response = await accept(postRedeem({ headers: {} }), [200]);

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "billing_unavailable",
    });
  });

  it("rejects successUrl/cancelUrl whose origin does not match APP_URL", async () => {
    const fixture = redeemFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await accept(
      postRedeem({
        successUrl: "https://evil.example.com/redeem/callback?stripe=success",
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "successUrl and cancelUrl must match the platform origin",
        code: "BAD_REQUEST",
      },
    });
  });
});
