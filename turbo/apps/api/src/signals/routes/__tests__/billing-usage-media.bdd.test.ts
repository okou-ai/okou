import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { builtInGenerationContract } from "@okouai/api-contracts/contracts/built-in-generation";
import { imageIoGenerateContract } from "@okouai/api-contracts/contracts/image-io-generate";
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { usageRecordRoutes } from "../usage-record";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { tokenRequest } from "./helpers/public-image-run";
import { createRouteMocks } from "./helpers/route-test";

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const TINY_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8b8AAAAASUVORK5CYII=",
  "base64",
);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const context = testContext();
const billingStatus = setupApp({ context, routes: billingStatusRoutes })(
  billingStatusContract,
);
const userModelPreference = setupApp({
  context,
  routes: userModelPreferenceRoutes,
})(userModelPreferenceContract);
const imageIoGenerate = setupApp({ context, routes: imageIoGenerateRoutes })(
  imageIoGenerateContract,
);
const builtInGeneration = setupApp({
  context,
  routes: builtInGenerationRoutes,
})(builtInGenerationContract);
const usageRecord = setupApp({ context, routes: usageRecordRoutes })(
  usageRecordContract,
);

function signIn(actor: ApiTestUser): void {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole ?? "org:admin",
  );
}

async function onboardFreeAdmin(): Promise<
  ApiTestUser & { readonly orgId: string }
> {
  const bdd = createBddApi(context);
  const admin = bdd.user({ orgRole: "org:admin" });
  if (!admin.orgId) {
    throw new Error("Expected an org-scoped admin");
  }
  const onboarded = await bdd.completeOnboarding(admin);
  expect(onboarded.status).toBe(200);
  return { ...admin, orgId: admin.orgId };
}

async function readCredits(actor: ApiTestUser): Promise<number> {
  signIn(actor);
  const response = await accept(
    billingStatus.get({ headers: AUTH_HEADERS }),
    [200],
  );
  return response.body.credits;
}

async function selectImageModel(
  actor: ApiTestUser,
  selectedImageModel: ImageModelId,
): Promise<void> {
  signIn(actor);
  await accept(
    userModelPreference.update({
      headers: AUTH_HEADERS,
      body: {
        selectedModel: null,
        serviceTier: null,
        selectedImageModel,
      },
    }),
    [200],
  );
}

async function deliverStripeWebhook(
  stripeApp: ReturnType<typeof createAppWithRoutes>,
  event: Readonly<Record<string, unknown>>,
): Promise<void> {
  const stripeEvent = {
    created: Math.floor(now() / 1000),
    ...event,
  };
  context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
    stripeEvent,
  );
  const response = await stripeApp.request("/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=bdd" },
    body: JSON.stringify(stripeEvent),
  });
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("OK");
  await flushWaitUntilForTest();
}

function configureImageProviderMocks(): void {
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("FAL_KEY", "fal-test-key");
  mockEnv("OPENAI_API_KEY", "openai-test-key");
  mockEnv("R2_PRIVATE_ARTIFACTS_BUCKET_NAME", "private-artifacts-test");
  context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  context.mocks.ably.publish.mockResolvedValue(undefined);
  context.mocks.s3.send.mockResolvedValue({});
}

function futureExpiresIso(): string {
  return new Date(nowDate().getTime() + THIRTY_DAYS_MS).toISOString();
}

async function fundOneMillionCredits(
  admin: ApiTestUser & { readonly orgId: string },
): Promise<void> {
  createWebhookCallbackApi(context).configureStripeBillingEnv();
  const stripeApp = createAppWithRoutes({
    signal: context.signal,
    routes: webhooksStripeRoutes,
  });
  await deliverStripeWebhook(stripeApp, {
    id: `evt_media_credits_${randomUUID()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_media_${randomUUID()}`,
        invoice: null,
        subscription: null,
        customer: null,
        mode: "payment",
        payment_status: "paid",
        amount_subtotal: 100_000,
        amount_total: 100_000,
        metadata: {
          purpose: "credit_purchase",
          orgId: admin.orgId,
          creditsAmountMode: "amount_total",
          creditsExpiresAt: futureExpiresIso(),
        },
      },
    },
  });
}

test("billing-usage-media.bdd-005 (1/2) gates zero-credit image generation and rejects unsupported size, background, compression, and seed options", async () => {
  configureImageProviderMocks();
  const admin = await onboardFreeAdmin();
  await selectImageModel(admin, "gpt-image-1");

  signIn(admin);
  const insufficient = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: { prompt: "A clear morning sky" },
    }),
    [402],
  );
  expect(insufficient.body.error.code).toBe("INSUFFICIENT_CREDITS");

  const badSize = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: { prompt: "A clear morning sky", size: "42x42" },
    }),
    [400],
  );
  expect(badSize.body.error.message).toContain("Unsupported image size");

  await selectImageModel(admin, "gpt-image-2");
  signIn(admin);
  const badBackground = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: { prompt: "A clear morning sky", background: "transparent" },
    }),
    [400],
  );
  expect(badBackground.body.error.message).toContain(
    "gpt-image-2 does not support transparent backgrounds",
  );

  await selectImageModel(admin, "gpt-image-1");
  signIn(admin);
  const badCompression = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: {
        prompt: "A clear morning sky",
        outputFormat: "png",
        outputCompression: 50,
      },
    }),
    [400],
  );
  expect(badCompression.body.error.message).toContain(
    "outputCompression is only supported for jpeg or webp output",
  );

  const badSeed = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: { prompt: "A clear morning sky", seed: 1 },
    }),
    [400],
  );
  expect(badSeed.body.error.message).toContain(
    "seed is not supported for gpt-image-1",
  );
});

test("billing-usage-media.bdd-005 (2/2) rejects unsupported safety, enhance, mask, and fidelity options and reports 404/zero usage", async () => {
  configureImageProviderMocks();
  const admin = await onboardFreeAdmin();
  await selectImageModel(admin, "gpt-image-1");

  signIn(admin);
  const badSafety = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: { prompt: "A clear morning sky", safetyTolerance: "6" },
    }),
    [400],
  );
  expect(badSafety.body.error.message).toContain(
    "safetyTolerance is not supported for gpt-image-1",
  );

  const badEnhance = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: { prompt: "A clear morning sky", enhancePrompt: true },
    }),
    [400],
  );
  expect(badEnhance.body.error.message).toContain(
    "enhancePrompt is not supported for gpt-image-1",
  );

  const badMask = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: {
        prompt: "A clear morning sky",
        maskImageUrl: "https://example.test/mask.png",
      },
    }),
    [400],
  );
  expect(badMask.body.error.message).toContain(
    "maskImageUrl requires imageUrl",
  );

  const badFidelity = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: {
        prompt: "A clear morning sky",
        inputFidelity: "high",
      },
    }),
    [400],
  );
  expect(badFidelity.body.error.message).toContain(
    "inputFidelity requires imageUrl",
  );

  const missingGeneration = await accept(
    builtInGeneration.get({
      headers: AUTH_HEADERS,
      params: { generationId: randomUUID() },
    }),
    [404],
  );
  expect(missingGeneration.body.error.message).toContain(
    "Built-in generation not found",
  );

  await expect(readCredits(admin)).resolves.toBe(0);
  const usage = await accept(
    usageRecord.get({
      headers: AUTH_HEADERS,
      query: {
        page: 1,
        pageSize: 20,
        scope: "mine",
        range: "24h",
        tz: "UTC",
      },
    }),
    [200],
  );
  expect(usage.body.rows).toStrictEqual([]);
});

test("billing-usage-media.bdd-002 (1/2) grants checkout and auto-recharge credits idempotently", async () => {
  createWebhookCallbackApi(context).configureStripeBillingEnv();
  const admin = await onboardFreeAdmin();
  const stripeApp = createAppWithRoutes({
    signal: context.signal,
    routes: webhooksStripeRoutes,
  });
  const expiresAt = futureExpiresIso();

  const checkoutSession = {
    id: `cs_credit_${randomUUID()}`,
    invoice: null,
    subscription: null,
    customer: null,
    mode: "payment",
    payment_status: "paid",
    amount_subtotal: 2500,
    amount_total: 2500,
    metadata: {
      purpose: "credit_purchase",
      orgId: admin.orgId,
      creditsAmountMode: "amount_total",
      creditsExpiresAt: expiresAt,
    },
  };
  await deliverStripeWebhook(stripeApp, {
    id: `evt_checkout_1_${randomUUID()}`,
    type: "checkout.session.completed",
    data: { object: checkoutSession },
  });
  await expect(readCredits(admin)).resolves.toBe(25_000);

  await deliverStripeWebhook(stripeApp, {
    id: `evt_checkout_2_${randomUUID()}`,
    type: "checkout.session.completed",
    data: { object: checkoutSession },
  });
  await expect(readCredits(admin)).resolves.toBe(25_000);

  const autoRechargeInvoice = {
    id: `in_auto_${randomUUID()}`,
    customer: null,
    subtotal: 0,
    metadata: {
      type: "auto_recharge",
      orgId: admin.orgId,
      creditsAmount: "3000",
    },
    parent: null,
    lines: { has_more: false, data: [] },
  };
  await deliverStripeWebhook(stripeApp, {
    id: `evt_auto_1_${randomUUID()}`,
    type: "invoice.paid",
    data: { object: autoRechargeInvoice },
  });
  await expect(readCredits(admin)).resolves.toBe(28_000);

  await deliverStripeWebhook(stripeApp, {
    id: `evt_auto_2_${randomUUID()}`,
    type: "invoice.paid",
    data: { object: autoRechargeInvoice },
  });
  await expect(readCredits(admin)).resolves.toBe(28_000);
});

test("billing-usage-media.bdd-002 (2/2) grants credit purchase invoice credits idempotently after checkout and auto-recharge", async () => {
  createWebhookCallbackApi(context).configureStripeBillingEnv();
  const admin = await onboardFreeAdmin();
  const stripeApp = createAppWithRoutes({
    signal: context.signal,
    routes: webhooksStripeRoutes,
  });
  const expiresAt = futureExpiresIso();

  await deliverStripeWebhook(stripeApp, {
    id: `evt_checkout_${randomUUID()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_credit_${randomUUID()}`,
        invoice: null,
        subscription: null,
        customer: null,
        mode: "payment",
        payment_status: "paid",
        amount_subtotal: 2500,
        amount_total: 2500,
        metadata: {
          purpose: "credit_purchase",
          orgId: admin.orgId,
          creditsAmountMode: "amount_total",
          creditsExpiresAt: expiresAt,
        },
      },
    },
  });
  await deliverStripeWebhook(stripeApp, {
    id: `evt_auto_${randomUUID()}`,
    type: "invoice.paid",
    data: {
      object: {
        id: `in_auto_${randomUUID()}`,
        customer: null,
        subtotal: 0,
        metadata: {
          type: "auto_recharge",
          orgId: admin.orgId,
          creditsAmount: "3000",
        },
        parent: null,
        lines: { has_more: false, data: [] },
      },
    },
  });

  const creditPurchaseInvoice = {
    id: `in_credit_${randomUUID()}`,
    customer: null,
    subtotal: 1200,
    metadata: {
      type: "credit_purchase",
      orgId: admin.orgId,
      creditsExpiresAt: expiresAt,
    },
    parent: null,
    lines: { has_more: false, data: [] },
  };
  await deliverStripeWebhook(stripeApp, {
    id: `evt_credit_1_${randomUUID()}`,
    type: "invoice.paid",
    data: { object: creditPurchaseInvoice },
  });
  await expect(readCredits(admin)).resolves.toBe(40_000);

  await deliverStripeWebhook(stripeApp, {
    id: `evt_credit_2_${randomUUID()}`,
    type: "invoice.paid",
    data: { object: creditPurchaseInvoice },
  });
  await expect(readCredits(admin)).resolves.toBe(40_000);
});

test("billing-usage-media.bdd-004 (1/2) queues a funded image generation and reports running on status GET", async () => {
  configureImageProviderMocks();
  const admin = await onboardFreeAdmin();
  await fundOneMillionCredits(admin);

  server.use(
    http.post("https://queue.fal.run/*", () => {
      const requestId = `fal_req_${randomUUID()}`;
      return HttpResponse.json({
        request_id: requestId,
        status_url: `https://queue.fal.run/fal-ai/gpt-image-1/requests/${requestId}/status`,
        response_url: `https://queue.fal.run/fal-ai/gpt-image-1/requests/${requestId}`,
      });
    }),
  );

  await expect(readCredits(admin)).resolves.toBe(1_000_000);
  await selectImageModel(admin, "gpt-image-1");

  signIn(admin);
  const queued = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: { prompt: "Minimal studio product render" },
    }),
    [202],
  );
  expect(queued.body).toMatchObject({
    generationId: expect.any(String),
    type: "image",
    status: "queued",
  });

  signIn(admin);
  const running = await accept(
    builtInGeneration.get({
      headers: AUTH_HEADERS,
      params: { generationId: queued.body.generationId },
    }),
    [200],
  );
  expect(running.body).toMatchObject({
    generationId: queued.body.generationId,
    type: "image",
    status: "running",
  });
});

test("billing-usage-media.bdd-004 (2/2) completes the queued image generation via Fal webhook and returns its result", async () => {
  configureImageProviderMocks();
  const admin = await onboardFreeAdmin();
  await fundOneMillionCredits(admin);

  let capturedFalWebhookUrl: string | null = null;
  const generatedImageUrl = "https://fal.media/files/billing-media-test.png";
  server.use(
    http.post("https://queue.fal.run/*", ({ request }) => {
      capturedFalWebhookUrl = new URL(request.url).searchParams.get(
        "fal_webhook",
      );
      const requestId = `fal_req_${randomUUID()}`;
      return HttpResponse.json({
        request_id: requestId,
        status_url: `https://queue.fal.run/fal-ai/gpt-image-1/requests/${requestId}/status`,
        response_url: `https://queue.fal.run/fal-ai/gpt-image-1/requests/${requestId}`,
      });
    }),
    http.get(generatedImageUrl, () => {
      return new HttpResponse(TINY_PNG_BYTES, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }),
  );

  await selectImageModel(admin, "gpt-image-1");
  signIn(admin);
  const queued = await accept(
    imageIoGenerate.postPrivate({
      headers: AUTH_HEADERS,
      body: { prompt: "Minimal studio product render" },
    }),
    [202],
  );
  const generationId = queued.body.generationId;

  if (!capturedFalWebhookUrl) {
    throw new Error("Expected Fal submission to include fal_webhook URL");
  }
  const webhookTarget = new URL(capturedFalWebhookUrl);
  const falWebhookApp = createAppWithRoutes({
    signal: context.signal,
    routes: webhooksBuiltInGenerationRoutes,
  });
  const webhookResponse = await falWebhookApp.request(
    `${webhookTarget.pathname}${webhookTarget.search}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "COMPLETED",
        payload: {
          images: [
            {
              url: generatedImageUrl,
              content_type: "image/png",
              width: 1024,
              height: 1024,
            },
          ],
          seed: 123,
        },
      }),
    },
  );
  expect(webhookResponse.status).toBe(200);
  await expect(webhookResponse.json()).resolves.toBe("OK");
  await flushWaitUntilForTest();

  signIn(admin);
  const completed = await accept(
    builtInGeneration.get({
      headers: AUTH_HEADERS,
      params: { generationId },
    }),
    [200],
  );
  expect(completed.body).toMatchObject({
    generationId,
    type: "image",
    status: "completed",
    result: {
      provider: "fal",
      outputFormat: "png",
      imageSize: "1024x1024",
      seed: 123,
    },
  });
});
