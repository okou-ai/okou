import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  builtInGenerationContract,
  type BuiltInGenerationResponse,
} from "@okouai/api-contracts/contracts/built-in-generation";
import {
  imageIoGenerateContract,
  imageIoGenerateResponseSchema,
  type ImageIoGenerateRequest,
  type ImageIoGenerateResponse,
} from "@okouai/api-contracts/contracts/image-io-generate";
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
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
import { createImageRun } from "./helpers/public-image-run";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const FAL_KEY = "test-fal-key";
const OPENAI_KEY = "test-openai-key";
const STRIPE_WEBHOOK_SECRET = "whsec_image_io_test";

const REALTIME_TOKEN_REQUEST = Object.freeze({
  keyName: "test-key",
  timestamp: 1_700_000_000_000,
  capability: '{"user:test-user":["subscribe"]}',
  clientId: "test-user",
  nonce: "test-nonce",
  mac: "test-mac",
});

interface CapturedFalRequest {
  readonly url: string;
  readonly pathname: string;
  readonly webhookUrl: string | null;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

interface S3Tracker {
  readonly putKeys: string[];
  readonly headKeys: string[];
  readonly signedKeys: string[];
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return headers;
}

function configureImageProviderEnv(): void {
  mockEnv("FAL_KEY", FAL_KEY);
  mockEnv("OPENAI_API_KEY", OPENAI_KEY);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  context.mocks.ably.createTokenRequest.mockResolvedValue(
    REALTIME_TOKEN_REQUEST,
  );
  context.mocks.ably.publish.mockResolvedValue(undefined);
}

function installStorageTracker(
  ownedPublicArtifacts: Readonly<Record<string, string>> = {},
): S3Tracker {
  const tracker: S3Tracker = {
    putKeys: [],
    headKeys: [],
    signedKeys: [],
  };
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      const { input } = command as {
        readonly input: { readonly Bucket?: string; readonly Key?: string };
      };
      const key = input.Key ?? "";
      tracker.signedKeys.push(key);
      return Promise.resolve(
        `https://r2.signed.example.test/${input.Bucket ?? "bucket"}/${key}?X-Amz-Signature=test`,
      );
    },
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input: { readonly Key?: string };
    };
    const key = input.Key ?? "";
    if (constructor.name === "PutObjectCommand") {
      tracker.putKeys.push(key);
      return Promise.resolve({ ETag: '"put"' });
    }
    if (constructor.name === "HeadObjectCommand") {
      tracker.headKeys.push(key);
      const ownerUserId = ownedPublicArtifacts[key];
      if (ownerUserId) {
        return Promise.resolve({
          ContentLength: 64,
          ContentType: "image/png",
          Metadata: { "user-id": encodeURIComponent(ownerUserId) },
        });
      }
      return Promise.reject(
        Object.assign(new Error(`Missing S3 key: ${key}`), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        }),
      );
    }
    return Promise.resolve({});
  });
  return tracker;
}

async function grantCredits(
  actor: ApiTestUser,
  credits: number,
): Promise<void> {
  if (credits <= 0) {
    return;
  }
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  const event = {
    id: `evt_credit_${randomUUID()}`,
    type: "invoice.paid",
    created: Math.floor(now() / 1000),
    data: {
      object: {
        id: `in_credit_${randomUUID().slice(0, 8)}`,
        customer: null,
        subtotal: credits / 10,
        metadata: { type: "credit_purchase", orgId: actor.orgId },
        parent: null,
        lines: { has_more: false, data: [] },
      },
    },
  };
  context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(event);
  await accept(
    setupApp({ context, routes: webhooksStripeRoutes })(
      webhookStripeContract,
    ).post({
      body: JSON.stringify(event),
      extraHeaders: { "stripe-signature": "t=1,v1=credit-purchase" },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

async function setImageModel(
  actor: ApiTestUser,
  selectedImageModel: ImageModelId,
): Promise<void> {
  signIn(actor);
  await accept(
    setupApp({ context, routes: userModelPreferenceRoutes })(
      userModelPreferenceContract,
    ).updateImageModel({
      headers,
      body: { selectedImageModel },
    }),
    [200],
  );
}

async function setupAdmin(options: {
  readonly credits: number;
  readonly model: ImageModelId;
}): Promise<ApiTestUser> {
  configureImageProviderEnv();
  const admin = bdd.user({ orgRole: "org:admin" });
  await grantCredits(admin, options.credits);
  await setImageModel(admin, options.model);
  return admin;
}

function generateClient(actor: ApiTestUser) {
  signIn(actor);
  return setupApp({ context, routes: imageIoGenerateRoutes })(
    imageIoGenerateContract,
  );
}

async function readGeneration(
  actor: ApiTestUser,
  generationId: string,
): Promise<BuiltInGenerationResponse> {
  signIn(actor);
  const response = await accept(
    setupApp({ context, routes: builtInGenerationRoutes })(
      builtInGenerationContract,
    ).get({
      headers,
      params: { generationId },
    }),
    [200],
  );
  return response.body;
}

async function readBalance(actor: ApiTestUser): Promise<number> {
  signIn(actor);
  const response = await accept(
    setupApp({ context, routes: billingStatusRoutes })(
      billingStatusContract,
    ).get({ headers }),
    [200],
  );
  return response.body.credits;
}

function parseCompletedResult(
  job: BuiltInGenerationResponse,
): ImageIoGenerateResponse {
  expect(job.status).toBe("completed");
  return imageIoGenerateResponseSchema.parse(job.result);
}

async function postFalWebhook(
  webhookUrl: string | null,
  body: Record<string, unknown>,
): Promise<void> {
  if (!webhookUrl) {
    throw new Error("Expected fal_webhook query parameter on Fal request");
  }
  const parsed = new URL(webhookUrl);
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: webhooksBuiltInGenerationRoutes,
  });
  const response = await app.request(`${parsed.pathname}${parsed.search}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

function installFalSuccessFixture(options: {
  readonly endpointPath: string;
  readonly imageUrl: string;
  readonly contentType: string;
  readonly imageBytes?: Uint8Array;
  readonly billableUnits?: number;
  readonly requestId?: string;
}): {
  readonly requests: CapturedFalRequest[];
  readonly responseUrl: string;
  readonly requestId: string;
} {
  const requests: CapturedFalRequest[] = [];
  const requestId = options.requestId ?? `fal_req_${randomUUID().slice(0, 8)}`;
  const statusUrl = `https://queue.fal.run/${options.endpointPath}/requests/${requestId}/status`;
  const responseUrl = `https://queue.fal.run/${options.endpointPath}/requests/${requestId}`;
  const bytes = options.imageBytes ?? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  server.use(
    http.post(
      `https://queue.fal.run/${options.endpointPath}`,
      async ({ request }) => {
        const parsedUrl = new URL(request.url);
        const body = (await request.json()) as Record<string, unknown>;
        requests.push({
          url: request.url,
          pathname: parsedUrl.pathname,
          webhookUrl: parsedUrl.searchParams.get("fal_webhook"),
          authorization: request.headers.get("authorization"),
          body,
        });
        return HttpResponse.json({
          request_id: requestId,
          status_url: statusUrl,
          response_url: responseUrl,
        });
      },
    ),
    http.get(options.imageUrl, () => {
      return new HttpResponse(bytes, {
        status: 200,
        headers: { "content-type": options.contentType },
      });
    }),
    ...(options.billableUnits === undefined
      ? []
      : [
          http.get(responseUrl, ({ request }) => {
            expect(request.headers.get("authorization")).toBe(`Key ${FAL_KEY}`);
            return HttpResponse.json(
              { images: [{ url: options.imageUrl }] },
              {
                status: 200,
                headers: {
                  "x-fal-billable-units": String(options.billableUnits),
                },
              },
            );
          }),
        ]),
  );

  return { requests, responseUrl, requestId };
}

function readRealtimeGenerationEvents(): readonly {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
}[] {
  return context.mocks.ably.publish.mock.calls.flatMap((call) => {
    const eventName = typeof call[0] === "string" ? call[0] : "";
    const payload =
      typeof call[1] === "object" && call[1] !== null
        ? (call[1] as Record<string, unknown>)
        : {};
    return eventName.startsWith("built-in-generation:")
      ? [{ eventName, payload }]
      : [];
  });
}

function expectShortArtifactPathname(url: string, extension: string): void {
  const pathname = new URL(url).pathname;
  expect(pathname.startsWith("/artifacts/")).toBeTruthy();
  expect(pathname.endsWith(extension)).toBeTruthy();
}

describe("POST /api/image-io/generate", () => {
  it("image-io-generate-001 returns 401 when not authenticated", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const response = await accept(
      setupApp({ context, routes: imageIoGenerateRoutes })(
        imageIoGenerateContract,
      ).post({
        headers: {},
        body: { prompt: "a cat" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("image-io-generate-002 rejects empty prompts before provider generation", async () => {
    const admin = await setupAdmin({ credits: 10_000, model: "gpt-image-1" });

    const response = await accept(
      generateClient(admin).post({
        headers,
        body: { prompt: "   \t\n  " },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "prompt is required", code: "BAD_REQUEST" },
    });
    await expect(readBalance(admin)).resolves.toBe(10_000);
  });

  it("image-io-generate-003 rejects transparent background requests before provider generation", async () => {
    const admin = await setupAdmin({ credits: 1000, model: "gpt-image-2" });

    const response = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "a floating glass cube",
          background: "transparent",
          outputFormat: "webp",
        },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "gpt-image-2 does not support transparent backgrounds",
        code: "BAD_REQUEST",
      },
    });
  });

  it("image-io-generate-004 keeps GPT Image 2 limited to its supported quality levels", async () => {
    const admin = await setupAdmin({ credits: 1000, model: "gpt-image-2" });

    const response = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "a botanical illustration",
          quality: "xhigh",
        },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Unsupported image quality: xhigh",
        code: "BAD_REQUEST",
      },
    });
  });

  it(
    "image-io-generate-006 uses the catalog default in a real Run with an unset member preference",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const imageRun = await createImageRun(context, null, 0);

      const preference = await imageRun.run(async () => {
        signIn(imageRun.actor);
        return await accept(
          setupApp({ context, routes: userModelPreferenceRoutes })(
            userModelPreferenceContract,
          ).get({ headers }),
          [200],
        );
      });

      expect(preference.body.selectedImageModel).toBeNull();
      expect(imageRun.execution.appendSystemPrompt).toContain(
        "Built-in image generation uses `gpt-image-2.5-flare`",
      );
    },
  );

  it("image-io-generate-007 returns 402 when the org has no spendable credits", async () => {
    const admin = await setupAdmin({ credits: 0, model: "gpt-image-1" });

    const response = await accept(
      generateClient(admin).post({
        headers,
        body: { prompt: "a cat" },
      }),
      [402],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
    await expect(readBalance(admin)).resolves.toBe(0);
  });

  it("image-io-generate-064 does not complete a job after the status route times it out", async () => {
    mockNow(new Date("2026-05-15T12:00:00Z"));
    const admin = await setupAdmin({ credits: 1000, model: "gpt-image-1" });
    const storage = installStorageTracker();
    const fal = installFalSuccessFixture({
      endpointPath: "fal-ai/gpt-image-1/text-to-image",
      imageUrl: "https://fal.media/late-image.webp",
      contentType: "image/webp",
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: { prompt: "a late image" },
      }),
      [202],
    );

    expect(fal.requests).toHaveLength(1);
    expect(fal.requests[0]?.authorization).toBe(`Key ${FAL_KEY}`);
    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "a late image",
      image_size: "1024x1024",
      num_images: 1,
      output_format: "png",
      quality: "medium",
      background: "auto",
      openai_api_key: OPENAI_KEY,
    });

    mockNow(new Date("2026-05-15T12:16:00Z"));
    const timedOut = await readGeneration(admin, accepted.body.generationId);
    expect(timedOut).toMatchObject({
      generationId: accepted.body.generationId,
      status: "failed",
      error: {
        code: "GENERATION_TIMEOUT",
        message: "Generation timed out. Please try again.",
      },
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        images: [
          {
            url: "https://fal.media/late-image.webp",
            content_type: "image/webp",
            width: 1024,
            height: 1024,
          },
        ],
      },
    });

    const afterLateWebhook = await readGeneration(
      admin,
      accepted.body.generationId,
    );
    expect(afterLateWebhook).toMatchObject({
      generationId: accepted.body.generationId,
      status: "failed",
      error: {
        code: "GENERATION_TIMEOUT",
        message: "Generation timed out. Please try again.",
      },
    });
    expect(storage.putKeys).toStrictEqual([]);
    await expect(readBalance(admin)).resolves.toBe(1000);
  });

  it("image-io-generate-048 maps Fal failure evidence for status outside the provider fallback set through status and realtime", async () => {
    const admin = await setupAdmin({ credits: 1000, model: "gpt-image-1" });
    const storage = installStorageTracker();
    const privatePrompt = "confidential-board-deck-prompt-94821";
    const privateReferenceHost = "private-assets.internal.example";
    const privateReferenceUrl = `https://${privateReferenceHost}/secret/image.png?token=tok_secret_99`;
    const providerRequestId = "fal_req_secret_403_id";
    const fal = installFalSuccessFixture({
      endpointPath: "fal-ai/gpt-image-1/edit-image",
      imageUrl: "https://fal.media/unused-403.png",
      contentType: "image/png",
      requestId: providerRequestId,
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: privatePrompt,
          imageUrl: privateReferenceUrl,
        },
      }),
      [202],
    );

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: providerRequestId,
      gateway_request_id: "gw_secret_req_403",
      status: "ERROR",
      error: "Invalid status code: 403",
    });

    const job = await readGeneration(admin, accepted.body.generationId);
    expect(job).toMatchObject({
      generationId: accepted.body.generationId,
      status: "failed",
      error: {
        code: "GENERATION_FAILED",
        message: "Image generation failed.",
      },
    });
    expect(job.result).toBeUndefined();

    const realtimeFailed = readRealtimeGenerationEvents().find((entry) => {
      return (
        entry.eventName ===
          `built-in-generation:${accepted.body.generationId}` &&
        entry.payload.status === "failed"
      );
    });
    expect(realtimeFailed?.payload).toMatchObject({
      generationId: accepted.body.generationId,
      status: "failed",
      error: {
        code: "GENERATION_FAILED",
        message: "Image generation failed.",
      },
    });
    expect(realtimeFailed?.payload.result).toBeUndefined();

    const serializedOutputs = JSON.stringify({
      status: job,
      realtime: realtimeFailed?.payload,
    });
    const serializedWithoutIdsOrTimestamps = JSON.stringify(
      {
        status: job,
        realtime: realtimeFailed?.payload,
      },
      (key, value: unknown) => {
        if (key === "generationId" || key.endsWith("At")) {
          return undefined;
        }
        return value;
      },
    );
    for (const secret of [
      privatePrompt,
      privateReferenceHost,
      "Invalid status code: 403",
      "tok_secret_99",
      providerRequestId,
      "gw_secret_req_403",
    ]) {
      expect(serializedOutputs).not.toContain(secret);
    }
    expect(serializedWithoutIdsOrTimestamps).not.toContain("403");

    expect(storage.putKeys).toStrictEqual([]);
    await expect(readBalance(admin)).resolves.toBe(1000);

    signIn(admin);
    const usage = await accept(
      setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get(
        {
          headers,
          query: { scope: "mine", range: "today", tz: "UTC" },
        },
      ),
      [200],
    );
    expect(usage.body.totalCredits).toBe(0);
    expect(usage.body.rows).toStrictEqual([]);
  });

  it("image-io-generate-065 rejects a Qwen Image 3 size above the provider's pixel cap", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "alibaba/qwen-image-3/text-to-image",
    });

    const response = await accept(
      generateClient(admin).post({
        headers,
        body: { prompt: "a wide panorama", size: "3840x2160" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Unsupported image size for qwen-image-3: 3840x2160; total pixels must be at most 4194304",
        code: "BAD_REQUEST",
      },
    });
    await expect(readBalance(admin)).resolves.toBe(1000);
  });

  it("image-io-generate-067 generates image-to-image through fal at standard provider prices", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "fal-ai/flux-pro/v1.1",
    });
    installStorageTracker();
    const referenceUrl = "https://images.example.test/ref-flux-redux.png";
    const fal = installFalSuccessFixture({
      endpointPath: "fal-ai/flux-pro/v1.1/redux",
      imageUrl: "https://fal.media/flux-redux-out.jpg",
      contentType: "image/jpeg",
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "restyle as watercolor",
          imageUrl: referenceUrl,
          outputFormat: "jpeg",
          seed: 42,
        },
      }),
      [202],
    );

    expect(fal.requests).toHaveLength(1);
    expect(fal.requests[0]?.authorization).toBe(`Key ${FAL_KEY}`);
    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "restyle as watercolor",
      image_size: "landscape_4_3",
      num_images: 1,
      output_format: "jpeg",
      seed: 42,
      safety_tolerance: "4",
      enhance_prompt: false,
      image_url: referenceUrl,
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        seed: 42,
        images: [
          {
            url: "https://fal.media/flux-redux-out.jpg",
            content_type: "image/jpeg",
            width: 1536,
            height: 1024,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 80,
      billingCategory: "output_megapixel",
      billingQuantity: 2,
      sourceImageUrls: [referenceUrl],
      seed: 42,
    });
    expect(result.sourceUrl).toBeUndefined();
    expect(result.imagePromptStrength).toBeUndefined();
    expectShortArtifactPathname(result.url, ".jpg");
    await expect(readBalance(admin)).resolves.toBe(920);
  });

  it("image-io-generate-068 generates with FLUX.2 Pro and bills the first and additional output megapixels", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "fal-ai/flux-2-pro",
    });
    installStorageTracker();
    const fal = installFalSuccessFixture({
      endpointPath: "fal-ai/flux-2-pro",
      imageUrl: "https://fal.media/flux-2-pro-out.png",
      contentType: "image/png",
      billableUnits: 1.5,
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "studio product shot",
          size: "1536x1024",
          outputFormat: "png",
          seed: 42,
          safetyTolerance: "5",
        },
      }),
      [202],
    );

    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "studio product shot",
      image_size: { width: 1536, height: 1024 },
      output_format: "png",
      seed: 42,
      safety_tolerance: "5",
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        seed: 42,
        images: [
          {
            url: "https://fal.media/flux-2-pro-out.png",
            content_type: "image/png",
            width: 1536,
            height: 1024,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 45,
      model: "fal-ai/flux-2-pro",
      provider: "fal",
      billingCategory: "processed_megapixel.first",
      billingQuantity: 1,
      seed: 42,
    });
    await expect(readBalance(admin)).resolves.toBe(955);
  });

  it("image-io-generate-069 edits up to nine references with FLUX.2 Pro and uses Fal billing units", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "fal-ai/flux-2-pro",
    });
    installStorageTracker();
    const fal = installFalSuccessFixture({
      endpointPath: "fal-ai/flux-2-pro/edit",
      imageUrl: "https://fal.media/flux-2-pro-edit.png",
      contentType: "image/png",
      billableUnits: 3,
    });

    const tenUrls = Array.from({ length: 10 }, (_value, index) => {
      return `https://images.example.test/ref-${String(index + 1)}.png`;
    });
    const rejected = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "combine references",
          imageUrls: tenUrls,
        },
      }),
      [400],
    );
    expect(rejected.body.error.message).toBe(
      "imageUrls supports at most 9 images",
    );
    expect(fal.requests).toStrictEqual([]);

    const refs = [
      "https://images.example.test/ref-a.png",
      "https://images.example.test/ref-b.png",
    ];
    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "blend two scenes",
          imageUrls: refs,
          outputFormat: "png",
        },
      }),
      [202],
    );

    expect(fal.requests).toHaveLength(1);
    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "blend two scenes",
      image_size: "auto",
      output_format: "png",
      safety_tolerance: "4",
      image_urls: refs,
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        images: [
          {
            url: "https://fal.media/flux-2-pro-edit.png",
            content_type: "image/png",
            width: 1024,
            height: 1024,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 90,
      model: "fal-ai/flux-2-pro",
      sourceImageUrls: refs,
    });
    await expect(readBalance(admin)).resolves.toBe(910);
  });

  it("image-io-generate-070 maps Ideogram 4 quality to rendering speed without paid prompt expansion", async () => {
    const admin = await setupAdmin({ credits: 1000, model: "ideogram/v4" });
    installStorageTracker();
    const fal = installFalSuccessFixture({
      endpointPath: "ideogram/v4",
      imageUrl: "https://fal.media/ideogram-v4-out.png",
      contentType: "image/png",
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "editorial poster typography",
          size: "2048x1024",
          quality: "high",
          outputFormat: "png",
          seed: 17,
        },
      }),
      [202],
    );

    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "editorial poster typography",
      image_size: { width: 2048, height: 1024 },
      num_images: 1,
      output_format: "png",
      rendering_speed: "QUALITY",
      expansion_model: "None",
      seed: 17,
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        seed: 17,
        images: [
          {
            url: "https://fal.media/ideogram-v4-out.png",
            content_type: "image/png",
            width: 2048,
            height: 1024,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 50,
      model: "ideogram/v4",
      quality: "high",
      billingCategory: "output_megapixel.quality",
      billingQuantity: 2,
    });
  });

  it("image-io-generate-071 routes Ideogram 4 single-image edits and rejects multiple references", async () => {
    const admin = await setupAdmin({ credits: 1000, model: "ideogram/v4" });
    installStorageTracker();
    const fal = installFalSuccessFixture({
      endpointPath: "ideogram/v4/image-to-image",
      imageUrl: "https://fal.media/ideogram-v4-edit.png",
      contentType: "image/png",
    });

    const rejected = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "remix two images",
          imageUrls: [
            "https://images.example.test/one.png",
            "https://images.example.test/two.png",
          ],
        },
      }),
      [400],
    );
    expect(rejected.body.error.message).toBe(
      "ideogram-4 accepts one source image",
    );
    expect(fal.requests).toStrictEqual([]);

    const sourceUrl = "https://images.example.test/poster.png";
    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "clean up typography",
          imageUrl: sourceUrl,
          quality: "low",
          outputFormat: "png",
        },
      }),
      [202],
    );

    expect(fal.requests).toHaveLength(1);
    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "clean up typography",
      image_size: "auto",
      output_format: "png",
      rendering_speed: "TURBO",
      expansion_model: "None",
      image_url: sourceUrl,
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        images: [
          {
            url: "https://fal.media/ideogram-v4-edit.png",
            content_type: "image/png",
            width: 1024,
            height: 1024,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 8,
      billingCategory: "output_megapixel.turbo",
      sourceImageUrls: [sourceUrl],
    });
  });

  it("image-io-generate-073 generates Qwen Image 3 images through fal and bills the standard resolution tier", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "alibaba/qwen-image-3/text-to-image",
    });
    installStorageTracker();
    const fal = installFalSuccessFixture({
      endpointPath: "alibaba/qwen-image-3/text-to-image",
      imageUrl: "https://fal.media/qwen-1k.png",
      contentType: "image/png",
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "isometric tea house",
          size: "1024x1024",
          outputFormat: "png",
          seed: 7,
        },
      }),
      [202],
    );

    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "isometric tea house",
      image_size: { width: 1024, height: 1024 },
      num_images: 1,
      output_format: "png",
      seed: 7,
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        seed: 7,
        images: [
          {
            url: "https://fal.media/qwen-1k.png",
            content_type: "image/png",
            width: 1024,
            height: 1024,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 40,
      model: "alibaba/qwen-image-3/text-to-image",
      provider: "fal",
      billingCategory: "output_image.1k",
      billingQuantity: 1,
      privateArtifacts: true,
      seed: 7,
    });
    expectShortArtifactPathname(result.url, ".png");
    await expect(readBalance(admin)).resolves.toBe(960);
  });

  it("image-io-generate-074 bills Qwen Image 3 at the high resolution tier above 2,250,000 output pixels", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "alibaba/qwen-image-3/text-to-image",
    });
    installStorageTracker();
    const fal = installFalSuccessFixture({
      endpointPath: "alibaba/qwen-image-3/text-to-image",
      imageUrl: "https://fal.media/qwen-2k.png",
      contentType: "image/png",
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "high resolution botanical mural",
          size: "2048x2048",
        },
      }),
      [202],
    );

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        images: [
          {
            url: "https://fal.media/qwen-2k.png",
            content_type: "image/png",
            width: 2048,
            height: 2048,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 75,
      billingCategory: "output_image.2k",
      billingQuantity: 1,
    });
    await expect(readBalance(admin)).resolves.toBe(925);
  });

  it("image-io-generate-075 edits with Qwen Image 3 through fal and caps its reference images at three", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "alibaba/qwen-image-3/text-to-image",
    });
    const firstKey = "artifacts/abcdef1234.png";
    const secondKey = "artifacts/xyzabc5678.png";
    const storage = installStorageTracker({
      [firstKey]: admin.userId,
      [secondKey]: admin.userId,
    });
    const fal = installFalSuccessFixture({
      endpointPath: "alibaba/qwen-image-3/edit",
      imageUrl: "https://fal.media/qwen-edit.png",
      contentType: "image/png",
    });

    const rejected = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "too many inputs",
          imageUrls: [
            "https://images.example.test/1.png",
            "https://images.example.test/2.png",
            "https://images.example.test/3.png",
            "https://images.example.test/4.png",
          ],
        },
      }),
      [400],
    );
    expect(rejected.body).toStrictEqual({
      error: {
        message: "imageUrls supports at most 3 images",
        code: "BAD_REQUEST",
      },
    });
    expect(fal.requests).toStrictEqual([]);

    const shortResizedUrl =
      "https://a.okou.io/cdn-cgi/image/width=512/abcdef1234.png";
    const cdnArtifactUrl = "https://cdn.okou.io/artifacts/xyzabc5678.png";
    const externalUrl = "https://images.example.test/external-ref.png";
    const sourceUrls = [shortResizedUrl, cdnArtifactUrl, externalUrl];

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "combine owned and external references",
          imageUrls: sourceUrls,
        },
      }),
      [202],
    );

    expect(fal.requests).toHaveLength(1);
    expect(storage.headKeys).toStrictEqual([firstKey, secondKey]);
    expect(storage.signedKeys).toStrictEqual([firstKey, secondKey]);
    const sentUrls = fal.requests[0]?.body.image_urls;
    expect(Array.isArray(sentUrls)).toBeTruthy();
    if (!Array.isArray(sentUrls)) {
      throw new Error("Expected image_urls array sent to Fal");
    }
    expect(sentUrls).toHaveLength(3);
    expect(String(sentUrls[0])).toContain(firstKey);
    expect(String(sentUrls[1])).toContain(secondKey);
    expect(sentUrls[2]).toBe(externalUrl);

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        images: [
          {
            url: "https://fal.media/qwen-edit.png",
            content_type: "image/png",
            width: 1024,
            height: 768,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 40,
      model: "alibaba/qwen-image-3/text-to-image",
      billingCategory: "output_image.1k",
      privateArtifacts: true,
      sourceImageUrls: sourceUrls,
    });
    expectShortArtifactPathname(result.url, ".png");
    await expect(readBalance(admin)).resolves.toBe(960);
  });

  it("image-io-generate-076 generates Nano Banana 2 Lite images through fal at its fixed 1K price", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "google/nano-banana-2-lite",
    });
    installStorageTracker();
    const fal = installFalSuccessFixture({
      endpointPath: "google/nano-banana-2-lite",
      imageUrl: "https://fal.media/nano-lite.png",
      contentType: "image/png",
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "minimal ceramic mug",
          size: "1024x1024",
          outputFormat: "png",
          safetyTolerance: "5",
        },
      }),
      [202],
    );

    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "minimal ceramic mug",
      aspect_ratio: "1:1",
      num_images: 1,
      output_format: "png",
      safety_tolerance: "5",
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        images: [
          {
            url: "https://fal.media/nano-lite.png",
            content_type: "image/png",
            width: 1024,
            height: 1024,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 42,
      model: "google/nano-banana-2-lite",
      provider: "fal",
      billingCategory: "output_image",
      billingQuantity: 1,
      privateArtifacts: true,
    });
    expectShortArtifactPathname(result.url, ".png");
    await expect(readBalance(admin)).resolves.toBe(958);
  });

  it("image-io-generate-077 generates Nano Banana 2 images through fal at standard provider prices", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "fal-ai/nano-banana-2",
    });
    installStorageTracker();
    const fal = installFalSuccessFixture({
      endpointPath: "fal-ai/nano-banana-2",
      imageUrl: "https://fal.media/nano-banana-2.webp",
      contentType: "image/webp",
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "sunny lemon grove",
          size: "1024x1024",
          outputFormat: "webp",
          seed: 123,
          safetyTolerance: "5",
        },
      }),
      [202],
    );

    expect(fal.requests).toHaveLength(1);
    expect(fal.requests[0]?.authorization).toBe(`Key ${FAL_KEY}`);
    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "sunny lemon grove",
      aspect_ratio: "1:1",
      num_images: 1,
      output_format: "webp",
      resolution: "1K",
      seed: 123,
      safety_tolerance: "5",
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        seed: 123,
        images: [
          {
            url: "https://fal.media/nano-banana-2.webp",
            content_type: "image/webp",
            width: 1024,
            height: 1024,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 80,
      model: "fal-ai/nano-banana-2",
      provider: "fal",
      imageSize: "1024x1024",
      quality: "model-default",
      billingCategory: "output_image",
      billingQuantity: 1,
      privateArtifacts: true,
      seed: 123,
    });
    expect(result.sourceUrl).toBeUndefined();
    expectShortArtifactPathname(result.url, ".webp");
    await expect(readBalance(admin)).resolves.toBe(920);
  });

  it("image-io-generate-078 edits images with Nano Banana 2 through fal", async () => {
    const admin = await setupAdmin({
      credits: 1000,
      model: "fal-ai/nano-banana-2",
    });
    installStorageTracker();
    const refs = [
      "https://images.example.test/nano-ref-1.png",
      "https://images.example.test/nano-ref-2.png",
    ];
    const fal = installFalSuccessFixture({
      endpointPath: "fal-ai/nano-banana-2/edit",
      imageUrl: "https://fal.media/nano-edit.png",
      contentType: "image/png",
    });

    const accepted = await accept(
      generateClient(admin).post({
        headers,
        body: {
          prompt: "blend both scenes cleanly",
          imageUrls: refs,
        } satisfies ImageIoGenerateRequest,
      }),
      [202],
    );

    expect(fal.requests).toHaveLength(1);
    expect(fal.requests[0]?.authorization).toBe(`Key ${FAL_KEY}`);
    expect(fal.requests[0]?.body).toStrictEqual({
      prompt: "blend both scenes cleanly",
      aspect_ratio: "auto",
      num_images: 1,
      output_format: "png",
      resolution: "1K",
      safety_tolerance: "4",
      image_urls: refs,
    });

    await postFalWebhook(fal.requests[0]?.webhookUrl ?? null, {
      request_id: fal.requestId,
      status: "OK",
      payload: {
        images: [
          {
            url: "https://fal.media/nano-edit.png",
            content_type: "image/png",
            width: 1536,
            height: 1024,
          },
        ],
      },
    });

    const result = parseCompletedResult(
      await readGeneration(admin, accepted.body.generationId),
    );
    expect(result).toMatchObject({
      creditsCharged: 80,
      imageSize: "1536x1024",
      quality: "model-default",
      billingCategory: "output_image",
      privateArtifacts: true,
      sourceImageUrls: refs,
    });
    expect(result.sourceUrl).toBeUndefined();
    expectShortArtifactPathname(result.url, ".png");
    await expect(readBalance(admin)).resolves.toBe(920);
  });

  it("image-io-generate-079 records a failed job when fal image generation fails", async () => {
    const admin = await setupAdmin({ credits: 1000, model: "gpt-image-1" });
    const storage = installStorageTracker();
    const captured: CapturedFalRequest[] = [];
    server.use(
      http.post(
        "https://queue.fal.run/fal-ai/gpt-image-1/text-to-image",
        async ({ request }) => {
          const parsedUrl = new URL(request.url);
          captured.push({
            url: request.url,
            pathname: parsedUrl.pathname,
            webhookUrl: parsedUrl.searchParams.get("fal_webhook"),
            authorization: request.headers.get("authorization"),
            body: (await request.json()) as Record<string, unknown>,
          });
          return HttpResponse.text("rate limit exceeded", { status: 429 });
        },
      ),
    );

    const response = await accept(
      generateClient(admin).post({
        headers,
        body: { prompt: "a cat" },
      }),
      [502],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Image generation failed",
        code: "FAL_IMAGE_REQUEST_FAILED",
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.authorization).toBe(`Key ${FAL_KEY}`);
    expect(captured[0]?.body).toStrictEqual({
      prompt: "a cat",
      image_size: "1024x1024",
      num_images: 1,
      output_format: "png",
      quality: "medium",
      background: "auto",
      openai_api_key: OPENAI_KEY,
    });

    const failedEvent = readRealtimeGenerationEvents().find((entry) => {
      return entry.payload.status === "failed";
    });
    const generationId =
      typeof failedEvent?.payload.generationId === "string"
        ? failedEvent.payload.generationId
        : undefined;
    if (!generationId) {
      throw new Error("Expected failed realtime event with generationId");
    }
    expect(failedEvent?.payload).toMatchObject({
      generationId,
      status: "failed",
      error: {
        message: "Image generation failed",
        code: "FAL_IMAGE_REQUEST_FAILED",
      },
    });

    const job = await readGeneration(admin, generationId);
    expect(job).toMatchObject({
      generationId,
      status: "failed",
      error: {
        message: "Image generation failed",
        code: "FAL_IMAGE_REQUEST_FAILED",
      },
    });
    expect(storage.putKeys).toStrictEqual([]);
    await expect(readBalance(admin)).resolves.toBe(1000);
  });
});
