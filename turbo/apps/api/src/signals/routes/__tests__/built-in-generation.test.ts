import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const billingApi = createBillingMediaApi(context);
const webhooks = createWebhookCallbackApi(context);

type BuiltInGenerationActor = ApiTestUser & { readonly orgId: string };
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

function createActor(): BuiltInGenerationActor {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected built-in generation actor to have an org");
  }
  return { ...actor, orgId: actor.orgId };
}

async function grantVisibleCredits(actor: BuiltInGenerationActor) {
  webhooks.configureStripeWebhookSecret();
  webhooks.acceptNextStripeWebhookEvent({
    id: `evt_built_in_generation_${randomUUID()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_built_in_generation_${randomUUID()}`,
        invoice: null,
        subscription: null,
        customer: null,
        metadata: {
          purpose: "credit_purchase",
          orgId: actor.orgId,
          creditsAmount: "1000000",
        },
        payment_status: "paid",
      },
    },
  });
  const response = await webhooks.requestStripeWebhook(
    "{}",
    { "stripe-signature": "valid-signature" },
    [200],
  );
  expect(response.body).toBe("OK");
}

async function createRunningImageGeneration(
  actor: BuiltInGenerationActor,
  createdAt: Date,
): Promise<ApiUuid> {
  mockNow(createdAt);
  mockEnv("FAL_KEY", "test-fal-key");
  context.mocks.ably.createTokenRequest.mockResolvedValue({
    keyName: "ably-key",
    timestamp: 1_700_000_000,
    capability: JSON.stringify({ [`user:${actor.userId}`]: ["subscribe"] }),
    nonce: "nonce",
    mac: "mac",
  });
  server.use(
    http.post("https://queue.fal.run/*", () => {
      return HttpResponse.json({
        request_id: `fal_status_${randomUUID()}`,
        status_url: "https://queue.fal.run/status/built-in-generation",
        response_url: "https://queue.fal.run/response/built-in-generation",
      });
    }),
  );

  await billingApi.selectImageModel(actor, "gpt-image-1");
  const queued = await billingApi.requestImageIoGenerate(
    actor,
    { prompt: "a generated status thumbnail" },
    [202],
  );
  if (queued.status !== 202) {
    throw new Error(`Expected image generation to queue, got ${queued.status}`);
  }
  return apiUuid(queued.body.generationId);
}

describe("GET /api/built-in-generations/:generationId", () => {
  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.ably.createTokenRequest.mockReset();
    context.mocks.ably.publish.mockReset();
    context.mocks.ably.publish.mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("marks stale active jobs as failed when status is read", async () => {
    const currentTime = new Date("2026-05-15T12:00:00.000Z");
    const actor = createActor();
    const completed = await bdd.completeOnboarding(actor);
    expect(completed.status).toBe(200);
    await grantVisibleCredits(actor);
    const staleAt = new Date(currentTime.getTime() - 16 * 60 * 1000);
    const generationId = await createRunningImageGeneration(actor, staleAt);
    mockNow(currentTime);
    context.mocks.ably.publish.mockClear();

    const response = await billingApi.readBuiltInGeneration(
      actor,
      generationId,
      [200],
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      generationId,
      type: "image",
      status: "failed",
      error: {
        message: "Generation timed out. Please try again.",
        code: "GENERATION_TIMEOUT",
      },
      completedAt: currentTime.toISOString(),
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "image",
        status: "failed",
      }),
    );
  });

  it("leaves active jobs running before the timeout window", async () => {
    const currentTime = new Date("2026-05-15T12:00:00.000Z");
    const actor = createActor();
    const completed = await bdd.completeOnboarding(actor);
    expect(completed.status).toBe(200);
    await grantVisibleCredits(actor);
    const freshAt = new Date(currentTime.getTime() - 14 * 60 * 1000);
    const generationId = await createRunningImageGeneration(actor, freshAt);
    mockNow(currentTime);
    context.mocks.ably.publish.mockClear();

    const response = await billingApi.readBuiltInGeneration(
      actor,
      generationId,
      [200],
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      generationId,
      type: "image",
      status: "running",
      completedAt: null,
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
