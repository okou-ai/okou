import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";

import { imageModelIdSchema } from "@okouai/api-contracts/contracts/image-models";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";

import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  buildArtifactKeyV2,
  buildFileUrlFromKey,
  OKOU_CDN_ARTIFACTS_ORIGIN,
  OKOU_SHORT_ARTIFACTS_ORIGIN,
} from "../../../lib/file-url";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { usageRecordRoutes } from "../usage-record";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

import { createRouteMocks } from "./helpers/route-test";
import { flushWaitUntilForTest } from "../../context/wait-until";

import { createRunsApi } from "./helpers/api-bdd-runs";

import { createPublicImageMember } from "./helpers/public-image-member";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
import { publicRunOwner } from "./helpers/public-run-owner";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { deletePublicWorkspace } from "./helpers/public-workspace-cleanup";
import { purchaseToolCredits } from "./helpers/public-tool-actor";

const context = testContext();

const mocks = createRouteMocks(context);
const TEST_BUCKET = "test-user-artifacts";
const IMAGE_BYTES = Buffer.from("fake image bytes");
const IMAGE_IO_MODEL = "gpt-image-1";
const FAL_GPT_IMAGE_1_URL =
  "https://queue.fal.run/fal-ai/gpt-image-1/text-to-image";
const FAL_GPT_IMAGE_2_URL = "https://queue.fal.run/openai/gpt-image-2";
const OPENAI_IMAGE_GENERATIONS_URL =
  "https://api.openai.com/v1/images/generations";

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

const FAL_FLUX_PRO_11_URL = "https://queue.fal.run/fal-ai/flux-pro/v1.1";
const FAL_FLUX_PRO_11_MEDIA_URL =
  "https://fal.media/files/test/flux-pro-1-1.jpg";
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
const MOCKUP_IMAGE_URL = "https://example.com/mockup.png";
const SECOND_MOCKUP_IMAGE_URL = "https://example.com/mockup-2.png";
const THIRD_MOCKUP_IMAGE_URL = "https://example.com/mockup-3.png";
const IMAGE_PRICING_MARKUP_MULTIPLIER = 1.2;

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

const FAL_IDEOGRAM_4_QUALITY_MEGAPIXEL_CREDITS = 30;
const API_ORIGIN = "https://api.okou.test";
const WEB_ORIGIN = "https://www.okou.test";
const GPT_IMAGE_2_5_MODELS = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;

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

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createImageIoTestApp(owner?: {
  readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...builtInGenerationRoutes,
      ...imageIoGenerateRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
      ...usageRecordRoutes,
    ],
  });
  return {
    request(...args: Parameters<typeof app.request>) {
      const request = async () => {
        return await app.request(...args);
      };
      return owner ? owner.run(request) : request();
    },
  };
}

async function publicFundedImageFixture({
  credits = 10_000,
}: {
  readonly credits?: number;
}) {
  const fixture = await createPublicImageMember(context, { credits });
  // Only generation requests belong to this suite's object-upload assertions.
  context.mocks.s3.send.mockReset();
  context.mocks.s3.send.mockResolvedValue({});
  fixture.captureExternalState();
  return fixture;
}
async function publicUnfundedImageFixture() {
  return await createPublicImageMember(context, { credits: 0 });
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

// These selected callers use real personal-model Runs and the existing image tariffs.
async function createClaimedImageRun(
  imageModel: string | null,
  credits = 1000,
) {
  const chat = createChatEventsFixture(context);
  const actor = chat.bdd.user();
  if (!actor.orgId) {
    throw new Error("Image tests require an owned organization");
  }
  const fixture = { orgId: actor.orgId, userId: actor.userId };
  const providerRequests = new Set<string>();
  const rememberProviderRequest = ({
    request,
  }: {
    readonly request: Request;
  }) => {
    if (
      request.method === "POST" &&
      new URL(request.url).hostname === "queue.fal.run" &&
      new URL(request.url).searchParams.has("fal_webhook")
    ) {
      providerRequests.add(request.url);
    }
  };
  const environmentNames = [
    "OKOU_API_BACKEND_URL",
    "OKOU_WEB_URL",
    "OPENAI_API_KEY",
    "FAL_KEY",
    "R2_USER_STORAGES_BUCKET_NAME",
    "R2_PRIVATE_ARTIFACTS_BUCKET_NAME",
    "SECRETS_KMS_KEY_ID",
    "SECRETS_ENCRYPTION_KEY",
  ] as const;
  function captureExternalState() {
    const restoreCommon = captureConnectorExternalState(context, [
      "OKOU_PRICE_CUSTOM_CREDIT_UNIT",
    ]);
    const checkout =
      context.mocks.stripe.checkout.sessions.create.getMockImplementation();
    const values = environmentNames.map((name) => {
      return [name, env(name)] as const;
    });
    const handlers = server.listHandlers();
    const restoreIdentity = [
      context.mocks.clerk.authenticateRequest,
      context.mocks.clerk.users.getOrganizationMembershipList,
      context.mocks.clerk.organizations.getOrganizationMembershipList,
      context.mocks.clerk.organizations.getOrganization,
    ].map((mock) => {
      const implementation = mock.getMockImplementation();
      return () => {
        if (implementation) {
          mock.mockImplementation(implementation);
        } else {
          mock.mockReset();
        }
      };
    });
    const send = context.mocks.s3.send.getMockImplementation();
    const sign = context.mocks.s3.getSignedUrl.getMockImplementation();
    const publish = context.mocks.ably.publish.getMockImplementation();
    const createToken =
      context.mocks.ably.createTokenRequest.getMockImplementation();
    return () => {
      restoreCommon();
      context.mocks.stripe.checkout.sessions.create.mockReset();
      if (checkout) {
        context.mocks.stripe.checkout.sessions.create.mockImplementation(
          checkout,
        );
      }
      for (const [name, value] of values) {
        mockEnv(name, value);
      }
      server.resetHandlers(...handlers);
      for (const restore of restoreIdentity) {
        restore();
      }
      if (send) {
        context.mocks.s3.send.mockImplementation(send);
      }
      if (sign) {
        context.mocks.s3.getSignedUrl.mockImplementation(sign);
      }
      if (publish) {
        context.mocks.ably.publish.mockImplementation(publish);
      }
      context.mocks.ably.createTokenRequest.mockReset();
      if (createToken) {
        context.mocks.ably.createTokenRequest.mockImplementation(createToken);
      }
    };
  }
  const runnerGroup = chat.api.configureRunnerGroup();
  let restoreAcceptedState = captureExternalState();
  let restorePreviousState: (() => void) | undefined;
  let restoreSetupExternalState: (() => void) | undefined;
  onTestFinished(() => {
    server.events.removeListener("request:start", rememberProviderRequest);
    restorePreviousState?.();
  });
  server.events.on("request:start", rememberProviderRequest);
  const owner = publicRunOwner(context, actor, {
    restoreEnvironment: () => {
      restorePreviousState ??= captureExternalState();
      restoreAcceptedState();
      restoreSetupExternalState?.();
      if (runnerGroup) {
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", runnerGroup);
      }
    },
    beforeRuns: async () => {
      // The mock provider owns any unfinished accepted image. Settle it through
      // the exact callback URL emitted by the real submission, including on failure.
      const pendingWork = await settleIncludingAbort(flushWaitUntilForTest);
      const results = await Promise.all(
        [...providerRequests].map((requestUrl) => {
          return settleIncludingAbort(() => {
            return postFalWebhookEnvelope(createImageIoTestApp(), requestUrl, {
              status: "ERROR",
              error: "Image provider request cancelled during cleanup",
            });
          });
        }),
      );
      const flushed = await settleIncludingAbort(flushWaitUntilForTest);
      const errors = [pendingWork, ...results, flushed].flatMap((result) => {
        return result.ok ? [] : [result.error];
      });
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Image provider cleanup failed");
      }
    },
    afterRuns: () => {
      return deletePublicWorkspace(context, actor);
    },
  });
  function run<T>(operation: () => Promise<T>): Promise<T> {
    return owner.run(() => {
      const pending = settleIncludingAbort(operation);
      restoreAcceptedState = captureExternalState();
      return pending.then((result) => {
        if (!result.ok) {
          throw result.error;
        }
        return result.value;
      });
    });
  }
  chat.chatCallbacks.acceptChatObjectStorage();
  chat.api.acceptStorageDownloads();
  chat.api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chat.chatCallbacks.disableVapid();
  const { customerId } = await run(() => {
    return chat.api.grantProEntitlement(actor, {
      onExternalStateReady: (restore) => {
        restoreSetupExternalState = restore;
      },
    });
  });
  restoreSetupExternalState = undefined;
  await run(() => {
    return chat.api.ensurePersonalSubscriptionModel(actor);
  });
  const { agentId } = await run(() => {
    return chat.bdd.createAgent(actor, {
      displayName: "BDD chat messages agent",
      description: "Exercises the web chat send route.",
      visibility: "private",
    });
  });
  await run(() => {
    return chat.api.updateUserModelPreference(actor, "claude-fable-5-1");
  });
  await run(() => {
    return useImageModel(fixture, imageModel);
  });
  // Normal Pro activation grants 20,000 credits before the separate purchase.
  await expect(
    run(() => {
      return orgCredits(fixture);
    }),
  ).resolves.toBe(20_000);
  const initialCredits = 20_000 + credits;
  await run(() => {
    return purchaseToolCredits(context, actor, {
      credits,
      customerId,
      invoiceId: `in_image_${randomUUID()}`,
      onExternalStateReady: (restore) => {
        restoreSetupExternalState = restore;
      },
    });
  });
  restoreSetupExternalState = undefined;
  await expect(
    run(() => {
      return orgCredits(fixture);
    }),
  ).resolves.toBe(initialCredits);
  const sent = await run(() => {
    return chat.sendChatRun(actor, {
      agentId,
      prompt: "Generate an image for this Run",
    });
  });
  const claimedRunnerGroup = runnerGroup;
  await run(() => {
    return chat.api.heartbeatRunner(claimedRunnerGroup);
  });
  const claimed = await run(async () => {
    const claim = await chat.api.claimRunnerJob(sent.runId);
    owner.rememberClaim(sent.runId, claim.sandboxToken);
    return {
      ...sent,
      claim,
      sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
    };
  });
  restoreAcceptedState = captureExternalState();
  return {
    ...fixture,
    actor,
    initialCredits,
    runId: claimed.runId,
    claim: claimed.claim,
    run,
    token: okouTokenFromClaim(claimed.claim),
    request(
      app: ReturnType<typeof createImageIoTestApp>,
      ...args: Parameters<ReturnType<typeof createImageIoTestApp>["request"]>
    ) {
      return run(async () => {
        return await app.request(...args);
      });
    },
    cancelRun: () => {
      return run(() => {
        return chat.cancelChatRun(actor, claimed.runId, claimed.sandboxHeaders);
      });
    },
  };
}

async function createFundedImageRun(imageModel: string, credits: number) {
  const fixture = await createClaimedImageRun(imageModel, credits);
  // Only the generation's external storage calls belong in upload assertions.
  context.mocks.s3.send.mockReset();
  context.mocks.s3.send.mockResolvedValue({});
  return fixture;
}

// Callers select the model through the member's image model setting, as the
// product does. Echoing the stored run preference leaves everything but the
// image model unchanged.
async function useImageModel(
  fixture: ImageFixture,
  model: string | null,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const preferences = setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
  const stored = await accept(
    preferences.get({ headers: authHeaders() }),
    [200],
  );
  await accept(
    preferences.update({
      headers: authHeaders(),
      body: {
        selectedModel: stored.body.selectedModel,
        serviceTier: stored.body.serviceTier,
        selectedImageModel:
          model === null ? null : imageModelIdSchema.parse(model),
      },
    }),
    [200],
  );
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
    const fixture = await publicFundedImageFixture({});
    await fixture.run(async () => {
      await useImageModel(fixture, "gpt-image-1");
      mocks.clerk.session(fixture.userId, fixture.orgId);
      let falCalls = 0;
      server.use(
        http.post(FAL_GPT_IMAGE_1_URL, () => {
          falCalls += 1;
          return HttpResponse.json({});
        }),
      );

      const app = createImageIoTestApp(fixture);
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
  });

  it("rejects transparent background requests before provider generation", async () => {
    const fixture = await publicFundedImageFixture({});
    await fixture.run(async () => {
      await useImageModel(fixture, "gpt-image-2");
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
  });

  it.each(GPT_IMAGE_2_5_MODELS)(
    "rejects %s before generation when pricing is missing",
    async (model) => {
      const fixture = await publicFundedImageFixture({ credits: 1000 });
      await fixture.run(async () => {
        await useImageModel(fixture, model);
        mocks.clerk.session(fixture.userId, fixture.orgId);
        let providerCalls = 0;
        server.use(
          http.post(OPENAI_IMAGE_GENERATIONS_URL, () => {
            providerCalls += 1;
            return HttpResponse.json({});
          }),
        );
        const app = createImageIoTestApp(fixture);
        const response = await app.request("/api/image-io/generate", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ prompt: "a product illustration" }),
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
      });
    },
  );

  it("keeps GPT Image 2 limited to its supported quality levels", async () => {
    const fixture = await publicFundedImageFixture({});
    await fixture.run(async () => {
      await useImageModel(fixture, "gpt-image-2");
      mocks.clerk.session(fixture.userId, fixture.orgId);
      const response = await createImageIoTestApp().request(
        "/api/image-io/generate",
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
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
  });

  it("keeps a run's image model snapshot after the member setting changes", async () => {
    const fixture = await createClaimedImageRun("fal-ai/flux-pro/v1.1");
    await fixture.run(async () => {
      await useImageModel(fixture, "gpt-image-1");
      let gptCalls = 0;
      let fluxCalls = 0;
      server.use(
        http.post(FAL_GPT_IMAGE_1_URL, () => {
          gptCalls += 1;
          return HttpResponse.json(falQueueHandle("member-setting-image"));
        }),
        http.post(FAL_FLUX_PRO_11_URL, () => {
          fluxCalls += 1;
          return HttpResponse.json(falQueueHandle("run-snapshot-image"));
        }),
      );
      const app = createImageIoTestApp();

      const runResponse = await fixture.request(app, "/api/image-io/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.token}` },
        body: JSON.stringify({
          prompt: "the run keeps the model it announced",
        }),
      });
      expect(runResponse.status).toBe(202);
      expect(fluxCalls).toBe(1);
      expect(gptCalls).toBe(0);

      // The same member's run-less request uses the updated member setting.
      mocks.clerk.session(fixture.userId, fixture.orgId);
      const sessionResponse = await fixture.request(
        app,
        "/api/image-io/generate",
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ prompt: "a run-less request" }),
        },
      );
      expect(sessionResponse.status).toBe(202);
      expect(gptCalls).toBe(1);
      expect(fluxCalls).toBe(1);
    });
  });
  it("uses the catalog default in a real Run with an unset member preference", async () => {
    const fixture = await createClaimedImageRun(null);
    await fixture.run(async () => {
      const preferences = setupApp({
        context,
        routes: userModelPreferenceRoutes,
      })(userModelPreferenceContract);
      mocks.clerk.session(fixture.userId, fixture.orgId);
      const selected = await accept(
        preferences.get({ headers: authHeaders() }),
        [200],
      );
      expect(selected.body.selectedImageModel).toBeNull();
      expect(fixture.claim.appendSystemPrompt).toContain(
        "Built-in image generation uses \u0060gpt-image-2.5-flare\u0060",
      );
    });
  });

  it("returns 402 when the org has no spendable credits", async () => {
    const fixture = await publicUnfundedImageFixture();
    await fixture.run(async () => {
      await useImageModel(fixture, "gpt-image-1");
      mocks.clerk.session(fixture.userId, fixture.orgId);
      let falCalls = 0;
      server.use(
        http.post(FAL_GPT_IMAGE_1_URL, () => {
          falCalls += 1;
          return HttpResponse.json({});
        }),
      );

      const app = createImageIoTestApp(fixture);
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
  });

  it("settles admitted provider work after the run becomes terminal", async () => {
    const fixture = await createClaimedImageRun("gpt-image-1");
    await fixture.run(async () => {
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
      const { token } = fixture;
      const app = createImageIoTestApp();

      const response = await fixture.request(app, "/api/image-io/generate", {
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
      await fixture.cancelRun();
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
      const statusResponse = await fixture.request(
        app,
        `/api/built-in-generations/${generationId}`,
        { headers: authHeaders() },
      );
      expect(statusResponse.status).toBe(200);
      expect(readGenerationResult(await statusResponse.json())).toMatchObject({
        creditsCharged: 50,
        billingCategory: "output_image.medium.standard",
      });
      await expect(orgCredits(fixture)).resolves.toBe(
        fixture.initialCredits - 50,
      );
    });
  });

  it("limits run-scoped agent token image generations after three active built-ins", async () => {
    const fixture = await createFundedImageRun("gpt-image-1", 10_000);
    await fixture.run(async () => {
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

      const { token } = fixture;
      const app = createImageIoTestApp();
      for (let submission = 0; submission < 3; submission++) {
        const submitted = await fixture.request(app, "/api/image-io/generate", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ prompt: `a pending run image ${submission}` }),
        });
        expect(submitted.status).toBe(202);
      }
      expect(falCalls).toBe(3);

      const response = await fixture.request(app, "/api/image-io/generate", {
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
      await expect(orgCredits(fixture)).resolves.toBe(fixture.initialCredits);
    });
  });

  it("generates image files on the Okou CDN for Okou run-scoped agent tokens", async () => {
    mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
    const fixture = await createFundedImageRun("gpt-image-1", 10_000);
    await fixture.run(async () => {
      await updateFeatureSwitchesForUser(context, fixture, {
        privateArtifacts: false,
      });
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

      const { token } = fixture;
      const app = createImageIoTestApp();
      const response = await fixture.request(app, "/api/image-io/generate", {
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

      const completionPayload = {
        images: [
          {
            url: FAL_GPT_MEDIA_URL,
            width: 1024,
            height: 1024,
            content_type: "image/webp",
          },
        ],
        prompt: "A small robot paints a sunflower.",
      };
      await postFalWebhook(app, observedRequestUrl, completionPayload);
      await flushWaitUntilForTest();
      await postFalWebhook(app, observedRequestUrl, completionPayload);
      await postFalWebhookEnvelope(app, observedRequestUrl, {
        status: "ERROR",
        error: "Invalid status code: 503",
        payload: { detail: { type: "downstream_service_error" } },
      });
      await flushWaitUntilForTest();
      expect(
        context.mocks.ably.publish.mock.calls.filter(([eventName]) => {
          return eventName === `built-in-generation:${generationId}`;
        }),
      ).toHaveLength(1);
      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          return (
            command instanceof PutObjectCommand &&
            command.input.Key?.startsWith("artifacts/")
          );
        }),
      ).toHaveLength(1);
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

      const statusResponse = await fixture.request(
        app,
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

      if (!(
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        "filename" in body &&
        "url" in body
      )) {
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
      // Short file URLs use the policy-aware Worker thumbnail endpoint, which
      // also resolves historical generated files in the shared namespace.
      expect(body).toMatchObject({
        embedUrl: `https://a.okou.io/${publicPath}?thumbnail=1&fit=scale-down&quality=85`,
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
      await expect(orgCredits(fixture)).resolves.toBe(
        fixture.initialCredits - creditsCharged,
      );

      mocks.clerk.session(fixture.userId, fixture.orgId);
      const usageResponse = await fixture.request(app, "/api/usage/record", {
        headers: authHeaders(),
      });
      expect(usageResponse.status).toBe(200);
      await expect(usageResponse.json()).resolves.toMatchObject({
        totalCredits: creditsCharged,
        rows: [
          expect.objectContaining({
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
  });

  it.each([
    {
      detailShape: "a string detail",
      detail: FAL_OUTPUT_SAFETY_FILTER_MESSAGE,
    },
    {
      detailShape: "Pydantic output safety detail with a provider status",
      reportedStatus: 503,
      detail: [
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
    {
      detailShape: "a downstream type without prose or location",
      detail: { type: "downstream_service_unavailable" },
      providerUnavailable: true,
    },
    {
      detailShape: "a status-only provider failure",
      detail: undefined,
      reportedStatus: 429,
      providerUnavailable: true,
    },
  ])(
    "settles Fal failures from $detailShape once and releases admission without charging",
    async ({ detail, reportedStatus = 422, providerUnavailable = false }) => {
      const fixture = await createFundedImageRun("gpt-image-1", 1000);
      await fixture.run(async () => {
        const { token } = fixture;
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

        const app = createImageIoTestApp();
        const response = await fixture.request(app, "/api/image-io/generate", {
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
          error: `Unexpected status code: ${reportedStatus}`,
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

        const expectedError = providerUnavailable
          ? {
              message:
                "The image generation provider is temporarily unavailable.",
              code: "GENERATION_PROVIDER_UNAVAILABLE",
            }
          : {
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
        const statusResponse = await fixture.request(
          app,
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
        await postFalWebhook(app, initialRequestUrl, {
          images: [{ url: FAL_GPT_MEDIA_URL, width: 1024, height: 1024 }],
        });
        await flushWaitUntilForTest();
        const failureEvents = context.mocks.ably.publish.mock.calls.filter(
          ([eventName]) => {
            return eventName === `built-in-generation:${generationId}`;
          },
        );
        expect(failureEvents).toHaveLength(1);
        const repeatedStatusResponse = await fixture.request(
          app,
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

        expect(statusBody).not.toHaveProperty("result");
        expect(falCalls).toBe(1);

        // Three new starts prove that the failed job released its per-run active
        // admission slot instead of remaining in flight.
        for (let index = 0; index < 3; index += 1) {
          const admitted = await fixture.request(
            app,
            "/api/image-io/generate",
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                prompt: `admission proof ${String(index)}`,
              }),
            },
          );
          expect(admitted.status).toBe(202);
        }
        expect(falCalls).toBe(4);
        expect(context.mocks.s3.send).not.toHaveBeenCalled();
        await expect(orgCredits(fixture)).resolves.toBe(fixture.initialCredits);

        mocks.clerk.session(fixture.userId, fixture.orgId);
        const usageResponse = await fixture.request(app, "/api/usage/record", {
          headers: authHeaders(),
        });
        expect(usageResponse.status).toBe(200);
        await expect(usageResponse.json()).resolves.toMatchObject({
          totalCredits: 0,
          rows: [],
        });
      });
    },
  );

  it.each([
    {
      caseName: "input safety rejection despite a provider status",
      reportedStatus: 503,
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
    async ({
      providerErrorType,
      providerMessage,
      location,
      publicError,
      reportedStatus = 422,
    }) => {
      const fixture = await createFundedImageRun("gpt-image-1", 1000);
      await fixture.run(async () => {
        const { token } = fixture;
        const headers = { authorization: `Bearer ${token}` };
        let initialRequestUrl: string | null = null;
        server.use(
          http.post(FAL_GPT_IMAGE_1_URL, ({ request }) => {
            initialRequestUrl = request.url;
            return HttpResponse.json(falQueueHandle("classified-failure"));
          }),
        );

        const app = createImageIoTestApp();
        const response = await fixture.request(app, "/api/image-io/generate", {
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
          error: `Unexpected status code: ${reportedStatus}`,
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
        const statusResponse = await fixture.request(
          app,
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
        await expect(orgCredits(fixture)).resolves.toBe(fixture.initialCredits);
        mocks.clerk.session(fixture.userId, fixture.orgId);
        const usageResponse = await fixture.request(app, "/api/usage/record", {
          headers: authHeaders(),
        });
        expect(usageResponse.status).toBe(200);
        await expect(usageResponse.json()).resolves.toMatchObject({
          totalCredits: 0,
          rows: [],
        });
      });
    },
  );

  it.each<{
    caseName: string;
    status: string;
    wrapper: string;
    error: unknown;
    detail: unknown;
    payloadBody?: unknown;
    providerUnavailable?: boolean;
  }>([
    {
      caseName: "near-match safety text",
      status: "FAILED",
      wrapper: "payload",
      error: "Unexpected status code: 422",
      detail: [
        {
          type: "content_policy_violation",
          loc: ["body", "prompt"],
          // Near-match prose must not invent an output safety classification.
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
      providerUnavailable: true,
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
      providerUnavailable: true,
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
    ...["private-provider-message", 503, true, []]
      .map((payloadBody, index) => {
        return {
          caseName: `unsupported body despite status 503 (${index})`,
          status: "ERROR",
          wrapper: "payload",
          error: "Invalid status code: 503",
          detail: undefined,
          payloadBody,
        };
      })
      .filter((_, index) => {
        return index === 0 || index === 3;
      }),
    ...[429, 500, 502, 503, 504].map((reportedStatus) => {
      return {
        caseName: `status-only provider failure ${reportedStatus}`,
        status: "ERROR",
        wrapper: "payload",
        error: `Unexpected status code: ${reportedStatus}`,
        detail: undefined,
        providerUnavailable: true,
      };
    }),
    ...[200, 400, 401, 403, 422, 501, 505].map((reportedStatus) => {
      return {
        caseName: `status outside the provider fallback set ${reportedStatus}`,
        status: "ERROR",
        wrapper: "payload",
        error: `Invalid status code: ${reportedStatus}`,
        detail: undefined,
      };
    }),
    ...[
      "Invalid status code: 503 private-provider-token",
      "Invalid status code: 503\n",
      "Invalid status code: 503\r\n",
      " Invalid status code: 503",
      "Invalid status code: 0503",
      "Invalid status code: 503.0",
      "Unexpected status code: 999",
      "Unexpected status code: 099",
      503,
      { status: 503 },
    ]
      .map((error, index) => {
        return {
          caseName: `malformed status-only evidence ${index}`,
          status: "ERROR",
          wrapper: "payload",
          error,
          detail: undefined,
        };
      })
      .filter((_, index) => {
        return index !== 8;
      }),
    ...["downstream_service_error", "downstream_service_unavailable"].map(
      (type) => {
        return {
          caseName: `${type} without human-readable fields or a status`,
          status: "FAILED",
          wrapper: "response",
          error: undefined,
          detail: { type },
          providerUnavailable: true,
        };
      },
    ),
    ...[
      {
        type: "file_download_error",
        loc: ["body", "image_urls"],
        msg: "private-provider-message",
      },
      { type: "downstream_service_error:private-provider-token" },
      { type: 503 },
      { type: null },
      null,
      "private-provider-message",
      [null, { type: "downstream_service_error" }],
      [
        { type: "downstream_service_error" },
        { type: "private-provider-token" },
      ],
      [
        { type: "downstream_service_error" },
        {
          type: "content_policy_violation",
          loc: ["body", "prompt"],
          msg: FAL_INPUT_SAFETY_FILTER_MESSAGE,
        },
      ],
      [
        {
          type: "content_policy_violation",
          loc: ["body", "prompt"],
          msg: FAL_INPUT_SAFETY_FILTER_MESSAGE,
        },
        { type: "downstream_service_unavailable" },
      ],
      [
        { type: "file_download_error", msg: "Unrelated provider diagnostic" },
        {
          type: "content_policy_violation",
          loc: ["body", "prompt"],
          msg: FAL_OUTPUT_SAFETY_FILTER_MESSAGE,
        },
      ],
      {
        type: "downstream_service_error",
        msg: FAL_OUTPUT_SAFETY_FILTER_MESSAGE,
      },
      [
        {
          type: "content_policy_violation",
          loc: ["body", "prompt"],
          msg: FAL_INPUT_SAFETY_FILTER_MESSAGE,
        },
        {
          type: "content_policy_violation",
          loc: ["body", "prompt"],
          msg: FAL_OUTPUT_SAFETY_FILTER_MESSAGE,
        },
      ],
    ]
      .map((detail, index) => {
        return {
          caseName: `ambiguous structured evidence despite status 503 (${index})`,
          status: "ERROR",
          wrapper: "payload",
          error: "Invalid status code: 503",
          detail,
        };
      })
      .filter((_, index) => {
        return index !== 3;
      }),
  ])(
    "maps Fal failure evidence for $caseName through status and realtime",
    async ({
      status,
      wrapper,
      error,
      detail,
      payloadBody,
      providerUnavailable = false,
    }) => {
      const fixture = await publicFundedImageFixture({ credits: 1000 });
      await fixture.run(async () => {
        await useImageModel(fixture, "gpt-image-1");
        mocks.clerk.session(fixture.userId, fixture.orgId);
        let observedRequestUrl: string | null = null;
        server.use(
          http.post(FAL_GPT_IMAGE_1_URL, ({ request }) => {
            observedRequestUrl = request.url;
            return HttpResponse.json(falQueueHandle("unknown-failure"));
          }),
        );

        const app = createImageIoTestApp(fixture);
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
          [wrapper]: payloadBody ?? {
            detail,
            input: {
              prompt: "private-unknown-failure-prompt",
              image_url: "https://private.example/reference-unknown.png",
            },
          },
        });
        await flushWaitUntilForTest();

        const expectedError = providerUnavailable
          ? {
              message:
                "The image generation provider is temporarily unavailable.",
              code: "GENERATION_PROVIDER_UNAVAILABLE",
            }
          : { message: "Image generation failed.", code: "GENERATION_FAILED" };
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
        expect(statusBody).not.toHaveProperty("result");
        expect(context.mocks.s3.send).not.toHaveBeenCalled();
        await expect(orgCredits(fixture)).resolves.toBe(1000);
        const usageResponse = await app.request("/api/usage/record", {
          headers: authHeaders(),
        });
        expect(usageResponse.status).toBe(200);
        await expect(usageResponse.json()).resolves.toMatchObject({
          totalCredits: 0,
          rows: [],
        });
      });
    },
  );

  it("does not complete a job after the status route times it out", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "gpt-image-1");
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

      const app = createImageIoTestApp(fixture);
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
  });

  it("rejects a Qwen Image 3 size above the provider's pixel cap", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "alibaba/qwen-image-3/text-to-image");
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
  });

  it("generates fal image files and settles megapixel usage asynchronously", async () => {
    const fixture = await createFundedImageRun("fal-ai/flux-pro/v1.1", 1000);
    await fixture.run(async () => {
      let falCalls = 0;
      let observedAuthorization: string | null = null;
      let observedBody: unknown = null;
      let observedRequestUrl: string | null = null;
      server.use(
        http.post(FAL_FLUX_PRO_11_URL, async ({ request }) => {
          falCalls += 1;
          observedAuthorization = request.headers.get("authorization");
          observedRequestUrl = request.url;
          observedBody = await request.json();
          return HttpResponse.json(falQueueHandle("flux-pro-1-1-request"));
        }),
        http.get(FAL_FLUX_PRO_11_MEDIA_URL, () => {
          return new HttpResponse(IMAGE_BYTES, {
            headers: { "Content-Type": "image/jpeg" },
          });
        }),
      );

      const { token } = fixture;
      const app = createImageIoTestApp();
      const response = await fixture.request(app, "/api/image-io/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "a precise product render",
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
            url: FAL_FLUX_PRO_11_MEDIA_URL,
            width: 1536,
            height: 1024,
            content_type: "image/jpeg",
          },
        ],
        prompt: "A precise product render.",
        seed: 99,
      });
      await flushWaitUntilForTest();

      const statusResponse = await fixture.request(
        app,
        `/api/built-in-generations/${generationId}`,
        { headers: { authorization: `Bearer ${token}` } },
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
        quality: "model-default",
        background: "auto",
        outputFormat: "jpeg",
        billingCategory: "output_megapixel",
        billingQuantity: 2,
        privateArtifacts: true,
        url: expect.stringMatching(
          /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.jpg$/u,
        ),
        seed: 99,
      });
      expect(body).not.toHaveProperty("sourceUrl");
      expect(body).not.toHaveProperty("embedUrl");
      expect(body).not.toHaveProperty("usage");
      expect(falCalls).toBe(1);
      expect(observedAuthorization).toBe("Key test-fal-key");
      expect(observedBody).toStrictEqual({
        prompt: "a precise product render",
        image_size: { width: 1536, height: 1024 },
        num_images: 1,
        output_format: "jpeg",
        seed: 99,
        safety_tolerance: "4",
        enhance_prompt: false,
      });

      if (!(
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        "filename" in body
      )) {
        throw new Error("Expected image response id and filename");
      }
      const fileId = String(body.id);
      const filename = String(body.filename);
      const putInput = putObjectInput();
      expect(putInput.Bucket).toBe("test-private-artifacts");
      expect(putInput.Key).toBe(`private-artifacts/${fileId}/${filename}`);
      expect(putInput.Metadata).toStrictEqual({ "artifact-id": fileId });
      expect(putInput.ContentType).toBe("image/jpeg");

      // The megapixel category/quantity are asserted in the result body above;
      // the single settled charge is observable as the exact balance drop.
      await expect(orgCredits(fixture)).resolves.toBe(
        fixture.initialCredits - 96,
      );
    });
  });

  it("generates image-to-image through fal with 20 percent markup pricing", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "fal-ai/flux-pro/v1.1");
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

      const app = createImageIoTestApp(fixture);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "turn this wireframe into a polished product mockup",
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
        privateArtifacts: true,
        url: expect.stringMatching(
          /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.jpg$/u,
        ),
        sourceImageUrls: [MOCKUP_IMAGE_URL],
        seed: 42,
      });
      expect(body).not.toHaveProperty("sourceUrl");
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
  });

  it("generates with FLUX.2 Pro and bills the first and additional output megapixels", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "fal-ai/flux-2-pro");
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

      const app = createImageIoTestApp(fixture);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "a premium studio campaign with crisp product typography",
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
  });

  it("edits up to nine references with FLUX.2 Pro and uses Fal billing units", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "fal-ai/flux-2-pro");
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

      const app = createImageIoTestApp(fixture);
      const rejected = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "merge ten references",
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
  });

  it("maps Ideogram 4 quality to rendering speed without paid prompt expansion", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "ideogram/v4");
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

      const app = createImageIoTestApp(fixture);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "a typographic launch poster reading ZERO TO ONE",
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
  });

  it("routes Ideogram 4 single-image edits and rejects multiple references", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "ideogram/v4");
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

      const app = createImageIoTestApp(fixture);
      const rejected = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "edit two images",
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
  });

  it("fails Ideogram 4 auto edits when Fal omits billable dimensions", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "ideogram/v4");
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

      const app = createImageIoTestApp(fixture);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "restyle this poster with warmer typography",
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
  });

  it("generates Qwen Image 3 images through fal and bills the standard resolution tier", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "alibaba/qwen-image-3/text-to-image");
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

      const app = createImageIoTestApp(fixture);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "a bilingual conference poster with dense legible typography",
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
        privateArtifacts: true,
        url: expect.stringMatching(
          /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.png$/u,
        ),
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
  });

  it("bills Qwen Image 3 at the high resolution tier above 2,250,000 output pixels", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "alibaba/qwen-image-3/text-to-image");
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

      const app = createImageIoTestApp(fixture);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "a 2K keynote backdrop",
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
  });

  it("edits with Qwen Image 3 through fal and caps its reference images at three", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "alibaba/qwen-image-3/text-to-image");
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

      const app = createImageIoTestApp(fixture);
      const rejected = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "merge these four references",
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
      const shortArtifactUrl = buildFileUrlFromKey(shortArtifactKey, "current");
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
        privateArtifacts: true,
        url: expect.stringMatching(
          /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.png$/u,
        ),
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
  });

  it("generates Nano Banana 2 Lite images through fal at its fixed 1K price", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "google/nano-banana-2-lite");
      mocks.clerk.session(fixture.userId, fixture.orgId);

      let observedBody: Record<string, unknown> | null = null;
      let observedRequestUrl: string | null = null;
      server.use(
        http.post(FAL_NANO_BANANA_2_LITE_URL, async ({ request }) => {
          observedRequestUrl = request.url;
          observedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            falQueueHandle("nano-banana-2-lite-request"),
          );
        }),
        http.get(FAL_NANO_BANANA_2_LITE_MEDIA_URL, () => {
          return new HttpResponse(IMAGE_BYTES, {
            headers: { "Content-Type": "image/png" },
          });
        }),
      );

      const app = createImageIoTestApp(fixture);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "a bright thumbnail for a launch recap",
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
        privateArtifacts: true,
        url: expect.stringMatching(
          /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.png$/u,
        ),
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
  });

  it("generates Nano Banana 2 images through fal with 20 percent markup pricing", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "fal-ai/nano-banana-2");
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

      const app = createImageIoTestApp(fixture);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "a launch poster with crisp product typography",
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
        privateArtifacts: true,
        url: expect.stringMatching(
          /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.webp$/u,
        ),
        seed: 123,
      });
      expect(body).not.toHaveProperty("sourceUrl");
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
  });

  it("edits images with Nano Banana 2 through fal", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "fal-ai/nano-banana-2");
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
          return HttpResponse.json(
            falQueueHandle("nano-banana-2-edit-request"),
          );
        }),
        http.get(FAL_NANO_BANANA_2_MEDIA_URL, () => {
          return new HttpResponse(IMAGE_BYTES, {
            headers: { "Content-Type": "image/png" },
          });
        }),
      );

      const sourceImageUrls = [MOCKUP_IMAGE_URL, SECOND_MOCKUP_IMAGE_URL];
      const app = createImageIoTestApp(fixture);
      const response = await app.request("/api/image-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "combine these references into a polished product campaign",
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
        privateArtifacts: true,
        url: expect.stringMatching(
          /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.png$/u,
        ),
        sourceImageUrls,
      });
      expect(body).not.toHaveProperty("sourceUrl");
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
  });

  it("records a failed job when fal image generation fails", async () => {
    const fixture = await publicFundedImageFixture({ credits: 1000 });
    await fixture.run(async () => {
      await useImageModel(fixture, "gpt-image-1");
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

      const app = createImageIoTestApp(fixture);
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
});
