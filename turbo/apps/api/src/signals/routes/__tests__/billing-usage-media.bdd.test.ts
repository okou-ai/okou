import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
// helper gap:
// - Paid media completion uses Stripe webhook-granted credits and real usage
//   pricing. Full provider matrices still stay out of this BDD slice.
// - Billing settlement needs Stripe webhooks or checkout completion that grants
//   entitlements. This file asserts the route-visible checkout, portal, invoice,
//   redeem, status, and usage surfaces without direct database fixtures.
// - Banking success needs a current Okou run, banking connection, account grant,
//   and provider account state. This file covers the public credential gate and
//   records the success-chain gap instead of seeding banking tables.

import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";

import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const appUrl = "http://localhost:3002";
const RESTRICTED_PORTAL_CONFIGURATION = {
  id: "bpc_payment_methods",
  active: true,
  features: {
    customer_update: { enabled: false },
    invoice_history: { enabled: false },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: false },
    subscription_update: { enabled: false },
  },
  login_page: { enabled: false },
  metadata: { purpose: "payment_method_management" },
} as const;
type ApiUuid = `${string}-${string}-${string}-${string}-${string}`;

function apiUuid(value: string): ApiUuid {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`Expected API UUID, received ${value}`);
  }
  return value as ApiUuid;
}

function testActors() {
  const base = createBddApi(context);
  const api = createBillingMediaApi(context);
  const admin = base.user();
  const member = base.user({ orgId: admin.orgId, orgRole: "org:member" });
  base.acceptAgentStorageWrites();
  return { api, admin, member };
}

async function completeVisibleOnboarding(admin: ApiTestUser): Promise<void> {
  const completed = await createBddApi(context).completeOnboarding(admin);
  expect(completed.status).toBe(200);
}

function checkoutUrls() {
  return {
    successUrl: `${appUrl}/settings/billing/success`,
    cancelUrl: `${appUrl}/settings/billing/cancel`,
  };
}

describe("BILL-01: billing status and Stripe-backed actions through public API", () => {
  it("chains status, checkout, portal, invoices, redeem, and admin errors without hidden DB state", async () => {
    const { api, admin, member } = testActors();
    await completeVisibleOnboarding(admin);

    const initialStatus = await api.readBillingStatus(admin);
    expect(initialStatus).toMatchObject({
      tier: "limited-free-1",
      credits: 0,
      hasSubscription: false,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    const initialRecharge = await api.readAutoRecharge(admin);
    expect(initialRecharge).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });

    const invalidRecharge = await api.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 1000 },
      [400],
    );
    expectApiError(invalidRecharge.body);
    expect(invalidRecharge.body.error.code).toBe("BAD_REQUEST");

    const disabledRecharge = await api.updateAutoRecharge(
      admin,
      { enabled: false },
      [200],
    );
    expect(disabledRecharge.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });

    api.configureBillingPrices();
    const stripeIdSuffix = admin.userId.replaceAll("-", "");
    const stripeCustomerId = `cus_${stripeIdSuffix}`;
    const subscriptionSessionId = `cs_sub_${stripeIdSuffix}`;
    const campaignSessionId = `cs_campaign_${stripeIdSuffix}`;
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: stripeCustomerId,
    });
    context.mocks.stripe.checkout.sessions.create
      .mockResolvedValueOnce({
        id: subscriptionSessionId,
        url: "https://checkout.stripe.test/subscription",
      })
      .mockResolvedValueOnce({
        id: campaignSessionId,
        url: "https://checkout.stripe.test/campaign",
      });

    const memberCheckout = await api.requestCheckout(
      member,
      { tier: "pro", ...checkoutUrls() },
      [403],
    );
    expectApiError(memberCheckout.body);
    expect(memberCheckout.body.error.message).toBe(
      "Only org admins can manage billing",
    );

    const checkout = await api.startCheckout(admin, {
      tier: "pro",
      ...checkoutUrls(),
    });
    expect(checkout.body).toStrictEqual({
      url: "https://checkout.stripe.test/subscription",
    });

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: subscriptionSessionId,
      customer: "cus_other",
      status: "complete",
      mode: "subscription",
      subscription: "sub_other",
    });
    const mismatch = await api.completeCheckout(
      admin,
      { sessionId: subscriptionSessionId },
      [400],
    );
    expectApiError(mismatch.body);

    const creditCheckout = await api.requestCreditCheckout(
      admin,
      {
        credits: 2000,
        ...checkoutUrls(),
      },
      [400],
    );
    expectApiError(creditCheckout.body);
    expect(creditCheckout.body.error.message).toBe(
      "Credit purchases are not available for this workspace",
    );

    context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
      data: [RESTRICTED_PORTAL_CONFIGURATION],
    });
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.test/session",
    });
    const portal = await api.openPortal(admin, {
      returnUrl: `${appUrl}/settings/billing`,
    });
    expect(portal.body).toStrictEqual({
      url: "https://billing.stripe.test/session",
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: RESTRICTED_PORTAL_CONFIGURATION.id,
        return_url: `${appUrl}/settings/billing`,
      }),
    );

    context.mocks.stripe.invoices.list.mockResolvedValue({
      data: [
        {
          id: "in_bdd",
          number: "INV-BDD",
          created: 1_700_000_000,
          amount_paid: 2500,
          status: "paid",
          hosted_invoice_url: "https://billing.stripe.test/invoices/in_bdd",
          invoice_pdf: "https://billing.stripe.test/invoices/in_bdd.pdf",
        },
      ],
    });
    const invoices = await api.readInvoices(admin);
    expect(invoices.invoices).toStrictEqual([
      {
        id: "in_bdd",
        number: "INV-BDD",
        date: 1_700_000_000,
        amount: 2500,
        status: "paid",
        hostedInvoiceUrl: "https://billing.stripe.test/invoices/in_bdd",
      },
    ]);

    const memberInvoices = await api.requestInvoices(member, [403]);
    expectApiError(memberInvoices.body);
    expect(memberInvoices.body.error.message).toBe(
      "Only org admins can view invoices",
    );

    const downgrade = await api.downgradeBilling(
      admin,
      { targetTier: "limited-free-1", returnUrl: `${appUrl}/settings/billing` },
      [409],
    );
    expectApiError(downgrade.body);
    expect(downgrade.body.error.message).toBe("Org has no active subscription");

    const restore = await api.restoreBilling(
      admin,
      { returnUrl: `${appUrl}/settings/billing` },
      [409],
    );
    expectApiError(restore.body);
    expect(restore.body.error.message).toBe("Org has no active subscription");

    const missingCampaign = await api.redeemCampaign(
      admin,
      "UNKNOWN",
      checkoutUrls(),
    );
    expect(missingCampaign.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });

    api.configureCampaign();
    const readyCampaign = await api.redeemCampaign(
      admin,
      "ZERO100",
      checkoutUrls(),
    );
    expect(readyCampaign.body).toStrictEqual({
      status: "ready",
      checkoutUrl: "https://checkout.stripe.test/campaign",
    });

    context.mocks.clerk.m2m.createToken.mockResolvedValue({
      token: "m2m_bdd_token",
    });
    server.use(
      http.post("https://atom.example.test/api/redeem-codes/consume", () => {
        return HttpResponse.json({ code: "invalid" }, { status: 404 });
      }),
    );
    const invalidCode = await api.redeemCode(
      admin,
      { code: "BAD-CODE" },
      [400],
    );
    expectApiError(invalidCode.body);
    expect(invalidCode.body.error.message).toBe("Invalid redeem code");

    const finalStatus = await api.readBillingStatus(admin);
    expect(finalStatus.credits).toBe(0);
    expect(finalStatus.hasSubscription).toBeFalsy();
  });

  it("grants Stripe checkout and invoice credits idempotently through webhook-visible billing status", async () => {
    const { api, admin } = testActors();
    await completeVisibleOnboarding(admin);
    if (!admin.orgId) {
      throw new Error("Expected billing webhook test user to have an org");
    }

    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeWebhookSecret();

    const checkoutSessionId = `cs_bdd_credit_${randomUUID()}`;
    webhooks.acceptNextStripeWebhookEvent({
      id: `evt_bdd_checkout_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: checkoutSessionId,
          invoice: null,
          subscription: null,
          customer: null,
          metadata: {
            purpose: "credit_purchase",
            orgId: admin.orgId,
            creditsAmountMode: "amount_total",
          },
          amount_total: 2500,
          payment_status: "paid",
        },
      },
    });
    const checkout = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(checkout.body).toBe("OK");

    const afterCheckout = await api.readBillingStatus(admin);
    expect(afterCheckout.credits).toBe(25_000);

    webhooks.acceptNextStripeWebhookEvent({
      id: `evt_bdd_checkout_duplicate_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: checkoutSessionId,
          invoice: null,
          subscription: null,
          customer: null,
          metadata: {
            purpose: "credit_purchase",
            orgId: admin.orgId,
            creditsAmountMode: "amount_total",
          },
          amount_total: 2500,
          payment_status: "paid",
        },
      },
    });
    const duplicateCheckout = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(duplicateCheckout.body).toBe("OK");

    const afterDuplicateCheckout = await api.readBillingStatus(admin);
    expect(afterDuplicateCheckout.credits).toBe(25_000);

    const autoRechargeInvoiceId = `in_bdd_auto_${randomUUID()}`;
    webhooks.acceptNextStripeWebhookEvent({
      id: `evt_bdd_auto_${randomUUID()}`,
      type: "invoice.paid",
      data: {
        object: {
          id: autoRechargeInvoiceId,
          customer: null,
          metadata: {
            type: "auto_recharge",
            orgId: admin.orgId,
            creditsAmount: "3000",
          },
          subtotal: null,
          lines: {
            has_more: false,
            data: [],
          },
          parent: null,
        },
      },
    });
    const autoRecharge = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(autoRecharge.body).toBe("OK");

    const afterAutoRecharge = await api.readBillingStatus(admin);
    expect(afterAutoRecharge.credits).toBe(28_000);

    webhooks.acceptNextStripeWebhookEvent({
      id: `evt_bdd_auto_duplicate_${randomUUID()}`,
      type: "invoice.paid",
      data: {
        object: {
          id: autoRechargeInvoiceId,
          customer: null,
          metadata: {
            type: "auto_recharge",
            orgId: admin.orgId,
            creditsAmount: "3000",
          },
          subtotal: null,
          lines: {
            has_more: false,
            data: [],
          },
          parent: null,
        },
      },
    });
    const duplicateAutoRecharge = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(duplicateAutoRecharge.body).toBe("OK");

    const afterDuplicateAutoRecharge = await api.readBillingStatus(admin);
    expect(afterDuplicateAutoRecharge.credits).toBe(28_000);

    const creditPurchaseInvoiceId = `in_bdd_credit_${randomUUID()}`;
    webhooks.acceptNextStripeWebhookEvent({
      id: `evt_bdd_invoice_${randomUUID()}`,
      type: "invoice.paid",
      data: {
        object: {
          id: creditPurchaseInvoiceId,
          customer: null,
          metadata: {
            type: "credit_purchase",
            orgId: admin.orgId,
          },
          subtotal: 1200,
          lines: {
            has_more: false,
            data: [],
          },
          parent: null,
        },
      },
    });
    const invoicePurchase = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(invoicePurchase.body).toBe("OK");

    const afterInvoicePurchase = await api.readBillingStatus(admin);
    expect(afterInvoicePurchase.credits).toBe(40_000);

    webhooks.acceptNextStripeWebhookEvent({
      id: `evt_bdd_invoice_duplicate_${randomUUID()}`,
      type: "invoice.paid",
      data: {
        object: {
          id: creditPurchaseInvoiceId,
          customer: null,
          metadata: {
            type: "credit_purchase",
            orgId: admin.orgId,
          },
          subtotal: 1200,
          lines: {
            has_more: false,
            data: [],
          },
          parent: null,
        },
      },
    });
    const duplicateInvoicePurchase = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(duplicateInvoicePurchase.body).toBe("OK");

    const finalStatus = await api.readBillingStatus(admin);
    expect(finalStatus.credits).toBe(40_000);
  });
});

describe("BILL-02: usage reads", () => {
  it("reads empty usage records through visible APIs", async () => {
    const { api, admin } = testActors();
    await completeVisibleOnboarding(admin);

    const usageMembers = await api.readUsageMembers(admin);
    expect(usageMembers.body).toStrictEqual({ period: null, members: [] });

    const fixedPeriod = await api.readUsageMembers(admin, {
      range: "7d",
      tz: "Asia/Shanghai",
    });
    expect(fixedPeriod.body.period).not.toBeNull();
    expect(fixedPeriod.body.members).toStrictEqual([]);

    const usageRecord = await api.readUsageRecord(admin);
    expect(usageRecord.body.pagination.total).toBe(0);
    expect(usageRecord.body.rows).toStrictEqual([]);
  });
});

describe("FILE-02 and CHAIN-BILLING-MEDIA: media generation, quota, and status APIs", () => {
  it("queues and completes an image generation through Stripe credits, Fal webhook, and status GET", async () => {
    const { api, admin } = testActors();
    await completeVisibleOnboarding(admin);
    if (!admin.orgId) {
      throw new Error("Expected media generation test user to have an org");
    }

    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeWebhookSecret();
    webhooks.acceptNextStripeWebhookEvent({
      id: `evt_bdd_media_credit_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_bdd_media_credit_${randomUUID()}`,
          invoice: null,
          subscription: null,
          customer: null,
          metadata: {
            purpose: "credit_purchase",
            orgId: admin.orgId,
            creditsAmount: "1000000",
          },
          payment_status: "paid",
        },
      },
    });
    const credits = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(credits.body).toBe("OK");

    const afterCredits = await api.readBillingStatus(admin);
    expect(afterCredits.credits).toBe(1_000_000);

    context.mocks.ably.createTokenRequest.mockResolvedValueOnce({
      keyName: "ably-key",
      timestamp: 1_700_000_000,
      capability: JSON.stringify({ [`user:${admin.userId}`]: ["subscribe"] }),
      nonce: "nonce",
      mac: "mac",
    });
    context.mocks.s3.send.mockResolvedValue({});
    server.use(
      http.post("https://queue.fal.run/*", () => {
        return HttpResponse.json({
          request_id: `fal_bdd_${randomUUID()}`,
          status_url: "https://queue.fal.run/status/bdd-image",
          response_url: "https://queue.fal.run/response/bdd-image",
        });
      }),
      http.get("https://assets.example.test/generated-bdd-image.png", () => {
        return new HttpResponse(new Uint8Array([137, 80, 78, 71]).buffer, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    await api.selectImageModel(admin, "gpt-image-1");
    const queued = await api.requestImageIoGenerate(
      admin,
      { prompt: "a compact billing usage chart" },
      [202],
    );
    if (queued.status !== 202) {
      throw new Error(
        `Expected image generation to queue, got ${queued.status}`,
      );
    }
    const generationId = apiUuid(queued.body.generationId);
    expect(queued.body).toMatchObject({
      type: "image",
      status: "queued",
    });

    const running = await api.readBuiltInGeneration(admin, generationId, [200]);
    if (running.status !== 200) {
      throw new Error(`Expected running generation, got ${running.status}`);
    }
    expect(running.body).toMatchObject({
      generationId,
      type: "image",
      status: "running",
    });

    const completed = await webhooks.requestFalGenerationWebhook({
      generationId,
      token: webhooks.falGenerationWebhookToken(generationId),
      body: {
        status: "COMPLETED",
        payload: {
          images: [
            {
              url: "https://assets.example.test/generated-bdd-image.png",
              content_type: "image/png",
              width: 1024,
              height: 1024,
            },
          ],
          prompt: "a compact billing usage chart",
          seed: 123,
        },
      },
      statuses: [200],
    });
    expect(completed.body).toBe("OK");

    const finalGeneration = await api.readBuiltInGeneration(
      admin,
      generationId,
      [200],
    );
    if (finalGeneration.status !== 200) {
      throw new Error(
        `Expected completed generation, got ${finalGeneration.status}`,
      );
    }
    expect(finalGeneration.body.status).toBe("completed");
    expect(finalGeneration.body.result).toMatchObject({
      provider: "fal",
      outputFormat: "png",
      imageSize: "1024x1024",
      seed: 123,
    });
  });

  it("chains media quota, generation gates, and status reads through API-visible state", async () => {
    const { api, admin } = testActors();
    await completeVisibleOnboarding(admin);
    if (!admin.orgId) {
      throw new Error("Expected media quota test user to have an org");
    }
    await publicPlanLifecycle(context, admin).update("canceled");

    // The validations below describe gpt-image-1, selected as the member's
    // image model.
    await api.selectImageModel(admin, "gpt-image-1");
    const missingImageIoPrompt = await api.requestImageIoGenerate(
      admin,
      {},
      [400],
    );
    expectApiError(missingImageIoPrompt.body);
    expect(missingImageIoPrompt.body.error.message).toBe("prompt is required");

    // A valid request passes validation with the member's model and reaches
    // the credit gate.
    const creditGatedImageIo = await api.requestImageIoGenerate(
      admin,
      { prompt: "a concise billing usage chart" },
      [402],
    );
    expectApiError(creditGatedImageIo.body);
    expect(creditGatedImageIo.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const unsupportedImageSize = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        size: "42x42",
      },
      [400],
    );
    expectApiError(unsupportedImageSize.body);
    expect(unsupportedImageSize.body.error.message).toContain(
      "Unsupported image size",
    );

    const unsupportedImageQuality = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        quality: "best",
      },
      [400],
    );
    expectApiError(unsupportedImageQuality.body);
    expect(unsupportedImageQuality.body.error.message).toBe(
      "Unsupported image quality: best",
    );

    const unsupportedImageBackground = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        background: "magic",
      },
      [400],
    );
    expectApiError(unsupportedImageBackground.body);
    expect(unsupportedImageBackground.body.error.message).toBe(
      "Unsupported image background: magic",
    );

    await api.selectImageModel(admin, "gpt-image-2");
    const transparentGptImage2 = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        background: "transparent",
      },
      [400],
    );
    expectApiError(transparentGptImage2.body);
    expect(transparentGptImage2.body.error.message).toBe(
      "gpt-image-2 does not support transparent backgrounds",
    );
    await api.selectImageModel(admin, "gpt-image-1");

    const unsupportedImageFormat = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        outputFormat: "gif",
      },
      [400],
    );
    expectApiError(unsupportedImageFormat.body);
    expect(unsupportedImageFormat.body.error.message).toBe(
      "Unsupported image output format: gif",
    );

    const unsupportedImageCompression = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        outputFormat: "png",
        outputCompression: 50,
      },
      [400],
    );
    expectApiError(unsupportedImageCompression.body);
    expect(unsupportedImageCompression.body.error.message).toBe(
      "outputCompression is only supported for jpeg or webp output",
    );

    const unsupportedImageModeration = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        moderation: "strict",
      },
      [400],
    );
    expectApiError(unsupportedImageModeration.body);
    expect(unsupportedImageModeration.body.error.message).toBe(
      "Unsupported image moderation: strict",
    );

    const unsupportedImageSeed = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        seed: 1,
      },
      [400],
    );
    expectApiError(unsupportedImageSeed.body);
    expect(unsupportedImageSeed.body.error.message).toBe(
      "seed is not supported for gpt-image-1",
    );

    const unsupportedImageSafetyTolerance = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        safetyTolerance: "6",
      },
      [400],
    );
    expectApiError(unsupportedImageSafetyTolerance.body);
    expect(unsupportedImageSafetyTolerance.body.error.message).toBe(
      "safetyTolerance is not supported for gpt-image-1",
    );

    const unsupportedImageEnhancePrompt = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        enhancePrompt: true,
      },
      [400],
    );
    expectApiError(unsupportedImageEnhancePrompt.body);
    expect(unsupportedImageEnhancePrompt.body.error.message).toBe(
      "enhancePrompt is not supported for gpt-image-1",
    );

    const invalidSourceImages = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        imageUrls: ["https://assets.example.test/source.png", ""],
      },
      [400],
    );
    expectApiError(invalidSourceImages.body);
    expect(invalidSourceImages.body.error.message).toBe(
      "imageUrls must contain non-empty strings",
    );

    const maskWithoutSource = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        maskImageUrl: "https://assets.example.test/mask.png",
      },
      [400],
    );
    expectApiError(maskWithoutSource.body);
    expect(maskWithoutSource.body.error.message).toBe(
      "maskImageUrl requires imageUrl",
    );

    const inputFidelityWithoutSource = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        inputFidelity: "high",
      },
      [400],
    );
    expectApiError(inputFidelityWithoutSource.body);
    expect(inputFidelityWithoutSource.body.error.message).toBe(
      "inputFidelity requires imageUrl",
    );

    const invalidPromptStrength = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        imagePromptStrength: 2,
      },
      [400],
    );
    expectApiError(invalidPromptStrength.body);
    expect(invalidPromptStrength.body.error.message).toBe(
      "imagePromptStrength must be between 0 and 1",
    );

    const imageIo = await api.requestImageIoGenerate(
      admin,
      { prompt: "a concise billing usage chart" },
      [402],
    );
    expectApiError(imageIo.body);
    expect(imageIo.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const missingGeneration = await api.readBuiltInGeneration(
      admin,
      undefined,
      [404],
    );
    expectApiError(missingGeneration.body);
    expect(missingGeneration.body.error.message).toBe(
      "Built-in generation not found",
    );

    const status = await api.readBillingStatus(admin);
    expect(status.credits).toBe(0);

    const usageRecord = await api.readUsageRecord(admin);
    expect(usageRecord.body.rows).toStrictEqual([]);
  });
});

describe("BILL-02: maps and banking visible boundaries", () => {
  it("covers maps provider/pricing errors and banking credential gating through public routes", async () => {
    const { api, admin } = testActors();
    await completeVisibleOnboarding(admin);

    const missingMapsProvider = await api.requestMapsSearch(
      admin,
      { query: "coffee near 1 Market Street, San Francisco" },
      [503],
    );
    expect(missingMapsProvider.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expectApiError(missingMapsProvider.body);
    expect(missingMapsProvider.body.error.code).toBe("NOT_CONFIGURED");

    const unauthenticatedSearch = await api.requestMapsSearch(
      null,
      { query: "How do I get from San Francisco to Oakland?" },
      [401],
    );
    expect(unauthenticatedSearch.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expectApiError(unauthenticatedSearch.body);
    expect(unauthenticatedSearch.body.error.code).toBe("UNAUTHORIZED");

    const invalidLocation = await api.requestMapsSearch(
      admin,
      {
        query: "coffee near me",
        location: { latitude: 91, longitude: -122.4194 },
      },
      [400],
    );
    expect(invalidLocation.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expectApiError(invalidLocation.body);
    expect(invalidLocation.body.error.code).toBe("BAD_REQUEST");

    api.configureMapsProvider();
    const insufficientMapsCredits = await api.requestMapsSearch(
      admin,
      { query: "coffee near 1 Market Street, San Francisco" },
      [402],
    );
    expect(insufficientMapsCredits.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expectApiError(insufficientMapsCredits.body);
    expect(insufficientMapsCredits.body.error.code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const bankingWithSession = await api.requestBankingAccounts(admin, [403]);
    expectApiError(bankingWithSession.body);
    expect(bankingWithSession.body.error.message).toBe(
      "This endpoint does not accept the provided credential type",
    );
  });
});
