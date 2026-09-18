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
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";
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
  metadata: {
    managed_by: "vm0",
    purpose: "payment_method_management",
  },
} as const;
const BYTEPLUS_ASR_FLASH_URL =
  "https://byteplus-proxy.vm0.ai/api/v3/auc/bigmodel/recognize/flash";
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

function pcmFormData(): FormData {
  const formData = new FormData();
  formData.append(
    "file",
    new File([new Uint8Array([0, 0])], "audio.wav", {
      type: "audio/wav",
    }),
  );
  return formData;
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
    expect(invoices.receiptDownloadsSupported).toBeTruthy();

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
    expect(usageMembers.body.members).toStrictEqual([]);

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

  it("queues and completes a video generation through Stripe credits, BytePlus callback, and status GET", async () => {
    const { api, admin } = testActors();
    await completeVisibleOnboarding(admin);
    if (!admin.orgId) {
      throw new Error("Expected video generation test user to have an org");
    }
    await seedOrgMetadata({
      orgId: admin.orgId,
      tier: "pro",
      credits: 0,
    });

    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeWebhookSecret();
    webhooks.acceptNextStripeWebhookEvent({
      id: `evt_bdd_video_credit_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_bdd_video_credit_${randomUUID()}`,
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

    mockEnv("BYTEPLUS_API_KEY", "test-byteplus-key");
    context.mocks.ably.createTokenRequest.mockResolvedValueOnce({
      keyName: "ably-key",
      timestamp: 1_700_000_000,
      capability: JSON.stringify({ [`user:${admin.userId}`]: ["subscribe"] }),
      nonce: "nonce",
      mac: "mac",
    });
    context.mocks.s3.send.mockResolvedValue({});
    server.use(
      http.post(
        "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            model: "dreamina-seedance-2-0-260128",
            resolution: "480p",
            ratio: "16:9",
            duration: 4,
            generate_audio: false,
          });
          return HttpResponse.json({
            id: `byteplus_bdd_${randomUUID()}`,
            status: "queued",
          });
        },
      ),
      http.get("https://assets.example.test/generated-bdd-video.mp4", () => {
        return new HttpResponse(new Uint8Array([0, 0, 0, 24]).buffer, {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        });
      }),
    );

    const queued = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        duration: "4s",
        resolution: "480p",
        generateAudio: false,
        seed: 456,
      },
      [202],
    );
    if (queued.status !== 202) {
      throw new Error(
        `Expected video generation to queue, got ${queued.status}`,
      );
    }
    const generationId = apiUuid(queued.body.generationId);
    expect(queued.body).toMatchObject({
      type: "video",
      status: "queued",
    });

    const running = await api.readBuiltInGeneration(admin, generationId, [200]);
    if (running.status !== 200) {
      throw new Error(`Expected running generation, got ${running.status}`);
    }
    expect(running.body).toMatchObject({
      generationId,
      type: "video",
      status: "running",
    });

    const completed = await webhooks.requestBytePlusGenerationWebhook({
      generationId,
      token: webhooks.bytePlusGenerationWebhookToken(generationId),
      body: {
        id: "byteplus-bdd-completed",
        status: "succeeded",
        content: {
          video: {
            url: "https://assets.example.test/generated-bdd-video.mp4",
            content_type: "video/mp4",
          },
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
      contentType: "video/mp4",
      durationSeconds: 4,
      model: "dreamina-seedance-2-0-260128",
      aspectRatio: "16:9",
      duration: "4s",
      resolution: "480p",
      generateAudio: false,
      sourceUrl: "https://assets.example.test/generated-bdd-video.mp4",
      requestId: "byteplus-bdd-completed",
    });

    const afterCompletion = await api.readBillingStatus(admin);
    expect(afterCompletion.credits).toBeGreaterThan(0);
    expect(afterCompletion.credits).toBeLessThan(1_000_000);
  });

  it("chains media quota, generation gates, TTS, and status reads through API-visible state", async () => {
    const { api, admin } = testActors();
    await completeVisibleOnboarding(admin);
    if (!admin.orgId) {
      throw new Error("Expected media quota test user to have an org");
    }
    await seedOrgMetadata({
      orgId: admin.orgId,
      tier: "pro-suspend",
      credits: 0,
    });

    const quota = await api.readVoiceQuota(admin);
    expect(quota.body).toStrictEqual({ allowed: false, count: 0, limit: 0 });

    const stt = await api.requestVoiceStt(admin, pcmFormData(), [402]);
    expectApiError(stt.body);
    expect(stt.body.error.code).toBe("AUDIO_INPUT_QUOTA_EXCEEDED");

    const speech = await api.requestVoiceSpeech(
      admin,
      { text: "hello", voice: "marin" },
      [402],
    );
    expectApiError(speech.body);
    expect(speech.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const invalidSpeechVoice = await api.requestVoiceSpeech(
      admin,
      { text: "hello", voice: "not-a-voice" },
      [400],
    );
    expectApiError(invalidSpeechVoice.body);
    expect(invalidSpeechVoice.body.error.message).toBe(
      "Unsupported voice: not-a-voice",
    );

    const missingSpeechText = await api.requestVoiceSpeech(
      admin,
      { text: "   ", voice: "marin" },
      [400],
    );
    expectApiError(missingSpeechText.body);
    expect(missingSpeechText.body.error.message).toBe("text is required");

    const missingImageIoPrompt = await api.requestImageIoGenerate(
      admin,
      {},
      [400],
    );
    expectApiError(missingImageIoPrompt.body);
    expect(missingImageIoPrompt.body.error.message).toBe("prompt is required");

    const unsupportedImageIoModel = await api.requestImageIoGenerate(
      admin,
      { prompt: "a concise billing usage chart", model: "not-a-model" },
      [400],
    );
    expectApiError(unsupportedImageIoModel.body);
    expect(unsupportedImageIoModel.body.error.message).toContain(
      "Unsupported image model: not-a-model",
    );

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

    const transparentGptImage2 = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        model: "gpt-image-2",
        background: "transparent",
      },
      [400],
    );
    expectApiError(transparentGptImage2.body);
    expect(transparentGptImage2.body.error.message).toBe(
      "gpt-image-2 does not support transparent backgrounds",
    );

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

    const suspendedVideo = await api.requestVideoIoGenerate(
      admin,
      { prompt: "animated billing usage chart" },
      [402],
    );
    expectApiError(suspendedVideo.body);
    expect(suspendedVideo.body.error.code).toBe("PRO_REQUIRED");

    await seedOrgMetadata({
      orgId: admin.orgId,
      tier: "pro",
      credits: 0,
    });

    const missingVideoIoPrompt = await api.requestVideoIoGenerate(
      admin,
      {},
      [400],
    );
    expectApiError(missingVideoIoPrompt.body);
    expect(missingVideoIoPrompt.body.error.message).toBe("prompt is required");

    const unsupportedVideoRatio = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        aspectRatio: "10:1",
      },
      [400],
    );
    expectApiError(unsupportedVideoRatio.body);
    expect(unsupportedVideoRatio.body.error.message).toBe(
      "Unsupported video aspect ratio: 10:1",
    );

    const unsupportedVideoDuration = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        duration: "99s",
      },
      [400],
    );
    expectApiError(unsupportedVideoDuration.body);
    expect(unsupportedVideoDuration.body.error.message).toBe(
      "Unsupported video duration: 99s",
    );

    const unsupportedVideoResolution = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        resolution: "4k",
      },
      [400],
    );
    expectApiError(unsupportedVideoResolution.body);
    expect(unsupportedVideoResolution.body.error.message).toBe(
      "Unsupported video resolution for dreamina-seedance-2.0: 4k",
    );

    const invalidVideoSeed = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        seed: -1,
      },
      [400],
    );
    expectApiError(invalidVideoSeed.body);
    expect(invalidVideoSeed.body.error.message).toBe(
      "seed must be a non-negative safe integer",
    );

    const unsupportedReferenceImages = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        model: "veo3.1-fast",
        imageUrls: ["https://assets.example.test/reference.png"],
      },
      [400],
    );
    expectApiError(unsupportedReferenceImages.body);
    expect(unsupportedReferenceImages.body.error.message).toBe(
      "Reference images are not supported for veo3.1-fast",
    );

    const tooManyReferenceVideos = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        videoUrls: [
          "https://assets.example.test/one.mp4",
          "https://assets.example.test/two.mp4",
          "https://assets.example.test/three.mp4",
          "https://assets.example.test/four.mp4",
        ],
      },
      [400],
    );
    expectApiError(tooManyReferenceVideos.body);
    expect(tooManyReferenceVideos.body.error.message).toBe(
      "reference video URLs cannot exceed 3 items",
    );

    const referenceAudioWithoutVisual = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        audioUrls: ["https://assets.example.test/audio.wav"],
      },
      [400],
    );
    expectApiError(referenceAudioWithoutVisual.body);
    expect(referenceAudioWithoutVisual.body.error.message).toBe(
      "reference audio requires at least one image or video reference",
    );

    const tooManyReferenceAudioFiles = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        imageUrls: ["https://assets.example.test/reference.png"],
        audioUrls: [
          "https://assets.example.test/one.wav",
          "https://assets.example.test/two.wav",
        ],
      },
      [400],
    );
    expectApiError(tooManyReferenceAudioFiles.body);
    expect(tooManyReferenceAudioFiles.body.error.message).toBe(
      "reference audio URLs cannot exceed 1 item",
    );

    const unsupportedFirstFrame = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        model: "veo3.1-fast",
        firstFrameImageUrl: "https://assets.example.test/first.png",
      },
      [400],
    );
    expectApiError(unsupportedFirstFrame.body);
    expect(unsupportedFirstFrame.body.error.message).toBe(
      "First frame image is not supported for veo3.1-fast",
    );

    const videoIo = await api.requestVideoIoGenerate(
      admin,
      { prompt: "animated billing usage chart" },
      [402],
    );
    expectApiError(videoIo.body);
    expect(videoIo.body.error.code).toBe("INSUFFICIENT_CREDITS");

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

    const missingMapsProvider = await api.requestMapsGeocode(
      admin,
      { address: "1 Market Street, San Francisco" },
      [503],
    );
    expectApiError(missingMapsProvider.body);
    expect(missingMapsProvider.body.error.code).toBe("NOT_CONFIGURED");

    const unauthenticatedDirections = await api.requestMapsDirections(
      null,
      {
        origin: "San Francisco",
        destination: "Oakland",
      },
      [401],
    );
    expectApiError(unauthenticatedDirections.body);
    expect(unauthenticatedDirections.body.error.code).toBe("UNAUTHORIZED");

    const invalidReverseGeocode = await api.requestMapsReverseGeocode(
      admin,
      { lat: 91, lng: -122.4194 },
      [400],
    );
    expectApiError(invalidReverseGeocode.body);
    expect(invalidReverseGeocode.body.error.code).toBe("BAD_REQUEST");

    api.configureMapsProvider();
    const invalidPlacesSearch = await api.requestMapsPlacesSearch(
      admin,
      { query: "coffee", radius: 1000 },
      [400],
    );
    expectApiError(invalidPlacesSearch.body);
    expect(invalidPlacesSearch.body.error.message).toBe(
      "location is required when radius is provided",
    );

    const invalidPlacesLocation = await api.requestMapsPlacesSearch(
      admin,
      { query: "coffee", location: "San Francisco", radius: 1000 },
      [400],
    );
    expectApiError(invalidPlacesLocation.body);
    expect(invalidPlacesLocation.body.error.message).toBe(
      "location must be formatted as lat,lng",
    );

    const insufficientMapsCredits = await api.requestMapsGeocode(
      admin,
      { address: "1 Market Street, San Francisco" },
      [402],
    );
    expectApiError(insufficientMapsCredits.body);
    expect(insufficientMapsCredits.body.error.code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const insufficientReverseCredits = await api.requestMapsReverseGeocode(
      admin,
      { lat: 37.7749, lng: -122.4194 },
      [402],
    );
    expectApiError(insufficientReverseCredits.body);
    expect(insufficientReverseCredits.body.error.code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const insufficientDirectionsCredits = await api.requestMapsDirections(
      admin,
      {
        origin: "San Francisco",
        destination: "Oakland",
        departureTime: "now",
      },
      [402],
    );
    expectApiError(insufficientDirectionsCredits.body);
    expect(insufficientDirectionsCredits.body.error.code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const insufficientPlaceDetailsCredits = await api.requestMapsPlacesDetails(
      admin,
      { placeId: "places/bdd-place", fields: "pro" },
      [402],
    );
    expectApiError(insufficientPlaceDetailsCredits.body);
    expect(insufficientPlaceDetailsCredits.body.error.code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const bankingWithSession = await api.requestBankingAccounts(admin, [403]);
    expectApiError(bankingWithSession.body);
    expect(bankingWithSession.body.error.message).toBe(
      "This endpoint does not accept the provided credential type",
    );
  });
});

const WEBM_EBML_HEADER: readonly number[] = [0x1a, 0x45, 0xdf, 0xa3];
const WEBM_SEGMENT_ID: readonly number[] = [0x18, 0x53, 0x80, 0x67];
const WEBM_INFO_ID: readonly number[] = [0x15, 0x49, 0xa9, 0x66];
const WEBM_DURATION_ID: readonly number[] = [0x44, 0x89];
const WEBM_TIMECODE_SCALE_ID: readonly number[] = [0x2a, 0xd7, 0xb1];
// TimecodeScale element declaring 1,000,000 ns (one millisecond) per unit.
const WEBM_TIMECODE_SCALE_MS: readonly number[] = [
  ...WEBM_TIMECODE_SCALE_ID,
  0x83,
  0x0f,
  0x42,
  0x40,
];

function bytesOf(
  ...parts: readonly (readonly number[] | Uint8Array)[]
): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => {
    return sum + part.length;
  }, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function asciiBytes(text: string): readonly number[] {
  return [...text].map((char) => {
    return char.charCodeAt(0);
  });
}

function u16le(value: number): readonly number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32le(value: number): readonly number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function riffWavHeader(): readonly number[] {
  return [...asciiBytes("RIFF"), ...u32le(0), ...asciiBytes("WAVE")];
}

function wavChunkHeader(id: string, declaredSize: number): readonly number[] {
  return [...asciiBytes(id), ...u32le(declaredSize)];
}

function wavFmtBody(
  channels: number,
  sampleRate: number,
  bitsPerSample: number,
): readonly number[] {
  const blockAlign = channels * (bitsPerSample / 8);
  return [
    ...u16le(1),
    ...u16le(channels),
    ...u32le(sampleRate),
    ...u32le(sampleRate * blockAlign),
    ...u16le(blockAlign),
    ...u16le(bitsPerSample),
  ];
}

function float64be(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

function float32be(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, false);
  return bytes;
}

// Minimal WebM head: EBML header with an empty body, a Segment, and one Info
// element whose body the caller provides. The declared Info size may lie to
// model truncated streams.
function webmWithInfoBody(
  infoBody: readonly number[],
  declaredSize = infoBody.length,
): Uint8Array<ArrayBuffer> {
  return bytesOf(
    WEBM_EBML_HEADER,
    [0x80],
    WEBM_SEGMENT_ID,
    [0xff],
    WEBM_INFO_ID,
    [0x80 | declaredSize],
    infoBody,
  );
}

function sttFormData(
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  type: string,
): FormData {
  const formData = new FormData();
  formData.append("file", new File([bytes], filename, { type }));
  return formData;
}

describe("FILE-02: audio transcription and speech billing", () => {
  it("estimates WAV and WebM durations from byte variants through STT and bills generated speech", async () => {
    const { api, admin } = testActors();
    if (!admin.orgId) {
      throw new Error("Expected STT duration test user to have an org");
    }
    const runsApi = createRunsApi(context);
    await runsApi.grantProEntitlement(admin);

    mockEnv("BYTEPLUS_STT_API_KEY", "test-byteplus-stt-key");
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        return HttpResponse.json(
          { result: { text: "bdd duration probe" } },
          { headers: { "x-api-status-code": "20000000" } },
        );
      }),
      http.post("https://api.openai.com/v1/audio/transcriptions", () => {
        return HttpResponse.json({ text: "bdd duration probe" });
      }),
    );

    const expectTranscribed = async (
      bytes: Uint8Array<ArrayBuffer>,
      filename: string,
      type: string,
    ): Promise<void> => {
      const accepted = await api.requestVoiceStt(
        admin,
        sttFormData(bytes, filename, type),
        [200],
      );
      expect(accepted.body).toStrictEqual({ text: "bdd duration probe" });
    };
    const expectDurationRejected = async (
      bytes: Uint8Array<ArrayBuffer>,
      filename: string,
      type: string,
      durationSeconds: number,
    ): Promise<void> => {
      const rejected = await api.requestVoiceStt(
        admin,
        sttFormData(bytes, filename, type),
        [400],
      );
      expectApiError(rejected.body);
      expect(rejected.body.error.code).toBe("AUDIO_DURATION_TOO_LONG");
      expect(rejected.body.error.message).toBe(
        `Audio duration (${durationSeconds}s) exceeds maximum (300s)`,
      );
    };

    // WAV bodies that defeat duration parsing transcribe with no duration
    // gate: too short for a header, not RIFF/WAVE, a header-only data chunk
    // with zero audio bytes, and a truncated fmt chunk whose standard-offset
    // fallback reads an unusable all-zero format.
    await expectTranscribed(new Uint8Array(20), "tiny.wav", "audio/wav");
    await expectTranscribed(new Uint8Array(44), "not-riff.wav", "audio/wav");
    await expectTranscribed(
      bytesOf(
        riffWavHeader(),
        wavChunkHeader("fmt ", 16),
        wavFmtBody(1, 16_000, 16),
        wavChunkHeader("data", 0),
      ),
      "header-only.wav",
      "audio/wav",
    );
    await expectTranscribed(
      bytesOf(
        riffWavHeader(),
        wavChunkHeader("JUNK", 16),
        new Uint8Array(16),
        wavChunkHeader("fmt ", 16),
      ),
      "truncated-fmt.wav",
      "audio/wav",
    );

    // A trailing LIST chunk is not audio: only the declared data size counts,
    // so 30,000 bytes at 100 bytes/second stays exactly at the 300s limit.
    await expectTranscribed(
      bytesOf(
        riffWavHeader(),
        wavChunkHeader("fmt ", 16),
        wavFmtBody(1, 100, 8),
        wavChunkHeader("data", 30_000),
        new Uint8Array(30_000),
        wavChunkHeader("LIST", 1000),
        new Uint8Array(1000),
      ),
      "trailing-list.wav",
      "audio/wav",
    );

    // A streamed WAV with an oversized placeholder data size falls back to
    // the bytes that actually follow the data header: 30,100 bytes is 301s.
    await expectDurationRejected(
      bytesOf(
        riffWavHeader(),
        wavChunkHeader("fmt ", 16),
        wavFmtBody(1, 100, 8),
        wavChunkHeader("data", 0xff_ff_ff_ff),
        new Uint8Array(30_100),
      ),
      "streamed.wav",
      "audio/wav",
      301,
    );

    // Compressed audio reads the real container duration since #17143;
    // unparseable mp3 bytes carry no duration and pass the gate.
    await expectTranscribed(new Uint8Array(301_000), "long.mp3", "audio/mpeg");

    // WebM with a TimecodeScale of one millisecond and a float64 Duration of
    // 301,000ms exceeds the request limit. The Duration size is a two-byte
    // vint to exercise multi-byte vint decoding.
    await expectDurationRejected(
      webmWithInfoBody([
        ...WEBM_TIMECODE_SCALE_MS,
        ...WEBM_DURATION_ID,
        0x40,
        0x08,
        ...float64be(301_000),
      ]),
      "long.webm",
      "audio/webm",
      301,
    );

    // A float32 Duration with the default timecode scale parses as 2s.
    await expectTranscribed(
      webmWithInfoBody([...WEBM_DURATION_ID, 0x84, ...float32be(2000)]),
      "short.webm",
      "audio/webm",
    );

    // Malformed WebM heads all fall through to a null duration and still
    // transcribe: each variant trips a different EBML/vint parser guard.
    const unparseableWebm: readonly (readonly [
      string,
      Uint8Array<ArrayBuffer>,
    ])[] = [
      ["shorter-than-ebml-header", Uint8Array.from([0x1a, 0x45])],
      ["not-ebml", new Uint8Array(16)],
      [
        "invalid-ebml-size-vint",
        bytesOf(WEBM_EBML_HEADER, [0x00], new Uint8Array(7)),
      ],
      [
        "ebml-body-consumes-buffer",
        bytesOf(WEBM_EBML_HEADER, [0x87], new Uint8Array(7)),
      ],
      [
        "segment-id-not-four-bytes",
        bytesOf(WEBM_EBML_HEADER, [0x80], [0x80], new Uint8Array(6)),
      ],
      [
        "missing-segment-size",
        bytesOf(WEBM_EBML_HEADER, [0x83], new Uint8Array(3), WEBM_SEGMENT_ID),
      ],
      [
        "invalid-element-id-in-segment",
        bytesOf(
          WEBM_EBML_HEADER,
          [0x80],
          WEBM_SEGMENT_ID,
          [0xff],
          [0x00, 0x00],
        ),
      ],
      [
        "invalid-element-size-in-segment",
        bytesOf(
          WEBM_EBML_HEADER,
          [0x80],
          WEBM_SEGMENT_ID,
          [0xff],
          [0x80, 0x00],
        ),
      ],
      [
        "no-info-element",
        bytesOf(
          WEBM_EBML_HEADER,
          [0x80],
          WEBM_SEGMENT_ID,
          [0xff],
          [0xec, 0x82, 0x00, 0x00],
        ),
      ],
      ["info-without-duration", webmWithInfoBody(WEBM_TIMECODE_SCALE_MS)],
      ["invalid-element-id-in-info", webmWithInfoBody([0x00, 0x00])],
      ["invalid-element-size-in-info", webmWithInfoBody([0x80, 0x00])],
      [
        "unsupported-duration-size",
        webmWithInfoBody([...WEBM_DURATION_ID, 0x82, 0x00, 0x00]),
      ],
      [
        "negative-duration",
        webmWithInfoBody([...WEBM_DURATION_ID, 0x88, ...float64be(-1)]),
      ],
      [
        "truncated-duration",
        webmWithInfoBody([...WEBM_DURATION_ID, 0x88, 0x00, 0x00], 13),
      ],
      [
        "zero-size-timecode-scale",
        webmWithInfoBody([...WEBM_TIMECODE_SCALE_ID, 0x80]),
      ],
      [
        "truncated-timecode-scale",
        webmWithInfoBody([...WEBM_TIMECODE_SCALE_ID, 0x83, 0x0f], 6),
      ],
    ];
    for (const [name, bytes] of unparseableWebm) {
      await expectTranscribed(bytes, `${name}.webm`, "audio/webm");
    }

    // The same WAV parser prices generated speech. Buy visible credits, then
    // generate speech whose mocked WAV holds 12,000 bytes at 8,000
    // bytes/second, which rounds up to 2 billable seconds.
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeWebhookSecret();
    webhooks.acceptNextStripeWebhookEvent({
      id: `evt_bdd_speech_credit_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_bdd_speech_credit_${randomUUID()}`,
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
    const credited = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(credited.body).toBe("OK");
    const beforeSpeech = await api.readBillingStatus(admin);

    server.use(
      http.post("https://api.openai.com/v1/audio/speech", () => {
        const generatedWav = bytesOf(
          riffWavHeader(),
          wavChunkHeader("fmt ", 16),
          wavFmtBody(1, 8000, 8),
          wavChunkHeader("data", 12_000),
          new Uint8Array(12_000),
        );
        return new HttpResponse(generatedWav.buffer, {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        });
      }),
    );
    const speech = await api.requestVoiceSpeech(
      admin,
      { text: "bill two seconds of speech", voice: "marin" },
      [200],
    );
    if (speech.status !== 200) {
      throw new Error(`Expected generated speech, got ${speech.status}`);
    }
    expect(speech.body).toMatchObject({
      contentType: "audio/wav",
      durationSeconds: 2,
      model: "gpt-4o-mini-tts",
      voice: "marin",
      size: 12_044,
    });
    expect(speech.body.creditsCharged).toBeGreaterThan(0);

    const afterSpeech = await api.readBillingStatus(admin);
    expect(afterSpeech.credits).toBe(
      beforeSpeech.credits - speech.body.creditsCharged,
    );
  });
});
