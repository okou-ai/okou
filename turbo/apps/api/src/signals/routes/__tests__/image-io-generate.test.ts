import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  buildArtifactKeyV2,
  buildFileUrlFromKey,
  OKOU_CDN_ARTIFACTS_ORIGIN,
  OKOU_SHORT_ARTIFACTS_ORIGIN,
} from "../../../lib/file-url";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createDeferredPromise } from "../../utils";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { usageRecordRoutes } from "../usage-record";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingKey,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { seedCompose$, seedRun$ } from "./helpers/usage-state";
import {
  generatedStripeCustomerId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import { createRouteMocks } from "./helpers/route-test";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { setRunImageModelFixture } from "../../../test-fixtures/run-image-model";
import { removeBuiltInGenerationPublicBrandFixture } from "../../../test-fixtures/built-in-generation";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedBuiltInDefaultModelKey } from "./helpers/runtime-state";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const TEST_BUCKET = "test-user-artifacts";
const IMAGE_BYTES = Buffer.from("fake image bytes");
const IMAGE_IO_MODEL = "gpt-image-1";
const FAL_GPT_IMAGE_1_URL =
  "https://queue.fal.run/fal-ai/gpt-image-1/text-to-image";
const FAL_GPT_IMAGE_2_URL = "https://queue.fal.run/openai/gpt-image-2";
const OPENAI_IMAGE_GENERATIONS_URL =
  "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";
const BYTEPLUS_IMAGE_GENERATIONS_URL =
  "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";
const BYTEPLUS_SEEDREAM_5_LITE_MEDIA_URL =
  "https://ark-content.byteplus.example/files/seedream-5-lite.png";
const BYTEPLUS_SEEDREAM_5_PRO_LOW_MEDIA_URL =
  "https://ark-content.byteplus.example/files/seedream-5-pro-low.jpg";
const BYTEPLUS_SEEDREAM_5_PRO_HIGH_MEDIA_URL =
  "https://ark-content.byteplus.example/files/seedream-5-pro-high.jpg";
const FAL_GPT_MEDIA_URL = "https://fal.media/files/test/gpt-image-1.webp";
const FAL_OUTPUT_SAFETY_FILTER_MESSAGE =
  "The generated image was blocked by the safety filter.";
const FAL_INPUT_SAFETY_FILTER_MESSAGE =
  "The content could not be processed because it contained material flagged by a content checker.";
const FAL_INPUT_MEDIA_DOWNLOAD_MESSAGE =
  "Failed to download the file. Please check if the URL is accessible and try again.";
const FAL_INPUT_MEDIA_LOAD_MESSAGE =
  "Failed to load the image. Please ensure the image file is not corrupted and is in a supported format.";
const FAL_INVALID_REQUEST_MESSAGE =
  "Could not generate images with the given prompts and images. Please try again with different inputs.";
const FAL_INVALID_ASPECT_RATIO_MESSAGE =
  "Input should be 'auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1' or '1:8'";
const OPENAI_PRIVATE_PROVIDER_REQUEST_ID =
  "req_private0openai0request0identifier";
const OPENAI_PRIVATE_PROVIDER_MESSAGE = `Invalid image file or mode for image 1, please check your image file. If you believe this is an error, contact us at help.openai.com and include the request ID ${OPENAI_PRIVATE_PROVIDER_REQUEST_ID}.`;
const FAL_QWEN_IMAGE_URL = "https://queue.fal.run/fal-ai/qwen-image";
const FAL_MEDIA_URL = "https://fal.media/files/test/qwen.jpg";
const FAL_FLUX_REDUX_URL = "https://queue.fal.run/fal-ai/flux-pro/v1.1/redux";
const FAL_FLUX_MEDIA_URL = "https://fal.media/files/test/flux-redux.jpg";
const FAL_FLUX_2_PRO_URL = "https://queue.fal.run/fal-ai/flux-2-pro";
const FAL_FLUX_2_PRO_EDIT_URL = "https://queue.fal.run/fal-ai/flux-2-pro/edit";
const FAL_FLUX_2_PRO_MEDIA_URL = "https://fal.media/files/test/flux-2-pro.png";
const FAL_QWEN_IMAGE_3_URL =
  "https://queue.fal.run/alibaba/qwen-image-3/text-to-image";
const FAL_QWEN_IMAGE_3_EDIT_URL =
  "https://queue.fal.run/alibaba/qwen-image-3/edit";
const FAL_QWEN_IMAGE_3_MEDIA_URL =
  "https://fal.media/files/test/qwen-image-3.png";
const FAL_IDEOGRAM_4_URL = "https://queue.fal.run/ideogram/v4";
const FAL_IDEOGRAM_4_EDIT_URL =
  "https://queue.fal.run/ideogram/v4/image-to-image";
const FAL_IDEOGRAM_4_MEDIA_URL = "https://fal.media/files/test/ideogram-4.png";
const FAL_NANO_BANANA_2_URL = "https://queue.fal.run/fal-ai/nano-banana-2";
const FAL_NANO_BANANA_2_LITE_URL =
  "https://queue.fal.run/google/nano-banana-2-lite";
const FAL_NANO_BANANA_2_LITE_MEDIA_URL =
  "https://fal.media/files/test/nano-banana-2-lite.png";
const FAL_NANO_BANANA_2_EDIT_URL =
  "https://queue.fal.run/fal-ai/nano-banana-2/edit";
const FAL_NANO_BANANA_2_MEDIA_URL =
  "https://fal.media/files/test/nano-banana-2.webp";
const FAL_BIREFNET_URL = "https://queue.fal.run/fal-ai/birefnet/v2";
const FAL_BIREFNET_MEDIA_URL = "https://fal.media/files/test/birefnet.png";
const FAL_CLARITY_UPSCALER_URL =
  "https://queue.fal.run/fal-ai/clarity-upscaler";
const FAL_CLARITY_UPSCALER_MEDIA_URL =
  "https://fal.media/files/test/clarity-upscaler.png";
const MOCKUP_IMAGE_URL = "https://example.com/mockup.png";
const SECOND_MOCKUP_IMAGE_URL = "https://example.com/mockup-2.png";
const THIRD_MOCKUP_IMAGE_URL = "https://example.com/mockup-3.png";
const IMAGE_PRICING_MARKUP_MULTIPLIER = 1.2;
const FAL_FLUX_PROVIDER_CREDITS_PER_MEGAPIXEL = 40;
const FAL_FLUX_MARKED_UP_CREDITS_PER_MEGAPIXEL = Math.ceil(
  FAL_FLUX_PROVIDER_CREDITS_PER_MEGAPIXEL * IMAGE_PRICING_MARKUP_MULTIPLIER,
);
const FAL_NANO_BANANA_2_PROVIDER_CREDITS_PER_IMAGE = 80;
const FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE = Math.ceil(
  FAL_NANO_BANANA_2_PROVIDER_CREDITS_PER_IMAGE *
    IMAGE_PRICING_MARKUP_MULTIPLIER,
);
// $0.042 per fixed-1K image, marked up and rounded as the seeded price is.
const FAL_NANO_BANANA_2_LITE_CREDITS_PER_IMAGE = Math.round(
  42 * IMAGE_PRICING_MARKUP_MULTIPLIER,
);
// $0.04 up to 2,250,000 output pixels, $0.075 above it.
const FAL_QWEN_IMAGE_3_STANDARD_TIER_CREDITS = Math.round(
  40 * IMAGE_PRICING_MARKUP_MULTIPLIER,
);
const FAL_QWEN_IMAGE_3_HIGH_TIER_CREDITS = Math.round(
  75 * IMAGE_PRICING_MARKUP_MULTIPLIER,
);
const FAL_FLUX_2_PRO_FIRST_MEGAPIXEL_CREDITS = 36;
const FAL_FLUX_2_PRO_ADDITIONAL_MEGAPIXEL_CREDITS = 18;
const FAL_IDEOGRAM_4_TURBO_MEGAPIXEL_CREDITS = 9;
const FAL_IDEOGRAM_4_BALANCED_MEGAPIXEL_CREDITS = 18;
const FAL_IDEOGRAM_4_QUALITY_MEGAPIXEL_CREDITS = 30;
const API_ORIGIN = "https://api.okou.test";
const WEB_ORIGIN = "https://www.okou.test";
const MISSING_PRICING_IMAGE_MODEL = "gpt-image-2";
const IMAGE_PRICING_CATEGORIES = [
  "output_image.low.standard",
  "output_image.low.large",
  "output_image.medium.standard",
  "output_image.medium.large",
  "output_image.high.standard",
  "output_image.high.large",
] as const;
const GPT_IMAGE_2_5_MODELS = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;
const GPT_IMAGE_2_5_PRICING = GPT_IMAGE_2_5_MODELS.flatMap((provider) => {
  return [
    { category: "tokens.input.text", unitPrice: 6000 },
    { category: "tokens.input.image", unitPrice: 9600 },
    { category: "tokens.output.image", unitPrice: 36_000 },
  ].map((row) => {
    return { ...row, kind: "image", provider, unitSize: 1_000_000 };
  });
}) satisfies readonly UsagePricingRow[];

const tokenRequest = Object.freeze({
  keyName: "test-key",
  timestamp: 1_700_000_000_000,
  capability: '{"user:test-user":["subscribe"]}',
  clientId: "test-user",
  nonce: "test-nonce",
  mac: "test-mac",
});

// Recovers the generation ID for a synchronously failed submission from its
// realtime failure publish (`built-in-generation:{id}`), the product-visible
// signal a client would use.
function readPublishedGenerationId(
  publishCalls: readonly (readonly unknown[])[],
): string {
  for (const call of publishCalls) {
    const eventName = call[0];
    if (
      typeof eventName === "string" &&
      eventName.startsWith("built-in-generation:")
    ) {
      return eventName.slice("built-in-generation:".length);
    }
  }
  throw new Error("Expected a built-in-generation publish");
}

interface ImageFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface AdmittedImageFixture extends ImageFixture {
  readonly actor: ApiTestUser;
  readonly runId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createImageIoTestApp(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...builtInGenerationRoutes,
      ...imageIoGenerateRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
      ...usageRecordRoutes,
    ],
    usagePricingResolution,
  });
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function putObjectInput(): PutObjectCommandInput {
  const command = context.mocks.s3.send.mock.calls
    .map(([candidate]) => {
      return candidate;
    })
    .find((candidate): candidate is PutObjectCommand => {
      return (
        candidate instanceof PutObjectCommand &&
        (candidate.input.Key?.startsWith("artifacts/") === true ||
          candidate.input.Key?.startsWith("private-artifacts/") === true)
      );
    });
  if (!command) {
    throw new Error("Expected generated image to be uploaded to S3");
  }
  return command.input;
}

// Reads the org credit balance through the product billing surface so charge
// assertions stay on externally observable state.
async function orgCredits(fixture: ImageFixture): Promise<number> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const app = createImageIoTestApp();
  const response = await app.request("/api/billing/status", {
    headers: authHeaders(),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("credits" in body) ||
    typeof body.credits !== "number"
  ) {
    throw new Error("Expected billing status credits");
  }
  return body.credits;
}

function falResponseUrl(requestId: string): string {
  return `https://queue.fal.run/test/requests/${requestId}/response`;
}

function falQueueHandle(requestId: string): Record<string, string> {
  return {
    request_id: requestId,
    status_url: `https://queue.fal.run/test/requests/${requestId}/status`,
    response_url: falResponseUrl(requestId),
  };
}

function readWebhookUrl(requestUrl: string | null): string {
  if (requestUrl) {
    const webhookUrl = new URL(requestUrl).searchParams.get("fal_webhook");
    if (webhookUrl) {
      return webhookUrl;
    }
  }
  throw new Error("Expected Fal request fal_webhook query parameter");
}

async function postFalWebhook(
  app: ReturnType<typeof createImageIoTestApp>,
  requestUrl: string | null,
  payload: unknown,
): Promise<void> {
  await postFalWebhookEnvelope(app, requestUrl, {
    status: "COMPLETED",
    payload,
  });
}

async function postFalWebhookEnvelope(
  app: ReturnType<typeof createImageIoTestApp>,
  requestUrl: string | null,
  body: Record<string, unknown>,
): Promise<void> {
  const url = new URL(readWebhookUrl(requestUrl));
  const response = await app.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

function readAcceptedGenerationId(
  body: unknown,
  type: "image",
  userId: string,
): string {
  if (
    typeof body !== "object" ||
    body === null ||
    !("generationId" in body) ||
    typeof body.generationId !== "string"
  ) {
    throw new Error("Expected accepted generation response");
  }
  expect(body).toMatchObject({
    generationId: body.generationId,
    type,
    status: "queued",
    realtime: {
      channelName: `user:${userId}`,
      eventName: `built-in-generation:${body.generationId}`,
      tokenRequest,
    },
  });
  return body.generationId;
}

function readGenerationResult(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "result" in body) {
    return body.result;
  }
  throw new Error("Expected completed generation result");
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities?: readonly "file:write"[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: args.capabilities ?? ["file:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

const GPT_IMAGE_1_PRICING = [
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.low.standard",
    unitPrice: 13,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.low.large",
    unitPrice: 19,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.medium.standard",
    unitPrice: 50,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.medium.large",
    unitPrice: 76,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.high.standard",
    unitPrice: 200,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.high.large",
    unitPrice: 300,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const QWEN_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/qwen-image",
    category: "output_megapixel",
    unitPrice: 24,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const SEEDREAM_5_LITE_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "seedream-5-0-lite-260128",
    category: "provider_cost_usd_micros",
    unitPrice: 1250,
    unitSize: 1_000_000,
  },
] satisfies readonly UsagePricingRow[];

const SEEDREAM_5_PRO_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "dola-seedream-5-0-pro-260628",
    category: "provider_cost_usd_micros",
    unitPrice: 1250,
    unitSize: 1_000_000,
  },
] satisfies readonly UsagePricingRow[];

const FLUX_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/flux-pro/v1.1",
    category: "output_megapixel",
    unitPrice: FAL_FLUX_MARKED_UP_CREDITS_PER_MEGAPIXEL,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const FLUX_2_PRO_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/flux-2-pro",
    category: "processed_megapixel.first",
    unitPrice: FAL_FLUX_2_PRO_FIRST_MEGAPIXEL_CREDITS,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: "fal-ai/flux-2-pro",
    category: "processed_megapixel.additional",
    unitPrice: FAL_FLUX_2_PRO_ADDITIONAL_MEGAPIXEL_CREDITS,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const IDEOGRAM_4_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "ideogram/v4",
    category: "output_megapixel.turbo",
    unitPrice: FAL_IDEOGRAM_4_TURBO_MEGAPIXEL_CREDITS,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: "ideogram/v4",
    category: "output_megapixel.balanced",
    unitPrice: FAL_IDEOGRAM_4_BALANCED_MEGAPIXEL_CREDITS,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: "ideogram/v4",
    category: "output_megapixel.quality",
    unitPrice: FAL_IDEOGRAM_4_QUALITY_MEGAPIXEL_CREDITS,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const NANO_BANANA_2_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/nano-banana-2",
    category: "output_image",
    unitPrice: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const NANO_BANANA_2_LITE_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "google/nano-banana-2-lite",
    category: "output_image",
    unitPrice: FAL_NANO_BANANA_2_LITE_CREDITS_PER_IMAGE,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const QWEN_IMAGE_3_PRICING = [
  {
    kind: "image",
    provider: "alibaba/qwen-image-3/text-to-image",
    category: "output_image.1k",
    unitPrice: FAL_QWEN_IMAGE_3_STANDARD_TIER_CREDITS,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: "alibaba/qwen-image-3/text-to-image",
    category: "output_image.2k",
    unitPrice: FAL_QWEN_IMAGE_3_HIGH_TIER_CREDITS,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const BIREFNET_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/birefnet/v2",
    category: "output_image",
    unitPrice: 0,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const CLARITY_UPSCALER_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/clarity-upscaler",
    category: "output_megapixel",
    unitPrice: 30,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const MISSING_GPT_IMAGE_2_PRICING: readonly UsagePricingKey[] =
  IMAGE_PRICING_CATEGORIES.map((category) => {
    return {
      kind: "image",
      provider: MISSING_PRICING_IMAGE_MODEL,
      category,
    };
  });

async function createScopedImagePricing(options: {
  readonly configured?: readonly UsagePricingRow[];
  readonly missing?: readonly UsagePricingKey[];
}): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture(options);
  onTestFinished(async () => {
    await fixture.cleanup();
  });
  return fixture;
}

// Isolation comes from random org/user IDs; no teardown is needed.
async function seedImageFixture(options: {
  readonly credits?: number;
}): Promise<ImageFixture> {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };

  await seedOrgMetadata({
    orgId: fixture.orgId,
    tier: "free",
    credits: options.credits ?? 10_000,
  });
  await store.set(
    seedOrgMembership$,
    { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
    context.signal,
  );

  return fixture;
}

async function seedAdmittedImageRun(): Promise<AdmittedImageFixture> {
  await seedBuiltInDefaultModelKey(context);
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Image tests require an organization");
  }
  bdd.acceptAgentStorageWrites();
  runs.configureRunnerGroup();
  const completed = await bdd.completeOnboarding(actor);
  expect(completed.status).toBe(200);
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 1 });
  const agent = await bdd.createAgent(actor, {
    displayName: "Admitted image agent",
    visibility: "private",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "Generate after credit exhaustion",
    modelProvider: "built-in",
  });
  return {
    actor,
    orgId: actor.orgId,
    userId: actor.userId,
    runId: run.runId,
  };
}

async function seedImageRun(
  fixture: ImageFixture,
  options: {
    readonly selectedImageModel: string | null;
  },
): Promise<{ readonly runId: string }> {
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId,
      triggerSource: "web",
    },
    context.signal,
  );
  await setRunImageModelFixture(runId, options.selectedImageModel);
  return { runId };
}

describe("POST /api/image-io/generate", () => {
  let releasePendingFalResponse: (() => void) | null = null;

  beforeEach(() => {
    mockEnv("OKOU_API_BACKEND_URL", WEB_ORIGIN);
    mockEnv("OKOU_WEB_URL", WEB_ORIGIN);
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.ably.publish.mockReset();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  });

  afterEach(async () => {
    releasePendingFalResponse?.();
    releasePendingFalResponse = null;
    clearMockNow();
    await flushWaitUntilForTest();
  });

  it("returns 401 when not authenticated", async () => {
    const app = createImageIoTestApp();
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when an agent token lacks file write capability", async () => {
    const token = okouToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: randomUUID(),
      capabilities: [],
    });

    const app = createImageIoTestApp();
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Missing required capability: file:write",
        code: "FORBIDDEN",
      },
    });
  });

  it("rejects empty prompts before provider generation", async () => {
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        falCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "   " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "prompt is required", code: "BAD_REQUEST" },
    });
    expect(falCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(10_000);
  });

  it("rejects transparent background requests before provider generation", async () => {
    const fixture = await seedImageFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledFal = false;
    server.use(
      http.post(FAL_GPT_IMAGE_2_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp();
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a transparent badge",
        model: "gpt-image-2",
        background: "transparent",
        outputFormat: "webp",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "gpt-image-2 does not support transparent backgrounds",
        code: "BAD_REQUEST",
      },
    });
    expect(calledFal).toBeFalsy();
  });

  it.each([
    { model: "gpt-image-2.5-flare", quality: "xhigh", editing: false },
    { model: "gpt-image-2.5-sunburst", quality: "max", editing: true },
  ])(
    "generates $model images through OpenAI and bills actual tokens",
    async ({ model, quality, editing }) => {
      const fixture = await seedImageFixture({ credits: 1000 });
      const pricingFixture = await createScopedImagePricing({
        configured: GPT_IMAGE_2_5_PRICING,
      });
      mocks.clerk.session(fixture.userId, fixture.orgId);
      let observedBody: unknown;
      let observedAuthorization: string | null = null;
      server.use(
        http.post(
          editing ? OPENAI_IMAGE_EDITS_URL : OPENAI_IMAGE_GENERATIONS_URL,
          async ({ request }) => {
            observedBody = await request.json();
            observedAuthorization = request.headers.get("authorization");
            return HttpResponse.json({
              created: currentSecond(),
              data: [{ b64_json: IMAGE_BYTES.toString("base64") }],
              size: "1536x1024",
              quality,
              background: "transparent",
              output_format: "webp",
              usage: {
                input_tokens: editing ? 1700 : 200,
                input_tokens_details: {
                  text_tokens: 200,
                  image_tokens: editing ? 1500 : 0,
                },
                output_tokens: editing ? 2501 : 2500,
                ...(editing
                  ? {
                      output_tokens_details: {
                        image_tokens: 2500,
                        text_tokens: 1,
                      },
                    }
                  : {}),
                total_tokens: editing ? 4201 : 2700,
              },
            });
          },
        ),
      );
      const app = createImageIoTestApp(pricingFixture.resolution);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model,
          prompt: "a product illustration",
          size: "1536x1024",
          quality,
          background: "transparent",
          outputFormat: "webp",
          outputCompression: 80,
          ...(editing
            ? {
                imageUrls: [MOCKUP_IMAGE_URL, SECOND_MOCKUP_IMAGE_URL],
                maskImageUrl: THIRD_MOCKUP_IMAGE_URL,
              }
            : {}),
        }),
      });
      expect(response.status).toBe(202);
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.userId,
      );
      await flushWaitUntilForTest();

      const status = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers: authHeaders() },
      );
      expect(status.status).toBe(200);
      const creditsCharged = editing ? 107 : 92;
      await expect(status.json()).resolves.toMatchObject({
        status: "completed",
        result: {
          model,
          provider: "openai",
          imageSize: "1536x1024",
          quality,
          background: "transparent",
          outputFormat: "webp",
          outputCompression: 80,
          contentType: "image/webp",
          size: IMAGE_BYTES.byteLength,
          creditsCharged,
          url: expect.any(String),
        },
      });
      expect(observedAuthorization).toBe("Bearer test-openai-key");
      expect(observedBody).toStrictEqual({
        model,
        prompt: "a product illustration",
        n: 1,
        size: "1536x1024",
        quality,
        background: "transparent",
        output_format: "webp",
        output_compression: 80,
        moderation: "auto",
        ...(editing
          ? {
              images: [
                { image_url: MOCKUP_IMAGE_URL },
                { image_url: SECOND_MOCKUP_IMAGE_URL },
              ],
              mask: { image_url: THIRD_MOCKUP_IMAGE_URL },
            }
          : {}),
      });
      await expect(orgCredits(fixture)).resolves.toBe(1000 - creditsCharged);
    },
  );

  it.each(GPT_IMAGE_2_5_MODELS)(
    "rejects %s before generation when pricing is missing",
    async (model) => {
      const fixture = await seedImageFixture({ credits: 1000 });
      const pricingFixture = await createScopedImagePricing({
        missing: GPT_IMAGE_2_5_PRICING.filter((row) => {
          return row.provider === model;
        }),
      });
      mocks.clerk.session(fixture.userId, fixture.orgId);
      let providerCalls = 0;
      server.use(
        http.post(OPENAI_IMAGE_GENERATIONS_URL, () => {
          providerCalls += 1;
          return HttpResponse.json({});
        }),
      );
      const app = createImageIoTestApp(pricingFixture.resolution);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ model, prompt: "a product illustration" }),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "NOT_CONFIGURED",
          message: "Image generation pricing is not configured",
        },
      });
      expect(providerCalls).toBe(0);
      await expect(orgCredits(fixture)).resolves.toBe(1000);
    },
  );

  it.each([
    {
      upstreamStatus: 200,
      responseBody: { data: [{ b64_json: IMAGE_BYTES.toString("base64") }] },
      code: "OPENAI_IMAGE_BAD_RESPONSE",
    },
    {
      upstreamStatus: 429,
      responseBody: { error: { message: "Rate limit exceeded" } },
      code: "OPENAI_IMAGE_REQUEST_FAILED",
    },
  ])(
    "fails OpenAI jobs without charging for $code",
    async ({ upstreamStatus, responseBody, code }) => {
      const fixture = await seedImageFixture({ credits: 1000 });
      const pricingFixture = await createScopedImagePricing({
        configured: GPT_IMAGE_2_5_PRICING,
      });
      mocks.clerk.session(fixture.userId, fixture.orgId);
      server.use(
        http.post(OPENAI_IMAGE_GENERATIONS_URL, () => {
          return HttpResponse.json(responseBody, { status: upstreamStatus });
        }),
      );
      const app = createImageIoTestApp(pricingFixture.resolution);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-image-2.5-flare",
          prompt: "a product illustration",
        }),
      });
      expect(response.status).toBe(202);
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.userId,
      );
      await flushWaitUntilForTest();
      const status = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers: authHeaders() },
      );
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({
        status: "failed",
        error: { code },
      });
      await expect(orgCredits(fixture)).resolves.toBe(1000);
    },
  );

  it.each([
    {
      caseName: "invalid input media",
      model: "gpt-image-2.5-sunburst",
      editing: true,
      providerErrorCode: "invalid_image_file",
      moderationDetails: undefined,
      publicError: {
        message: "An input image could not be read by the generation provider.",
        code: "GENERATION_INPUT_MEDIA_INVALID",
      },
    },
    {
      caseName: "invalid input media without references",
      model: "gpt-image-2.5-flare",
      editing: false,
      providerErrorCode: "invalid_image_file",
      moderationDetails: undefined,
      publicError: {
        message: "An input image could not be read by the generation provider.",
        code: "GENERATION_INPUT_MEDIA_INVALID",
      },
    },
    {
      caseName: "input moderation block",
      model: "gpt-image-2.5-sunburst",
      editing: true,
      providerErrorCode: "moderation_blocked",
      moderationDetails: {
        moderation_stage: "input",
        categories: ["violence"],
      },
      publicError: {
        message:
          "The prompt or reference image was blocked by the safety filter.",
        code: "GENERATION_INPUT_SAFETY_REJECTED",
      },
    },
    {
      caseName: "output moderation block",
      model: "gpt-image-2.5-flare",
      editing: false,
      providerErrorCode: "moderation_blocked",
      moderationDetails: { moderation_stage: "output", categories: ["sexual"] },
      publicError: {
        message: "The generated image was blocked by the safety filter.",
        code: "GENERATION_OUTPUT_SAFETY_BLOCKED",
      },
    },
    {
      caseName: "moderation block without a stage",
      model: "gpt-image-2.5-flare",
      editing: false,
      providerErrorCode: "moderation_blocked",
      moderationDetails: {},
      publicError: {
        message:
          "The prompt or reference image was blocked by the safety filter.",
        code: "GENERATION_INPUT_SAFETY_REJECTED",
      },
    },
  ])(
    "reports OpenAI $caseName as an expected input failure without charging",
    async ({
      model,
      editing,
      providerErrorCode,
      moderationDetails,
      publicError,
    }) => {
      const fixture = await seedImageFixture({ credits: 1000 });
      const pricingFixture = await createScopedImagePricing({
        configured: GPT_IMAGE_2_5_PRICING,
      });
      mocks.clerk.session(fixture.userId, fixture.orgId);
      server.use(
        http.post(
          editing ? OPENAI_IMAGE_EDITS_URL : OPENAI_IMAGE_GENERATIONS_URL,
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: OPENAI_PRIVATE_PROVIDER_MESSAGE,
                  type: "image_generation_user_error",
                  param: null,
                  code: providerErrorCode,
                  ...(moderationDetails
                    ? { moderation_details: moderationDetails }
                    : {}),
                },
              },
              { status: 400 },
            );
          },
        ),
      );

      const app = createImageIoTestApp(pricingFixture.resolution);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model,
          prompt: "a product illustration",
          ...(editing ? { imageUrls: [MOCKUP_IMAGE_URL] } : {}),
        }),
      });
      expect(response.status).toBe(202);
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.userId,
      );
      await flushWaitUntilForTest();

      const status = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers: authHeaders() },
      );
      expect(status.status).toBe(200);
      const statusBody: unknown = await status.json();
      expect(statusBody).toMatchObject({
        status: "failed",
        error: publicError,
      });
      await expect(orgCredits(fixture)).resolves.toBe(1000);

      const publicSurfaces = JSON.stringify(statusBody);
      for (const privateValue of [
        OPENAI_PRIVATE_PROVIDER_MESSAGE,
        OPENAI_PRIVATE_PROVIDER_REQUEST_ID,
        "a product illustration",
        MOCKUP_IMAGE_URL,
      ]) {
        expect(publicSurfaces).not.toContain(privateValue);
      }
    },
  );

  it.each([
    {
      caseName: "rate limiting",
      upstreamStatus: 429,
      responseBody: {
        error: {
          message: OPENAI_PRIVATE_PROVIDER_MESSAGE,
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
    },
    {
      caseName: "provider faults",
      upstreamStatus: 500,
      responseBody: {
        error: {
          message: OPENAI_PRIVATE_PROVIDER_MESSAGE,
          type: "server_error",
          code: "internal_error",
        },
      },
    },
    {
      caseName: "authentication failures",
      upstreamStatus: 401,
      responseBody: {
        error: {
          message: OPENAI_PRIVATE_PROVIDER_MESSAGE,
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      },
    },
    {
      caseName: "non-user request errors",
      upstreamStatus: 400,
      responseBody: {
        error: {
          message: OPENAI_PRIVATE_PROVIDER_MESSAGE,
          type: "invalid_request_error",
          code: "unknown_parameter",
        },
      },
    },
    {
      caseName: "unrecognized user error codes",
      upstreamStatus: 400,
      responseBody: {
        error: {
          message: OPENAI_PRIVATE_PROVIDER_MESSAGE,
          type: "image_generation_user_error",
          code: "some_future_code",
        },
      },
    },
    {
      caseName: "unparseable error bodies",
      upstreamStatus: 400,
      responseBody: "not json at all",
    },
  ])(
    "keeps OpenAI $caseName an unexpected provider failure",
    async ({ upstreamStatus, responseBody }) => {
      const fixture = await seedImageFixture({ credits: 1000 });
      const pricingFixture = await createScopedImagePricing({
        configured: GPT_IMAGE_2_5_PRICING,
      });
      mocks.clerk.session(fixture.userId, fixture.orgId);
      server.use(
        http.post(OPENAI_IMAGE_EDITS_URL, () => {
          return typeof responseBody === "string"
            ? new HttpResponse(responseBody, { status: upstreamStatus })
            : HttpResponse.json(responseBody, { status: upstreamStatus });
        }),
      );

      const app = createImageIoTestApp(pricingFixture.resolution);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-image-2.5-sunburst",
          prompt: "a product illustration",
          imageUrls: [MOCKUP_IMAGE_URL],
        }),
      });
      expect(response.status).toBe(202);
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.userId,
      );
      await flushWaitUntilForTest();

      const status = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers: authHeaders() },
      );
      expect(status.status).toBe(200);
      const statusBody: unknown = await status.json();
      expect(statusBody).toMatchObject({
        status: "failed",
        error: {
          message: "Image generation failed",
          code: "OPENAI_IMAGE_REQUEST_FAILED",
        },
      });
      await expect(orgCredits(fixture)).resolves.toBe(1000);
      expect(JSON.stringify(statusBody)).not.toContain(
        OPENAI_PRIVATE_PROVIDER_MESSAGE,
      );
    },
  );

  it("keeps GPT Image 2 limited to its supported quality levels", async () => {
    const fixture = await seedImageFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await createImageIoTestApp().request(
      "/api/image-io/generate",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: "a product illustration",
          quality: "xhigh",
        }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Unsupported image quality: xhigh",
      },
    });
  });

  it("uses the stable run snapshot for omitted and blank models", async () => {
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: QWEN_IMAGE_PRICING,
    });
    const { runId } = await seedImageRun(fixture, {
      selectedImageModel: "fal-ai/qwen-image",
    });

    let falCalls = 0;
    server.use(
      http.post(FAL_QWEN_IMAGE_URL, () => {
        falCalls += 1;
        return HttpResponse.json(falQueueHandle(`run-default-${falCalls}`));
      }),
    );
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createImageIoTestApp(pricingFixture.resolution);
    const prompts = ["omitted model prompt", "blank model prompt"];

    for (const [index, prompt] of prompts.entries()) {
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt,
          ...(index === 0 ? {} : { model: "   " }),
        }),
      });
      expect(response.status).toBe(202);
    }

    expect(falCalls).toBe(2);
  });

  it("preserves a valid explicit model and rejects an invalid explicit model", async () => {
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: [...GPT_IMAGE_1_PRICING, ...QWEN_IMAGE_PRICING],
    });
    const { runId } = await seedImageRun(fixture, {
      selectedImageModel: "fal-ai/qwen-image",
    });
    let gptCalls = 0;
    let qwenCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        gptCalls += 1;
        return HttpResponse.json(falQueueHandle("explicit-gpt-image-1"));
      }),
      http.post(FAL_QWEN_IMAGE_URL, () => {
        qwenCalls += 1;
        return HttpResponse.json(falQueueHandle("unexpected-qwen"));
      }),
    );
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createImageIoTestApp(pricingFixture.resolution);

    const explicitResponse = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "explicit model parameters use the explicit model",
        model: "gpt-image-1",
        background: "transparent",
        outputFormat: "webp",
      }),
    });
    expect(explicitResponse.status).toBe(202);
    expect(gptCalls).toBe(1);
    expect(qwenCalls).toBe(0);

    const unsupportedModels = [
      "not-a-real-image-model",
      "flux2-pro",
      "ideogram-v4",
    ] as const;
    const invalidResponses = await Promise.all(
      unsupportedModels.map((model) => {
        return app.request("/api/image-io/generate", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt: "invalid explicit model must not fall back",
            model,
          }),
        });
      }),
    );
    expect(
      invalidResponses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([400, 400, 400]);
    const invalidBodies = await Promise.all(
      invalidResponses.map((response) => {
        return response.json();
      }),
    );
    expect(invalidBodies).toMatchObject([
      {
        error: {
          message: expect.stringContaining(
            "Unsupported image model: not-a-real-image-model",
          ),
          code: "BAD_REQUEST",
        },
      },
      {
        error: {
          message: expect.stringContaining(
            "Unsupported image model: flux2-pro",
          ),
          code: "BAD_REQUEST",
        },
      },
      {
        error: {
          message: expect.stringContaining(
            "Unsupported image model: ideogram-v4",
          ),
          code: "BAD_REQUEST",
        },
      },
    ]);
    expect(gptCalls).toBe(1);
    expect(qwenCalls).toBe(0);
  });

  it("keeps the global default for null, old, and session paths", async () => {
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    let gptCalls = 0;
    let qwenCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        gptCalls += 1;
        return HttpResponse.json(falQueueHandle(`global-default-${gptCalls}`));
      }),
      http.post(FAL_QWEN_IMAGE_URL, () => {
        qwenCalls += 1;
        return HttpResponse.json(falQueueHandle("unexpected-run-default"));
      }),
    );
    const app = createImageIoTestApp(pricingFixture.resolution);

    const runCases = [
      {
        selectedImageModel: null,
        prompt: "null snapshot",
      },
      {
        selectedImageModel: "fal-ai/retired-image-model",
        prompt: "old snapshot",
      },
    ] as const;
    for (const runCase of runCases) {
      const fixture = await seedImageFixture({});
      const { runId } = await seedImageRun(fixture, runCase);
      const token = okouToken({
        userId: fixture.userId,
        orgId: fixture.orgId,
        runId,
      });
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: runCase.prompt }),
      });
      expect(response.status).toBe(202);
    }

    const sessionFixture = await seedImageFixture({});
    mocks.clerk.session(sessionFixture.userId, sessionFixture.orgId);
    const sessionResponse = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "session request without a run" }),
    });
    expect(sessionResponse.status).toBe(202);

    expect(gptCalls).toBe(3);
    expect(qwenCalls).toBe(0);
  });

  it("returns 402 when the org has no spendable credits", async () => {
    const fixture = await seedImageFixture({ credits: 0 });
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        falCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
    expect(falCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(0);
  });

  it("settles admitted provider work after the run becomes terminal", async () => {
    const fixture = await seedAdmittedImageRun();
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    await seedOrgMetadata({ orgId: fixture.orgId, tier: "pro", credits: 0 });
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, ({ request }) => {
        observedRequestUrl = request.url;
        return HttpResponse.json(
          falQueueHandle("admitted-terminal-image-request"),
        );
      }),
      http.get(FAL_GPT_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );
    const token = okouToken(fixture);
    const app = createImageIoTestApp(pricingFixture.resolution);

    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: "an admitted terminal run image" }),
    });
    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    const runs = createRunsApi(context);
    await runs.requestCancelRun(fixture.actor, fixture.runId, [200]);
    await expect(
      runs.readRun(fixture.actor, fixture.runId),
    ).resolves.toMatchObject({ status: "cancelled" });
    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_GPT_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/png",
        },
      ],
      prompt: "An admitted terminal run image.",
    });
    await flushWaitUntilForTest();

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      creditsCharged: 50,
      billingCategory: "output_image.medium.standard",
    });
    await expect(orgCredits(fixture)).resolves.toBe(-50);
  });

  it("uses allowance for a legacy runless generation under shared debt", async () => {
    const fixture = await seedImageFixture({ credits: -100 });
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    const effectiveAt = nowDate();
    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      customerId: generatedStripeCustomerId(),
      subscriptionId: `sub_image_debt_allowance_${randomUUID()}`,
      effectiveAt,
      expiresAt: new Date(effectiveAt.getTime() + 365 * 24 * 60 * 60 * 1000),
      shortWindowSeconds: 5 * 60 * 60,
      shortWindowUnits: 100,
      weeklyWindowSeconds: 7 * 24 * 60 * 60,
      weeklyWindowUnits: 200,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        observedRequestUrl = request.url;
        return HttpResponse.json(falQueueHandle("allowance-image-request"));
      }),
      http.get(FAL_GPT_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a cat covered by allowance" }),
    });

    expect(response.status).toBe(202);
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "a cat covered by allowance",
      image_size: "1024x1024",
      num_images: 1,
      output_format: "png",
      quality: "medium",
      background: "auto",
      openai_api_key: "test-openai-key",
    });

    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    // A persisted job without brand metadata retains its historical CDN identity.
    await removeBuiltInGenerationPublicBrandFixture(generationId);
    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_GPT_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/png",
        },
      ],
      prompt: "A cat covered by allowance.",
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const result = readGenerationResult(await statusResponse.json());
    expect(result).toMatchObject({
      creditsCharged: 50,
      billingCategory: "output_image.medium.standard",
      billingQuantity: 1,
      url: expect.stringMatching(/^https:\/\/cdn\.vm7\.io\/artifacts\//u),
    });
    expect(putObjectInput().Metadata).toMatchObject({
      "public-brand": "vm0",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const billingStatus = await accept(
      setupApp({ context, routes: billingStatusRoutes })(
        billingStatusContract,
      ).get({ headers: authHeaders() }),
      [200],
    );
    expect(billingStatus.body.credits).toBe(-100);
    expect(
      Object.fromEntries(
        billingStatus.body.usageAllowance?.windows.map((window) => {
          return [window.kind, window.consumedUnits];
        }) ?? [],
      ),
    ).toStrictEqual({ short: 50, weekly: 50 });
  });

  it("returns 503 when image pricing is not configured", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      missing: MISSING_GPT_IMAGE_2_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_2_URL, () => {
        falCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a cat",
        model: MISSING_PRICING_IMAGE_MODEL,
      }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Image generation pricing is not configured",
        code: "NOT_CONFIGURED",
      },
    });
    expect(falCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("limits run-scoped agent token image generations after three active built-ins", async () => {
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
      },
      context.signal,
    );
    // Occupy all three in-flight slots through the product flow: submit
    // generations that stay pending because the provider webhook never fires.
    let falCalls = 0;
    const observedAuthorizations: (string | null)[] = [];
    const observedBodies: unknown[] = [];
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorizations.push(request.headers.get("authorization"));
        observedBodies.push(await request.json());
        return HttpResponse.json(falQueueHandle(`pending-image-${falCalls}`));
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createImageIoTestApp(pricingFixture.resolution);
    for (let submission = 0; submission < 3; submission++) {
      const submitted = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: `a pending run image ${submission}` }),
      });
      expect(submitted.status).toBe(202);
    }
    expect(falCalls).toBe(3);

    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: "a limited run image" }),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "This run already has 3 built-in generations in progress, which is the limit. Keep at most 3 in flight and start the next one only after an earlier one finishes.",
        code: "BUILT_IN_RUN_CONCURRENCY_LIMIT",
      },
    });
    expect(falCalls).toBe(3);
    expect(observedAuthorizations).toStrictEqual([
      "Key test-fal-key",
      "Key test-fal-key",
      "Key test-fal-key",
    ]);
    expect(observedBodies).toStrictEqual(
      [0, 1, 2].map((submission) => {
        return {
          prompt: `a pending run image ${submission}`,
          image_size: "1024x1024",
          num_images: 1,
          output_format: "png",
          quality: "medium",
          background: "auto",
          openai_api_key: "test-openai-key",
        };
      }),
    );
    await expect(orgCredits(fixture)).resolves.toBe(10_000);
  });

  it("generates image files on the Okou CDN for Okou run-scoped agent tokens", async () => {
    mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
      },
      context.signal,
    );
    const creditsCharged = 50;
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json(falQueueHandle("gpt-image-1-request"));
      }),
      http.get(FAL_GPT_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/webp" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a small robot painting a sunflower",
        size: "1024x1024",
        quality: "auto",
        background: "opaque",
        outputFormat: "webp",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_GPT_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/webp",
        },
      ],
      prompt: "A small robot paints a sunflower.",
    });
    await flushWaitUntilForTest();
    const webhookUrl = new URL(readWebhookUrl(observedRequestUrl));
    expect(webhookUrl.origin).toBe(API_ORIGIN);
    expect(webhookUrl.pathname).toBe(
      `/api/webhooks/built-in-generations/fal/${generationId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "image",
        status: "completed",
      }),
    );

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const statusBody: unknown = await statusResponse.json();
    expect(statusBody).toMatchObject({
      generationId,
      type: "image",
      status: "completed",
    });
    const body = readGenerationResult(statusBody);
    expect(body).toMatchObject({
      contentType: "image/webp",
      size: IMAGE_BYTES.byteLength,
      creditsCharged,
      model: IMAGE_IO_MODEL,
      provider: "fal",
      imageSize: "1024x1024",
      quality: "auto",
      background: "opaque",
      outputFormat: "webp",
      moderation: "auto",
      revisedPrompt: "A small robot paints a sunflower.",
      sourceUrl: FAL_GPT_MEDIA_URL,
    });
    expect(body).not.toHaveProperty("usage");
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "a small robot painting a sunflower",
      image_size: "1024x1024",
      num_images: 1,
      quality: "auto",
      background: "opaque",
      output_format: "webp",
      openai_api_key: "test-openai-key",
    });

    if (
      !(
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        "filename" in body &&
        "url" in body
      )
    ) {
      throw new Error("Expected image response id, filename, and url");
    }
    const fileId = String(body.id);
    const filename = String(body.filename);
    const url = String(body.url);
    expect(filename).toBe(`image-${fileId.slice(0, 8)}.webp`);

    const putInput = putObjectInput();
    expect(putInput.Bucket).toBe(TEST_BUCKET);
    expect(putInput.Key).toMatch(/^artifacts\/[0-9a-z]{10}\.webp$/u);
    const publicPath = String(putInput.Key).replace(/^artifacts\//u, "");
    expect(url).toBe(`https://a.okou.io/${publicPath}`);
    // The embed URL serves the same stored object through the CDN image
    // transform so a PNG-only model still reaches browsers as AVIF/WebP.
    expect(body).toMatchObject({
      embedUrl: `https://a.okou.io/cdn-cgi/image/fit=scale-down,format=auto,quality=85,metadata=none/${publicPath}`,
    });
    expect(putInput.Metadata).toStrictEqual({
      "artifact-id": fileId,
      filename: encodeURIComponent(filename),
      "public-brand": "okou",
      "user-id": encodeURIComponent(fixture.userId),
    });
    expect(putInput.ContentType).toBe("image/webp");
    const putBody = putInput.Body;
    expect(Buffer.isBuffer(putBody)).toBeTruthy();
    if (!Buffer.isBuffer(putBody)) {
      throw new Error("Expected S3 put body to be a Buffer");
    }
    expect(putBody).toStrictEqual(IMAGE_BYTES);

    // The charge is asserted through product surfaces: the settled usage shows
    // up in the user's usage record with image/provider attribution, and the
    // org balance drops by exactly the credits charged (a single settlement).
    await expect(orgCredits(fixture)).resolves.toBe(10_000 - creditsCharged);

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const usageResponse = await app.request("/api/usage/record", {
      headers: authHeaders(),
    });
    expect(usageResponse.status).toBe(200);
    await expect(usageResponse.json()).resolves.toMatchObject({
      totalCredits: creditsCharged,
      rows: [
        expect.objectContaining({
          source: "chat",
          credits: creditsCharged,
          breakdown: [
            {
              kind: "image",
              credits: creditsCharged,
              providers: [
                {
                  provider: IMAGE_IO_MODEL,
                  credits: creditsCharged,
                  usageKinds: [{ kind: "image", credits: creditsCharged }],
                },
              ],
            },
          ],
        }),
      ],
    });
  });

  it.each([
    {
      detailShape: "a string detail",
      detail: FAL_OUTPUT_SAFETY_FILTER_MESSAGE,
    },
    {
      detailShape: "Pydantic detail entries",
      detail: [
        { type: "file_download_error", msg: "Unrelated provider diagnostic" },
        {
          type: "content_policy_violation",
          loc: ["body", "prompt"],
          msg: FAL_OUTPUT_SAFETY_FILTER_MESSAGE,
          input: {
            prompt: "private-output-safety-prompt",
            image_url: "https://private.example/reference-output-safety.png",
          },
        },
      ],
    },
  ])(
    "maps Fal output safety failures from $detailShape without charging or retaining private diagnostics",
    async ({ detail }) => {
      const fixture = await seedImageFixture({ credits: 1000 });
      const pricingFixture = await createScopedImagePricing({
        configured: GPT_IMAGE_1_PRICING,
      });
      const { runId } = await seedImageRun(fixture, {
        selectedImageModel: null,
      });
      const token = okouToken({
        userId: fixture.userId,
        orgId: fixture.orgId,
        runId,
      });
      const headers = { authorization: `Bearer ${token}` };
      let falCalls = 0;
      let initialRequestUrl: string | null = null;
      server.use(
        http.post(FAL_GPT_IMAGE_1_URL, ({ request }) => {
          falCalls += 1;
          initialRequestUrl ??= request.url;
          return HttpResponse.json(
            falQueueHandle(`safety-${String(falCalls)}`),
          );
        }),
      );

      const app = createImageIoTestApp(pricingFixture.resolution);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "private-output-safety-prompt" }),
      });

      expect(response.status).toBe(202);
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.userId,
      );
      const webhookPayload = {
        request_id: "private-fal-request-id",
        gateway_request_id: "private-fal-gateway-request-id",
        status: "ERROR",
        error: "Unexpected status code: 422",
        payload: {
          detail,
          input: {
            prompt: "private-output-safety-prompt",
            image_url: "https://private.example/reference-output-safety.png",
          },
        },
      };
      await Promise.all([
        postFalWebhookEnvelope(app, initialRequestUrl, webhookPayload),
        postFalWebhookEnvelope(app, initialRequestUrl, webhookPayload),
      ]);
      await flushWaitUntilForTest();

      const expectedError = {
        message: FAL_OUTPUT_SAFETY_FILTER_MESSAGE,
        code: "GENERATION_OUTPUT_SAFETY_BLOCKED",
      };
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        `built-in-generation:${generationId}`,
        expect.objectContaining({
          generationId,
          type: "image",
          status: "failed",
          error: expectedError,
        }),
      );
      const statusResponse = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers },
      );
      expect(statusResponse.status).toBe(200);
      const statusBody: unknown = await statusResponse.json();
      expect(statusBody).toMatchObject({
        generationId,
        type: "image",
        status: "failed",
        error: expectedError,
      });

      // A repeated provider callback is acknowledged but cannot create a
      // second terminal failure event.
      await postFalWebhookEnvelope(app, initialRequestUrl, webhookPayload);
      await flushWaitUntilForTest();
      const failureEvents = context.mocks.ably.publish.mock.calls.filter(
        ([eventName]) => {
          return eventName === `built-in-generation:${generationId}`;
        },
      );
      expect(failureEvents).toHaveLength(1);
      const repeatedStatusResponse = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers },
      );
      expect(repeatedStatusResponse.status).toBe(200);
      await expect(repeatedStatusResponse.json()).resolves.toMatchObject({
        status: "failed",
        error: expectedError,
      });

      const publicSurfaces = JSON.stringify({
        realtime: context.mocks.ably.publish.mock.calls,
        status: statusBody,
      });
      for (const privateValue of [
        "private-output-safety-prompt",
        "private.example",
        "private-fal-request-id",
        "private-fal-gateway-request-id",
        "Unexpected status code: 422",
      ]) {
        expect(publicSurfaces).not.toContain(privateValue);
      }

      // Three new starts prove that the failed job released its per-run active
      // admission slot instead of remaining in flight.
      for (let index = 0; index < 3; index += 1) {
        const admitted = await app.request("/api/image-io/generate", {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: `admission proof ${String(index)}` }),
        });
        expect(admitted.status).toBe(202);
      }
      expect(falCalls).toBe(4);
      expect(context.mocks.s3.send).not.toHaveBeenCalled();
      await expect(orgCredits(fixture)).resolves.toBe(1000);

      mocks.clerk.session(fixture.userId, fixture.orgId);
      const usageResponse = await app.request("/api/usage/record", {
        headers: authHeaders(),
      });
      expect(usageResponse.status).toBe(200);
      await expect(usageResponse.json()).resolves.toMatchObject({
        totalCredits: 0,
        rows: [],
      });
    },
  );

  it.each([
    {
      caseName: "input safety rejection",
      providerErrorType: "content_policy_violation",
      providerMessage: FAL_INPUT_SAFETY_FILTER_MESSAGE,
      location: ["body", "prompt"],
      publicError: {
        message:
          "The prompt or reference image was blocked by the safety filter.",
        code: "GENERATION_INPUT_SAFETY_REJECTED",
      },
    },
    {
      caseName: "input media download failure",
      providerErrorType: "file_download_error",
      providerMessage: FAL_INPUT_MEDIA_DOWNLOAD_MESSAGE,
      location: ["body", "input", "image_urls", 0],
      publicError: {
        message:
          "An input image could not be downloaded by the generation provider.",
        code: "GENERATION_INPUT_MEDIA_UNREACHABLE",
      },
    },
    {
      caseName: "unsupported input media URL without a scheme",
      providerErrorType: "value_error",
      providerMessage:
        "Value error, Invalid URL scheme ':' in image URL. Only http://, https://, and data: URLs are supported. Browser-only URLs like blob: cannot be used.",
      location: ["body", "image_urls"],
      publicError: {
        message:
          "An input image could not be downloaded by the generation provider.",
        code: "GENERATION_INPUT_MEDIA_UNREACHABLE",
      },
    },
    {
      caseName: "unsupported local input media URL",
      providerErrorType: "value_error",
      providerMessage:
        "Value error, Invalid URL scheme 'file:' in image URL. Only http://, https://, and data: URLs are supported. Browser-only URLs like blob: cannot be used.",
      location: ["body", "image_urls"],
      publicError: {
        message:
          "An input image could not be downloaded by the generation provider.",
        code: "GENERATION_INPUT_MEDIA_UNREACHABLE",
      },
    },
    {
      caseName: "invalid input media",
      providerErrorType: "image_load_error",
      providerMessage: FAL_INPUT_MEDIA_LOAD_MESSAGE,
      location: ["body", "image_url"],
      publicError: {
        message: "An input image could not be read by the generation provider.",
        code: "GENERATION_INPUT_MEDIA_INVALID",
      },
    },
    {
      caseName: "invalid prompt and image combination",
      providerErrorType: "invalid_request",
      providerMessage: FAL_INVALID_REQUEST_MESSAGE,
      location: ["prompt"],
      publicError: {
        message: "The image generation request contains invalid parameters.",
        code: "GENERATION_INVALID_PARAMETERS",
      },
    },
    {
      caseName: "unsupported aspect ratio",
      providerErrorType: "literal_error",
      providerMessage: FAL_INVALID_ASPECT_RATIO_MESSAGE,
      location: ["body", "aspect_ratio"],
      publicError: {
        message: "The image generation request contains invalid parameters.",
        code: "GENERATION_INVALID_PARAMETERS",
      },
    },
    {
      caseName: "missing required input",
      providerErrorType: "missing",
      providerMessage: "Field required",
      location: ["body", "image_urls"],
      publicError: {
        message: "The image generation request contains invalid parameters.",
        code: "GENERATION_INVALID_PARAMETERS",
      },
    },
    {
      caseName: "prompt shorter than the provider minimum",
      providerErrorType: "string_too_short",
      providerMessage: "String should have at least 3 characters",
      location: ["body", "prompt"],
      publicError: {
        message: "The image generation request contains invalid parameters.",
        code: "GENERATION_INVALID_PARAMETERS",
      },
    },
    {
      caseName: "downstream provider unavailable",
      providerErrorType: "downstream_service_unavailable",
      providerMessage: "Downstream service unavailable",
      location: ["body"],
      publicError: {
        message: "The image generation provider is temporarily unavailable.",
        code: "GENERATION_PROVIDER_UNAVAILABLE",
      },
    },
    {
      caseName: "downstream provider error",
      providerErrorType: "downstream_service_error",
      providerMessage: "Downstream service error",
      location: ["body"],
      publicError: {
        message: "The image generation provider is temporarily unavailable.",
        code: "GENERATION_PROVIDER_UNAVAILABLE",
      },
    },
  ])(
    "maps Fal $caseName through realtime and status without recording artifacts or usage",
    async ({ providerErrorType, providerMessage, location, publicError }) => {
      const fixture = await seedImageFixture({ credits: 1000 });
      const pricingFixture = await createScopedImagePricing({
        configured: GPT_IMAGE_1_PRICING,
      });
      const { runId } = await seedImageRun(fixture, {
        selectedImageModel: null,
      });
      const token = okouToken({
        userId: fixture.userId,
        orgId: fixture.orgId,
        runId,
      });
      const headers = { authorization: `Bearer ${token}` };
      let initialRequestUrl: string | null = null;
      server.use(
        http.post(FAL_GPT_IMAGE_1_URL, ({ request }) => {
          initialRequestUrl = request.url;
          return HttpResponse.json(falQueueHandle("classified-failure"));
        }),
      );

      const app = createImageIoTestApp(pricingFixture.resolution);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "private-classified-failure-prompt" }),
      });
      expect(response.status).toBe(202);
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.userId,
      );

      await postFalWebhookEnvelope(app, initialRequestUrl, {
        request_id: "private-classified-fal-request-id",
        gateway_request_id: "private-classified-fal-gateway-request-id",
        status: "ERROR",
        error: "Unexpected status code: 422",
        payload: {
          detail: [
            {
              type: providerErrorType,
              loc: location,
              msg: providerMessage,
              input: {
                prompt: "private-classified-failure-prompt",
                image_url:
                  "https://private.example/reference-classified-failure.png",
              },
            },
          ],
        },
      });
      await flushWaitUntilForTest();

      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        `built-in-generation:${generationId}`,
        expect.objectContaining({
          generationId,
          type: "image",
          status: "failed",
          error: publicError,
        }),
      );
      const statusResponse = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers },
      );
      expect(statusResponse.status).toBe(200);
      const statusBody: unknown = await statusResponse.json();
      expect(statusBody).toMatchObject({
        generationId,
        type: "image",
        status: "failed",
        error: publicError,
      });

      const publicSurfaces = JSON.stringify({
        realtime: context.mocks.ably.publish.mock.calls,
        status: statusBody,
      });
      for (const privateValue of [
        "private-classified-failure-prompt",
        "private.example",
        "private-classified-fal-request-id",
        "private-classified-fal-gateway-request-id",
        providerMessage,
      ]) {
        expect(publicSurfaces).not.toContain(privateValue);
      }

      expect(context.mocks.s3.send).not.toHaveBeenCalled();
      await expect(orgCredits(fixture)).resolves.toBe(1000);
      mocks.clerk.session(fixture.userId, fixture.orgId);
      const usageResponse = await app.request("/api/usage/record", {
        headers: authHeaders(),
      });
      expect(usageResponse.status).toBe(200);
      await expect(usageResponse.json()).resolves.toMatchObject({
        totalCredits: 0,
        rows: [],
      });
    },
  );

  it.each([
    {
      caseName: "near-match safety text",
      status: "FAILED",
      wrapper: "payload",
      error: "Unexpected status code: 422",
      detail: [
        {
          type: "content_policy_violation",
          loc: ["body", "prompt"],
          // Missing punctuation must not change the public classification.
          msg: "The generated image was blocked by the safety filter",
        },
      ],
    },
    {
      caseName: "changed provider text and location",
      status: "ERROR",
      wrapper: "data",
      error: "Invalid status code: 422",
      detail: {
        type: "file_download_error",
        loc: ["private-provider-location"],
        msg: "private-provider-message https://private.example/input",
        ctx: { credential: "private-provider-token" },
      },
    },
    {
      caseName: "downstream error with changed message",
      status: "ERROR",
      wrapper: "payload",
      error: "Invalid status code: 500",
      detail: {
        type: "downstream_service_error",
        loc: ["body"],
        msg: "private-provider-message",
      },
    },
    {
      caseName: "downstream error at an unrecognized location",
      status: "ERROR",
      wrapper: "payload",
      error: "Invalid status code: 500",
      detail: {
        type: "downstream_service_error",
        loc: ["body", "private-provider-location"],
        msg: "Downstream service error",
      },
    },
    {
      caseName: "missing messages and an unknown first type",
      status: "ERROR",
      wrapper: "response",
      error: "Unexpected status code: 422",
      detail: [
        { type: "file_download_error:private-provider-token" },
        { type: "image_load_error" },
      ],
    },
    {
      caseName: "the documented legacy validation envelope",
      status: "ERROR",
      wrapper: "payload",
      error: "Invalid status code: 422",
      detail: [
        {
          type: "value_error.missing",
          loc: ["body", "prompt"],
          msg: "field required",
        },
      ],
    },
    {
      caseName: "an unknown type and out-of-range HTTP status",
      status: "ERROR",
      wrapper: "payload",
      error: "Unexpected status code: 999",
      detail: [
        {
          type: "file_download_error:private-provider-token",
          msg: "private-provider-message",
        },
      ],
    },
    {
      caseName: "empty diagnostics and a non-string error",
      status: "ERROR",
      wrapper: "payload",
      error: { message: "private-provider-message" },
      detail: null,
    },
    {
      caseName: "free-form detail and trailing error text",
      status: "ERROR",
      wrapper: "payload",
      error: "Invalid status code: 422 private-provider-token",
      detail: "private-provider-message https://private.example/input",
    },
  ])(
    "falls back to the generic Fal image failure for $caseName",
    async ({ status, wrapper, error, detail }) => {
      const fixture = await seedImageFixture({ credits: 1000 });
      const pricingFixture = await createScopedImagePricing({
        configured: GPT_IMAGE_1_PRICING,
      });
      mocks.clerk.session(fixture.userId, fixture.orgId);
      let observedRequestUrl: string | null = null;
      server.use(
        http.post(FAL_GPT_IMAGE_1_URL, ({ request }) => {
          observedRequestUrl = request.url;
          return HttpResponse.json(falQueueHandle("unknown-failure"));
        }),
      );

      const app = createImageIoTestApp(pricingFixture.resolution);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ prompt: "private-unknown-failure-prompt" }),
      });
      expect(response.status).toBe(202);
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.userId,
      );

      await postFalWebhookEnvelope(app, observedRequestUrl, {
        status,
        error,
        request_id: "private-fal-request-id",
        gateway_request_id: "private-fal-gateway-request-id",
        [wrapper]: {
          detail,
          input: {
            prompt: "private-unknown-failure-prompt",
            image_url: "https://private.example/reference-unknown.png",
          },
        },
      });
      await flushWaitUntilForTest();

      const expectedError = {
        message: "Image generation failed.",
        code: "GENERATION_FAILED",
      };
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        `built-in-generation:${generationId}`,
        expect.objectContaining({
          generationId,
          type: "image",
          status: "failed",
          error: expectedError,
        }),
      );
      const statusResponse = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers: authHeaders() },
      );
      expect(statusResponse.status).toBe(200);
      const statusBody: unknown = await statusResponse.json();
      expect(statusBody).toMatchObject({
        generationId,
        type: "image",
        status: "failed",
        error: expectedError,
      });

      const publicSurfaces = JSON.stringify({
        realtime: context.mocks.ably.publish.mock.calls,
        status: statusBody,
      });
      for (const privateValue of [
        "private-unknown-failure-prompt",
        "private.example",
        "Unexpected status code: 422",
        "Invalid status code:",
        "blocked by the safety filter",
        "private-provider-message",
        "private-provider-token",
        "private-provider-location",
        "private-fal-request-id",
        "private-fal-gateway-request-id",
      ]) {
        expect(publicSurfaces).not.toContain(privateValue);
      }
      expect(context.mocks.s3.send).not.toHaveBeenCalled();
      await expect(orgCredits(fixture)).resolves.toBe(1000);
    },
  );

  it("does not complete a job after the status route times it out", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const falStarted = createDeferredPromise<void>(context.signal);
    const markFalStarted = (): void => {
      if (!falStarted.settled()) {
        falStarted.resolve(undefined);
      }
    };
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;

    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = await request.json();
        markFalStarted();
        return HttpResponse.json(falQueueHandle("late-gpt-image-1-request"));
      }),
      http.get(FAL_GPT_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/webp" },
        });
      }),
    );

    const staleTime = new Date("2026-05-15T12:00:00.000Z");
    const timeoutTime = new Date(staleTime.getTime() + 16 * 60 * 1000);
    mockNow(staleTime);

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a late image" }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    await falStarted;
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "a late image",
      image_size: "1024x1024",
      num_images: 1,
      output_format: "png",
      quality: "medium",
      background: "auto",
      openai_api_key: "test-openai-key",
    });

    mockNow(timeoutTime);
    const timeoutResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(timeoutResponse.status).toBe(200);
    await expect(timeoutResponse.json()).resolves.toMatchObject({
      generationId,
      type: "image",
      status: "failed",
      error: {
        message: "Generation timed out. Please try again.",
        code: "GENERATION_TIMEOUT",
      },
    });

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_GPT_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/webp",
        },
      ],
      prompt: "A late robot paints a sunflower.",
    });
    await flushWaitUntilForTest();
    releasePendingFalResponse = null;

    const finalStatusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(finalStatusResponse.status).toBe(200);
    await expect(finalStatusResponse.json()).resolves.toMatchObject({
      generationId,
      type: "image",
      status: "failed",
      error: {
        message: "Generation timed out. Please try again.",
        code: "GENERATION_TIMEOUT",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    // No usage settles for a timed-out job: the org balance is unchanged.
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("generates Seedream 5 Lite through BytePlus with 25 percent markup", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: SEEDREAM_5_LITE_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_IMAGE_GENERATIONS_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
          created: 1_700_000_000,
          model: "seedream-5-0-lite-260128",
          data: [
            {
              url: BYTEPLUS_SEEDREAM_5_LITE_MEDIA_URL,
              size: "2048x2048",
              output_format: "png",
            },
          ],
        });
      }),
      http.get(BYTEPLUS_SEEDREAM_5_LITE_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a cinematic product still",
        model: "seedream5-lite",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/png",
      creditsCharged: 44,
      model: "seedream-5-0-lite-260128",
      provider: "byteplus",
      imageSize: "2048x2048",
      quality: "model-default",
      background: "auto",
      outputFormat: "png",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 35_000,
      sourceUrl: BYTEPLUS_SEEDREAM_5_LITE_MEDIA_URL,
    });
    expect(observedAuthorization).toBe("Bearer test-byteplus-key");
    expect(observedBody).toStrictEqual({
      model: "seedream-5-0-lite-260128",
      prompt: "a cinematic product still",
      size: "2K",
      output_format: "png",
      response_format: "url",
      watermark: false,
    });
    await expect(orgCredits(fixture)).resolves.toBe(956);
  });

  it("rejects an explicit unsupported Seedream 5 Lite size", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let bytePlusCalls = 0;
    server.use(
      http.post(BYTEPLUS_IMAGE_GENERATIONS_URL, () => {
        bytePlusCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp();
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "an explicitly undersized product still",
        model: "seedream5-lite",
        size: "1024x1024",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "Unsupported image size for seedream5-lite: 1024x1024; total pixels must be between 3686400 and 16777216",
        code: "BAD_REQUEST",
      },
    });
    expect(bytePlusCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("rejects a Qwen Image 3 size above the provider's pixel cap", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    server.use(
      http.post(FAL_QWEN_IMAGE_3_URL, () => {
        falCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp();
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "an oversized keynote backdrop",
        model: "qwen-image-3",
        size: "3840x2160",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "Unsupported image size for qwen-image-3: 3840x2160; total pixels must be at most 4194304",
        code: "BAD_REQUEST",
      },
    });
    expect(falCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("bills Seedream 5 Pro output tiers and references through BytePlus", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: SEEDREAM_5_PRO_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const observedBodies: unknown[] = [];
    const observedAuthorizations: (string | null)[] = [];
    server.use(
      http.post(BYTEPLUS_IMAGE_GENERATIONS_URL, async ({ request }) => {
        observedAuthorizations.push(request.headers.get("authorization"));
        const requestBody = (await request.json()) as Record<string, unknown>;
        observedBodies.push(requestBody);
        const highTier = requestBody.size === "2K";
        return HttpResponse.json({
          created: 1_700_000_000,
          model: "dola-seedream-5-0-pro-260628",
          data: [
            {
              url: highTier
                ? BYTEPLUS_SEEDREAM_5_PRO_HIGH_MEDIA_URL
                : BYTEPLUS_SEEDREAM_5_PRO_LOW_MEDIA_URL,
              size: highTier ? "2048x2048" : "1536x1536",
              output_format: "jpeg",
            },
          ],
        });
      }),
      http.get(BYTEPLUS_SEEDREAM_5_PRO_LOW_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
      http.get(BYTEPLUS_SEEDREAM_5_PRO_HIGH_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const lowResponse = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a precise editorial portrait",
        model: "seedream5-pro",
        size: "1.5K",
        outputFormat: "jpeg",
      }),
    });
    expect(lowResponse.status).toBe(202);
    const lowGenerationId = readAcceptedGenerationId(
      await lowResponse.json(),
      "image",
      fixture.userId,
    );
    await flushWaitUntilForTest();

    const lowStatusResponse = await app.request(
      `/api/built-in-generations/${lowGenerationId}`,
      { headers: authHeaders() },
    );
    const lowBody = readGenerationResult(await lowStatusResponse.json());
    expect(lowBody).toMatchObject({
      creditsCharged: 57,
      model: "dola-seedream-5-0-pro-260628",
      provider: "byteplus",
      imageSize: "1536x1536",
      outputFormat: "jpeg",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 45_000,
      sourceUrl: BYTEPLUS_SEEDREAM_5_PRO_LOW_MEDIA_URL,
    });

    const hostApi = createHostMapsBddApi(context);
    hostApi.captureHostedSitesS3();
    await upsertOrgPlanEntitlementFixture({
      orgId: fixture.orgId,
      restrictedBuiltInModels: false,
    });
    const site = `seedream-reference-${randomUUID().slice(0, 8)}`;
    const hostActor = {
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin" as const,
      email: `${fixture.userId}@example.test`,
    };
    const hosted = await hostApi.prepareHostedSite(hostActor, {
      site,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [
        hostedTextFile("/index.html", "<main>Reference image</main>"),
        hostedTextFile("/img4.jpeg", "reference", "image/jpeg"),
      ],
    });
    await hostApi.completeHostedSite(hostActor, hosted.deploymentId);
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown) => {
        return Promise.resolve(apiTestS3PresignedUrl(command));
      },
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const hostedImageUrl = `${hosted.url}/img4.jpeg`;
    const sourceImageUrls = [
      hostedImageUrl,
      SECOND_MOCKUP_IMAGE_URL,
      THIRD_MOCKUP_IMAGE_URL,
    ];
    const highResponse = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "combine these references into a campaign image",
        model: "seedream5-pro",
        size: "2K",
        outputFormat: "jpeg",
        imageUrls: sourceImageUrls,
      }),
    });
    expect(highResponse.status).toBe(202);
    const highGenerationId = readAcceptedGenerationId(
      await highResponse.json(),
      "image",
      fixture.userId,
    );
    await flushWaitUntilForTest();

    const highStatusResponse = await app.request(
      `/api/built-in-generations/${highGenerationId}`,
      { headers: authHeaders() },
    );
    const highBody = readGenerationResult(await highStatusResponse.json());
    expect(highBody).toMatchObject({
      creditsCharged: 120,
      model: "dola-seedream-5-0-pro-260628",
      provider: "byteplus",
      imageSize: "2048x2048",
      outputFormat: "jpeg",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 96_000,
      sourceUrl: BYTEPLUS_SEEDREAM_5_PRO_HIGH_MEDIA_URL,
      sourceImageUrls,
    });

    expect(observedAuthorizations).toStrictEqual([
      "Bearer test-byteplus-key",
      "Bearer test-byteplus-key",
    ]);
    expect(observedBodies[0]).toStrictEqual({
      model: "dola-seedream-5-0-pro-260628",
      prompt: "a precise editorial portrait",
      size: "1.5K",
      output_format: "jpeg",
      response_format: "url",
      watermark: false,
    });
    expect(observedBodies[1]).toMatchObject({
      model: "dola-seedream-5-0-pro-260628",
      prompt: "combine these references into a campaign image",
      size: "2K",
      output_format: "jpeg",
      response_format: "url",
      watermark: false,
    });
    const providerSourceImageUrls = (
      observedBodies[1] as { readonly image?: unknown }
    ).image;
    expect(Array.isArray(providerSourceImageUrls)).toBeTruthy();
    if (!Array.isArray(providerSourceImageUrls)) {
      throw new Error("Expected BytePlus image references");
    }
    expect(providerSourceImageUrls.slice(1)).toStrictEqual(
      sourceImageUrls.slice(1),
    );
    const signedHostedUrl = new URL(String(providerSourceImageUrls[0]));
    expect(signedHostedUrl.origin).toBe("https://r2.example.com");
    expect(signedHostedUrl.searchParams.get("sig")).toBe("bdd");
    expect(signedHostedUrl.searchParams.get("object")).toMatch(
      /^test-hosted-sites\/sites\/.+\/img4\.jpeg$/u,
    );
    await expect(orgCredits(fixture)).resolves.toBe(823);
  });

  it("generates fal image files and settles megapixel usage asynchronously", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: QWEN_IMAGE_PRICING,
    });
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
      },
      context.signal,
    );
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_QWEN_IMAGE_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json(falQueueHandle("qwen-image-request"));
      }),
      http.get(FAL_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a precise product render",
        model: "qwen-image",
        size: "1536x1024",
        outputFormat: "jpeg",
        seed: 99,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_MEDIA_URL,
          width: 1536,
          height: 1024,
          content_type: "image/jpeg",
        },
      ],
      prompt: "A precise product render.",
      seed: 99,
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/jpeg",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: 48,
      model: "fal-ai/qwen-image",
      provider: "fal",
      imageSize: "1536x1024",
      quality: "model-default",
      background: "auto",
      outputFormat: "jpeg",
      billingCategory: "output_megapixel",
      billingQuantity: 2,
      sourceUrl: FAL_MEDIA_URL,
      seed: 99,
    });
    expect(body).not.toHaveProperty("usage");
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "a precise product render",
      image_size: { width: 1536, height: 1024 },
      num_images: 1,
      output_format: "jpeg",
      seed: 99,
    });

    if (
      !(
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        "filename" in body
      )
    ) {
      throw new Error("Expected image response id and filename");
    }
    const fileId = String(body.id);
    const filename = String(body.filename);
    const putInput = putObjectInput();
    expect(putInput.Key).toMatch(/^artifacts\/[0-9a-z]{10}\.jpg$/u);
    expect(putInput.Metadata).toStrictEqual({
      "artifact-id": fileId,
      filename: encodeURIComponent(filename),
      "public-brand": "okou",
      "user-id": encodeURIComponent(fixture.userId),
    });
    expect(putInput.ContentType).toBe("image/jpeg");

    // The megapixel category/quantity are asserted in the result body above;
    // the single settled charge is observable as the exact balance drop.
    await expect(orgCredits(fixture)).resolves.toBe(952);
  });

  it("generates image-to-image through fal with 20 percent markup pricing", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: FLUX_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_FLUX_REDUX_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("flux-redux-request"));
      }),
      http.get(FAL_FLUX_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "turn this wireframe into a polished product mockup",
        model: "flux-pro-1.1",
        imageUrl: MOCKUP_IMAGE_URL,
        outputFormat: "jpeg",
        seed: 42,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_FLUX_MEDIA_URL,
          width: 1536,
          height: 1024,
          content_type: "image/jpeg",
        },
      ],
      prompt: "A polished product mockup.",
      seed: 42,
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/jpeg",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: 96,
      model: "fal-ai/flux-pro/v1.1",
      provider: "fal",
      imageSize: "1536x1024",
      outputFormat: "jpeg",
      billingCategory: "output_megapixel",
      billingQuantity: 2,
      sourceUrl: FAL_FLUX_MEDIA_URL,
      sourceImageUrls: [MOCKUP_IMAGE_URL],
      seed: 42,
    });
    expect(body).not.toHaveProperty("imagePromptStrength");
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "turn this wireframe into a polished product mockup",
      image_size: "landscape_4_3",
      num_images: 1,
      output_format: "jpeg",
      seed: 42,
      safety_tolerance: "4",
      enhance_prompt: false,
      image_url: MOCKUP_IMAGE_URL,
    });
    expect(observedBody).not.toHaveProperty("image_prompt_strength");

    // The marked-up charge (2 megapixels at 48/megapixel) is asserted through
    // the result body above and the exact org balance drop.
    await expect(orgCredits(fixture)).resolves.toBe(1000 - 96);
  });

  it("generates with FLUX.2 Pro and bills the first and additional output megapixels", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: FLUX_2_PRO_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_FLUX_2_PRO_URL, async ({ request }) => {
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("flux-2-pro-request"));
      }),
      http.get(falResponseUrl("flux-2-pro-request"), ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Key test-fal-key");
        return HttpResponse.json(
          {},
          { headers: { "X-Fal-Billable-Units": "1.5" } },
        );
      }),
      http.get(FAL_FLUX_2_PRO_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a premium studio campaign with crisp product typography",
        model: "flux-2-pro",
        size: "1536x1024",
        outputFormat: "png",
        seed: 42,
        safetyTolerance: "5",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_FLUX_2_PRO_MEDIA_URL,
          width: 1536,
          height: 1024,
          content_type: "image/png",
        },
      ],
      seed: 42,
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      contentType: "image/png",
      creditsCharged:
        FAL_FLUX_2_PRO_FIRST_MEGAPIXEL_CREDITS +
        FAL_FLUX_2_PRO_ADDITIONAL_MEGAPIXEL_CREDITS,
      model: "fal-ai/flux-2-pro",
      provider: "fal",
      imageSize: "1536x1024",
      outputFormat: "png",
      billingCategory: "processed_megapixel.first",
      billingQuantity: 1,
      seed: 42,
    });
    expect(observedBody).toStrictEqual({
      prompt: "a premium studio campaign with crisp product typography",
      image_size: { width: 1536, height: 1024 },
      output_format: "png",
      seed: 42,
      safety_tolerance: "5",
    });
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 -
        FAL_FLUX_2_PRO_FIRST_MEGAPIXEL_CREDITS -
        FAL_FLUX_2_PRO_ADDITIONAL_MEGAPIXEL_CREDITS,
    );
  });

  it("edits up to nine references with FLUX.2 Pro and uses Fal billing units", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: FLUX_2_PRO_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_FLUX_2_PRO_EDIT_URL, async ({ request }) => {
        falCalls += 1;
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("flux-2-pro-edit-request"));
      }),
      http.get(falResponseUrl("flux-2-pro-edit-request"), ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Key test-fal-key");
        return HttpResponse.json(
          {},
          { headers: { "X-Fal-Billable-Units": "3" } },
        );
      }),
      http.get(FAL_FLUX_2_PRO_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const rejected = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "merge ten references",
        model: "flux-2-pro",
        imageUrls: Array.from({ length: 10 }, (_, index) => {
          return `https://example.com/reference-${String(index)}.png`;
        }),
      }),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { message: "imageUrls supports at most 9 images" },
    });
    expect(falCalls).toBe(0);

    const sourceImageUrls = [MOCKUP_IMAGE_URL, SECOND_MOCKUP_IMAGE_URL];
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "combine the product and lighting references",
        model: "fal-ai/flux-2-pro",
        imageUrls: sourceImageUrls,
        outputFormat: "png",
      }),
    });
    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_FLUX_2_PRO_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      creditsCharged:
        FAL_FLUX_2_PRO_FIRST_MEGAPIXEL_CREDITS +
        4 * FAL_FLUX_2_PRO_ADDITIONAL_MEGAPIXEL_CREDITS,
      model: "fal-ai/flux-2-pro",
      sourceImageUrls,
    });
    expect(observedBody).toStrictEqual({
      prompt: "combine the product and lighting references",
      image_size: "auto",
      output_format: "png",
      safety_tolerance: "4",
      image_urls: sourceImageUrls,
    });
    expect(falCalls).toBe(1);
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 -
        FAL_FLUX_2_PRO_FIRST_MEGAPIXEL_CREDITS -
        4 * FAL_FLUX_2_PRO_ADDITIONAL_MEGAPIXEL_CREDITS,
    );
  });

  it("maps Ideogram 4 quality to rendering speed without paid prompt expansion", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: IDEOGRAM_4_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_IDEOGRAM_4_URL, async ({ request }) => {
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("ideogram-4-request"));
      }),
      http.get(FAL_IDEOGRAM_4_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a typographic launch poster reading ZERO TO ONE",
        model: "ideogram-4",
        size: "2048x1024",
        quality: "high",
        outputFormat: "png",
        seed: 17,
      }),
    });
    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_IDEOGRAM_4_MEDIA_URL,
          width: 2048,
          height: 1024,
          content_type: "image/png",
        },
      ],
      seed: 17,
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      creditsCharged: 2 * FAL_IDEOGRAM_4_QUALITY_MEGAPIXEL_CREDITS,
      model: "ideogram/v4",
      quality: "high",
      billingCategory: "output_megapixel.quality",
      billingQuantity: 2,
    });
    expect(observedBody).toStrictEqual({
      prompt: "a typographic launch poster reading ZERO TO ONE",
      image_size: { width: 2048, height: 1024 },
      num_images: 1,
      output_format: "png",
      rendering_speed: "QUALITY",
      expansion_model: "None",
      seed: 17,
    });
  });

  it("routes Ideogram 4 single-image edits and rejects multiple references", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: IDEOGRAM_4_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_IDEOGRAM_4_EDIT_URL, async ({ request }) => {
        falCalls += 1;
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("ideogram-4-edit-request"));
      }),
      http.get(FAL_IDEOGRAM_4_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const rejected = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "edit two images",
        model: "ideogram/v4",
        imageUrls: [MOCKUP_IMAGE_URL, SECOND_MOCKUP_IMAGE_URL],
      }),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { message: "ideogram-4 accepts one source image" },
    });
    expect(falCalls).toBe(0);

    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "restyle this poster with warmer typography",
        model: "ideogram/v4",
        imageUrl: MOCKUP_IMAGE_URL,
        quality: "low",
        outputFormat: "png",
      }),
    });
    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_IDEOGRAM_4_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();
    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      creditsCharged: FAL_IDEOGRAM_4_TURBO_MEGAPIXEL_CREDITS,
      billingCategory: "output_megapixel.turbo",
      sourceImageUrls: [MOCKUP_IMAGE_URL],
    });
    expect(observedBody).toStrictEqual({
      prompt: "restyle this poster with warmer typography",
      image_size: "auto",
      output_format: "png",
      rendering_speed: "TURBO",
      expansion_model: "None",
      image_url: MOCKUP_IMAGE_URL,
    });
    expect(falCalls).toBe(1);
  });

  it("fails Ideogram 4 auto edits when Fal omits billable dimensions", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: IDEOGRAM_4_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let mediaCalls = 0;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_IDEOGRAM_4_EDIT_URL, ({ request }) => {
        observedRequestUrl = request.url;
        return HttpResponse.json(
          falQueueHandle("ideogram-4-missing-dimensions-request"),
        );
      }),
      http.get(FAL_IDEOGRAM_4_MEDIA_URL, () => {
        mediaCalls += 1;
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "restyle this poster with warmer typography",
        model: "ideogram-4",
        imageUrl: MOCKUP_IMAGE_URL,
        quality: "low",
        outputFormat: "png",
      }),
    });
    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_IDEOGRAM_4_MEDIA_URL,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      generationId,
      type: "image",
      status: "failed",
      error: {
        message: "Fal returned no billing details",
        code: "NO_BILLING_UNITS",
      },
    });
    expect(mediaCalls).toBe(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("generates Qwen Image 3 images through fal and bills the standard resolution tier", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: QWEN_IMAGE_3_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_QWEN_IMAGE_3_URL, async ({ request }) => {
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("qwen-image-3-request"));
      }),
      http.get(FAL_QWEN_IMAGE_3_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a bilingual conference poster with dense legible typography",
        model: "qwen-image-3",
        size: "1024x1024",
        outputFormat: "png",
        seed: 7,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_QWEN_IMAGE_3_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/png",
        },
      ],
      seed: 7,
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      contentType: "image/png",
      creditsCharged: FAL_QWEN_IMAGE_3_STANDARD_TIER_CREDITS,
      model: "alibaba/qwen-image-3/text-to-image",
      provider: "fal",
      imageSize: "1024x1024",
      outputFormat: "png",
      billingCategory: "output_image.1k",
      billingQuantity: 1,
      sourceUrl: FAL_QWEN_IMAGE_3_MEDIA_URL,
      seed: 7,
    });
    expect(observedBody).toStrictEqual({
      prompt: "a bilingual conference poster with dense legible typography",
      image_size: { width: 1024, height: 1024 },
      num_images: 1,
      output_format: "png",
      seed: 7,
    });
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 - FAL_QWEN_IMAGE_3_STANDARD_TIER_CREDITS,
    );
  });

  it("bills Qwen Image 3 at the high resolution tier above 2,250,000 output pixels", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: QWEN_IMAGE_3_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_QWEN_IMAGE_3_URL, ({ request }) => {
        observedRequestUrl = request.url;
        return HttpResponse.json(falQueueHandle("qwen-image-3-2k-request"));
      }),
      http.get(FAL_QWEN_IMAGE_3_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a 2K keynote backdrop",
        model: "qwen-image-3",
        size: "2048x2048",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_QWEN_IMAGE_3_MEDIA_URL,
          width: 2048,
          height: 2048,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      creditsCharged: FAL_QWEN_IMAGE_3_HIGH_TIER_CREDITS,
      model: "alibaba/qwen-image-3/text-to-image",
      billingCategory: "output_image.2k",
      billingQuantity: 1,
    });
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 - FAL_QWEN_IMAGE_3_HIGH_TIER_CREDITS,
    );
  });

  it("edits with Qwen Image 3 through fal and caps its reference images at three", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: QWEN_IMAGE_3_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_QWEN_IMAGE_3_EDIT_URL, async ({ request }) => {
        falCalls += 1;
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("qwen-image-3-edit-request"));
      }),
      http.get(FAL_QWEN_IMAGE_3_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const rejected = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "merge these four references",
        model: "qwen-image-3",
        imageUrls: [
          MOCKUP_IMAGE_URL,
          SECOND_MOCKUP_IMAGE_URL,
          THIRD_MOCKUP_IMAGE_URL,
          "https://example.com/mockup-4.png",
        ],
      }),
    });

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toStrictEqual({
      error: {
        message: "imageUrls supports at most 3 images",
        code: "BAD_REQUEST",
      },
    });
    expect(falCalls).toBe(0);

    const shortArtifactKey = buildArtifactKeyV2(
      randomUUID(),
      "short-reference.png",
    );
    const cdnArtifactKey = buildArtifactKeyV2(
      randomUUID(),
      "cdn-reference.png",
    );
    const shortArtifactUrl = buildFileUrlFromKey(shortArtifactKey, "okou");
    const shortArtifactPath = new URL(shortArtifactUrl).pathname.replace(
      /^\/+/u,
      "",
    );
    const transformedShortArtifactUrl = `${OKOU_SHORT_ARTIFACTS_ORIGIN}/cdn-cgi/image/width=96,height=96,fit=scale-down,format=auto,quality=85,metadata=none/${shortArtifactPath}`;
    const cdnArtifactUrl = `${OKOU_CDN_ARTIFACTS_ORIGIN}/${cdnArtifactKey}`;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({
          Metadata: { "user-id": encodeURIComponent(fixture.userId) },
        });
      }
      return Promise.resolve({});
    });
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown) => {
        return Promise.resolve(apiTestS3PresignedUrl(command));
      },
    );
    const sourceImageUrls = [
      transformedShortArtifactUrl,
      cdnArtifactUrl,
      THIRD_MOCKUP_IMAGE_URL,
    ];
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "restyle the product shot to match the reference lighting",
        model: "qwen-image-3",
        imageUrls: sourceImageUrls,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_QWEN_IMAGE_3_MEDIA_URL,
          width: 1024,
          height: 768,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      creditsCharged: FAL_QWEN_IMAGE_3_STANDARD_TIER_CREDITS,
      model: "alibaba/qwen-image-3/text-to-image",
      billingCategory: "output_image.1k",
      sourceUrl: FAL_QWEN_IMAGE_3_MEDIA_URL,
      sourceImageUrls,
    });
    expect(falCalls).toBe(1);
    const providerImageUrls = (
      observedBody as unknown as Record<string, unknown>
    )["image_urls"];
    expect(Array.isArray(providerImageUrls)).toBeTruthy();
    if (!Array.isArray(providerImageUrls)) {
      throw new Error("Expected Fal image references");
    }
    expect(providerImageUrls.slice(0, 2)).toStrictEqual([
      expect.stringMatching(/^https:\/\/r2\.example\.com\//u),
      expect.stringMatching(/^https:\/\/r2\.example\.com\//u),
    ]);
    expect(providerImageUrls[2]).toBe(THIRD_MOCKUP_IMAGE_URL);
    for (const [providerImageUrl, artifactKey] of [
      [providerImageUrls[0], shortArtifactKey],
      [providerImageUrls[1], cdnArtifactKey],
    ] as const) {
      const signedArtifactUrl = new URL(String(providerImageUrl));
      expect(signedArtifactUrl.origin).toBe("https://r2.example.com");
      expect(signedArtifactUrl.searchParams.get("object")).toBe(
        `${TEST_BUCKET}/${artifactKey}`,
      );
    }
    const headObjectInputs = context.mocks.s3.send.mock.calls.flatMap(
      ([command]) => {
        return command instanceof HeadObjectCommand ? [command.input] : [];
      },
    );
    expect(headObjectInputs).toStrictEqual(
      expect.arrayContaining([
        { Bucket: TEST_BUCKET, Key: shortArtifactKey },
        { Bucket: TEST_BUCKET, Key: cdnArtifactKey },
      ]),
    );
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 - FAL_QWEN_IMAGE_3_STANDARD_TIER_CREDITS,
    );
  });

  it("generates Nano Banana 2 Lite images through fal at its fixed 1K price", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: NANO_BANANA_2_LITE_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_NANO_BANANA_2_LITE_URL, async ({ request }) => {
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("nano-banana-2-lite-request"));
      }),
      http.get(FAL_NANO_BANANA_2_LITE_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a bright thumbnail for a launch recap",
        model: "nano-banana-2-lite",
        size: "1024x1024",
        outputFormat: "png",
        safetyTolerance: "5",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_NANO_BANANA_2_LITE_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      contentType: "image/png",
      creditsCharged: FAL_NANO_BANANA_2_LITE_CREDITS_PER_IMAGE,
      model: "google/nano-banana-2-lite",
      provider: "fal",
      outputFormat: "png",
      billingCategory: "output_image",
      billingQuantity: 1,
      sourceUrl: FAL_NANO_BANANA_2_LITE_MEDIA_URL,
    });
    // Lite always renders 1K, so it takes no resolution parameter.
    expect(observedBody).toStrictEqual({
      prompt: "a bright thumbnail for a launch recap",
      aspect_ratio: "1:1",
      num_images: 1,
      output_format: "png",
      safety_tolerance: "5",
    });
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 - FAL_NANO_BANANA_2_LITE_CREDITS_PER_IMAGE,
    );
  });

  it("generates Nano Banana 2 images through fal with 20 percent markup pricing", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: NANO_BANANA_2_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_NANO_BANANA_2_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("nano-banana-2-request"));
      }),
      http.get(FAL_NANO_BANANA_2_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/webp" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a launch poster with crisp product typography",
        model: "nano-banana-2",
        size: "1024x1024",
        outputFormat: "webp",
        seed: 123,
        safetyTolerance: "5",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_NANO_BANANA_2_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/webp",
        },
      ],
      description: "A launch poster with crisp product typography.",
      seed: 123,
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/webp",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
      model: "fal-ai/nano-banana-2",
      provider: "fal",
      imageSize: "1024x1024",
      quality: "model-default",
      background: "auto",
      outputFormat: "webp",
      billingCategory: "output_image",
      billingQuantity: 1,
      sourceUrl: FAL_NANO_BANANA_2_MEDIA_URL,
      seed: 123,
    });
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "a launch poster with crisp product typography",
      aspect_ratio: "1:1",
      num_images: 1,
      output_format: "webp",
      resolution: "1K",
      seed: 123,
      safety_tolerance: "5",
    });

    // The per-image marked-up charge is asserted through the result body
    // above and the exact org balance drop.
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 - FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
    );
  });

  it("edits images with Nano Banana 2 through fal", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: NANO_BANANA_2_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_NANO_BANANA_2_EDIT_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("nano-banana-2-edit-request"));
      }),
      http.get(FAL_NANO_BANANA_2_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const sourceImageUrls = [MOCKUP_IMAGE_URL, SECOND_MOCKUP_IMAGE_URL];
    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "combine these references into a polished product campaign",
        model: "nano-banana-2",
        imageUrls: sourceImageUrls,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_NANO_BANANA_2_MEDIA_URL,
          width: 1536,
          height: 1024,
          content_type: "image/png",
        },
      ],
      description: "A polished product campaign.",
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/png",
      creditsCharged: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
      model: "fal-ai/nano-banana-2",
      provider: "fal",
      imageSize: "1536x1024",
      quality: "model-default",
      background: "auto",
      outputFormat: "png",
      billingCategory: "output_image",
      billingQuantity: 1,
      sourceUrl: FAL_NANO_BANANA_2_MEDIA_URL,
      sourceImageUrls,
    });
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "combine these references into a polished product campaign",
      aspect_ratio: "auto",
      num_images: 1,
      output_format: "png",
      resolution: "1K",
      safety_tolerance: "4",
      image_urls: sourceImageUrls,
    });
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 - FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
    );
  });

  it("removes backgrounds with birefnet through fal without a prompt", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: BIREFNET_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_BIREFNET_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("birefnet-request"));
      }),
      http.get(FAL_BIREFNET_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "birefnet",
        sourceImageUrls: [MOCKUP_IMAGE_URL],
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_BIREFNET_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();

    expect(observedRequestUrl).not.toBeNull();
    expect(new URL(observedRequestUrl ?? "").pathname).toBe(
      "/fal-ai/birefnet/v2",
    );

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/png",
      creditsCharged: 0,
      model: "fal-ai/birefnet/v2",
      provider: "fal",
      outputFormat: "png",
      billingCategory: "output_image",
      billingQuantity: 1,
      sourceUrl: FAL_BIREFNET_MEDIA_URL,
      sourceImageUrls: [MOCKUP_IMAGE_URL],
    });
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({ image_url: MOCKUP_IMAGE_URL });
    expect(observedBody).not.toHaveProperty("prompt");
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("upscales images with clarity-upscaler through fal without a prompt", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: CLARITY_UPSCALER_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_CLARITY_UPSCALER_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("clarity-upscaler-request"));
      }),
      http.get(FAL_CLARITY_UPSCALER_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "clarity-upscaler",
        imageUrl: MOCKUP_IMAGE_URL,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_CLARITY_UPSCALER_MEDIA_URL,
          width: 2048,
          height: 2048,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();

    expect(observedRequestUrl).not.toBeNull();
    expect(new URL(observedRequestUrl ?? "").pathname).toBe(
      "/fal-ai/clarity-upscaler",
    );

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/png",
      creditsCharged: 150,
      model: "fal-ai/clarity-upscaler",
      provider: "fal",
      imageSize: "2048x2048",
      outputFormat: "png",
      billingCategory: "output_megapixel",
      billingQuantity: 5,
      sourceUrl: FAL_CLARITY_UPSCALER_MEDIA_URL,
      sourceImageUrls: [MOCKUP_IMAGE_URL],
    });
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({ image_url: MOCKUP_IMAGE_URL });
    expect(observedBody).not.toHaveProperty("prompt");
    await expect(orgCredits(fixture)).resolves.toBe(850);
  });

  it("rejects promptless models without a source image", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: BIREFNET_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    server.use(
      http.post(FAL_BIREFNET_URL, () => {
        falCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ model: "birefnet" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "birefnet requires imageUrl",
        code: "BAD_REQUEST",
      },
    });
    expect(falCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("records a failed job when fal image generation fails", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Image generation failed",
        code: "FAL_IMAGE_REQUEST_FAILED",
      },
    });
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "a cat",
      image_size: "1024x1024",
      num_images: 1,
      output_format: "png",
      quality: "medium",
      background: "auto",
      openai_api_key: "test-openai-key",
    });
    // The failed job is observed through its realtime failure event and the
    // product status route rather than by reading job rows.
    const generationId = readPublishedGenerationId(
      context.mocks.ably.publish.mock.calls,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "image",
        status: "failed",
      }),
    );
    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      generationId,
      type: "image",
      status: "failed",
      error: {
        message: "Image generation failed",
        code: "FAL_IMAGE_REQUEST_FAILED",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    // No usage settles for a failed submission: the org balance is unchanged.
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });
});
