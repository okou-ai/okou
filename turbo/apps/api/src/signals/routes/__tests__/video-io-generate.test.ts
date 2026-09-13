import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  PutObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";
import type { OrgTier } from "@okouai/api-contracts/contracts/orgs";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { buildArtifactKey, buildFileUrlFromKey } from "../../../lib/file-url";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { videoIoGenerateRoutes } from "../video-io-generate";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { setRunVideoModelFixture } from "../../../test-fixtures/run-video-model";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { seedCompose$, seedRun$ } from "./helpers/usage-state";
import { createRouteMocks } from "./helpers/route-test";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const TEST_BUCKET = "test-user-artifacts";
const VIDEO_BYTES = Buffer.from("fake video bytes");
const VIDEO_IO_MODEL = "dreamina-seedance-2-0-260128";
const SEEDANCE_2_5_MODEL = "dreamina-seedance-2-5-260628";
const SEEDANCE_2_0_MINI_MODEL = "dreamina-seedance-2-0-mini-260615";
const BYTEPLUS_VIDEO_TASKS_URL =
  "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";
const BYTEPLUS_VIDEO_URL =
  "https://ark-content.byteplus.example/files/video-output.mp4";
const MINIMAX_H3_MODEL = "MiniMax-H3";
const MINIMAX_VIDEO_GENERATION_URL =
  "https://api.minimax.io/v2/video_generation";
const MINIMAX_VIDEO_URL = "https://minimax.example/files/h3-video-output.mp4";
const FAL_VEO_FAST_MODEL = "fal-ai/veo3.1/fast";
const FAL_VEO_FAST_QUEUE_URL = `https://queue.fal.run/${FAL_VEO_FAST_MODEL}`;
const FAL_STATUS_URL =
  "https://queue.fal.run/fal-ai/veo3.1/fast/requests/video-request/status";
const FAL_RESPONSE_URL =
  "https://queue.fal.run/fal-ai/veo3.1/fast/requests/video-request/response";
const FAL_VIDEO_URL = "https://v3b.fal.media/files/video-output.mp4";
const KLING_V3_4K_MODEL = "fal-ai/kling-video/v3/4k/text-to-video";
const KLING_V3_4K_QUEUE_URL = `https://queue.fal.run/${KLING_V3_4K_MODEL}`;
const KLING_STATUS_URL =
  "https://queue.fal.run/fal-ai/kling-video/v3/4k/text-to-video/requests/kling-video-request/status";
const KLING_RESPONSE_URL =
  "https://queue.fal.run/fal-ai/kling-video/v3/4k/text-to-video/requests/kling-video-request/response";
const KLING_VIDEO_URL = "https://v3b.fal.media/files/kling-output.mp4";
const CLOUDFLARE_MEDIA_FRAME_URL =
  /^https:\/\/(?:a\.okou|cdn\.(?:vm7|okou))\.io\/cdn-cgi\/media\/mode=frame,time=1s,width=640,format=jpg\//u;
const WEB_ORIGIN = "https://www.okou.test";

const VIDEO_PRICING_DEFAULTS = [
  {
    provider: SEEDANCE_2_5_MODEL,
    category: "output_video_tokens.480p_720p.no_video",
    unitPrice: 13_375,
    unitSize: 1_000_000,
  },
  {
    provider: SEEDANCE_2_5_MODEL,
    category: "output_video_tokens.480p_720p.with_video",
    unitPrice: 8000,
    unitSize: 1_000_000,
  },
  {
    provider: SEEDANCE_2_5_MODEL,
    category: "output_video_tokens.1080p.no_video",
    unitPrice: 14_625,
    unitSize: 1_000_000,
  },
  {
    provider: SEEDANCE_2_5_MODEL,
    category: "output_video_tokens.1080p.with_video",
    unitPrice: 8750,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-260128",
    category: "output_video_tokens.480p_720p.no_video",
    unitPrice: 8750,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-260128",
    category: "output_video_tokens.480p_720p.with_video",
    unitPrice: 5375,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-260128",
    category: "output_video_tokens.1080p.no_video",
    unitPrice: 9625,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-260128",
    category: "output_video_tokens.1080p.with_video",
    unitPrice: 5875,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-fast-260128",
    category: "output_video_tokens.480p_720p.no_video",
    unitPrice: 7000,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-fast-260128",
    category: "output_video_tokens.480p_720p.with_video",
    unitPrice: 4125,
    unitSize: 1_000_000,
  },
  {
    provider: SEEDANCE_2_0_MINI_MODEL,
    category: "output_video_tokens.480p_720p.no_video",
    unitPrice: 4375,
    unitSize: 1_000_000,
  },
  {
    provider: SEEDANCE_2_0_MINI_MODEL,
    category: "output_video_tokens.480p_720p.with_video",
    unitPrice: 2625,
    unitSize: 1_000_000,
  },
  {
    provider: "seedance-1-5-pro-251215",
    category: "output_video_tokens.audio",
    unitPrice: 3000,
    unitSize: 1_000_000,
  },
  {
    provider: "seedance-1-5-pro-251215",
    category: "output_video_tokens.silent",
    unitPrice: 1500,
    unitSize: 1_000_000,
  },
  {
    provider: FAL_VEO_FAST_MODEL,
    category: "output_video_seconds.audio",
    unitPrice: 188,
    unitSize: 1,
  },
  {
    provider: FAL_VEO_FAST_MODEL,
    category: "output_video_seconds.silent",
    unitPrice: 125,
    unitSize: 1,
  },
  {
    provider: FAL_VEO_FAST_MODEL,
    category: "output_video_seconds.audio.4k",
    unitPrice: 438,
    unitSize: 1,
  },
  {
    provider: FAL_VEO_FAST_MODEL,
    category: "output_video_seconds.silent.4k",
    unitPrice: 375,
    unitSize: 1,
  },
  {
    provider: KLING_V3_4K_MODEL,
    category: "output_video_seconds.audio.4k",
    unitPrice: 525,
    unitSize: 1,
  },
  {
    provider: KLING_V3_4K_MODEL,
    category: "output_video_seconds.silent.4k",
    unitPrice: 525,
    unitSize: 1,
  },
  {
    provider: MINIMAX_H3_MODEL,
    category: "output_video_seconds.768p",
    unitPrice: 100,
    unitSize: 1,
  },
  {
    provider: MINIMAX_H3_MODEL,
    category: "output_video_seconds.2k",
    unitPrice: 163,
    unitSize: 1,
  },
  {
    provider: MINIMAX_H3_MODEL,
    category: "input_video_seconds.768p",
    unitPrice: 100,
    unitSize: 1,
  },
  {
    provider: MINIMAX_H3_MODEL,
    category: "input_video_seconds.2k",
    unitPrice: 163,
    unitSize: 1,
  },
  {
    provider: MINIMAX_H3_MODEL,
    category: "input_image.additional",
    unitPrice: 50,
    unitSize: 1,
  },
] as const;

interface VideoFixture {
  readonly orgId: string;
  readonly pricingResolution: UsagePricingFixture["resolution"];
  readonly userId: string;
}

function ownedArtifactReference(userId: string, filename: string) {
  const key = buildArtifactKey(userId, randomUUID(), filename);
  return { key, url: buildFileUrlFromKey(key, "okou") };
}

function expectPresignedArtifactReference(value: unknown, key: string): void {
  if (typeof value !== "string") {
    throw new Error("Expected a provider reference URL");
  }
  const url = new URL(value);
  expect(url.origin).toBe("https://r2.example.com");
  expect(url.searchParams.get("object")).toBe(`${TEST_BUCKET}/${key}`);
}

const VIDEO_PRICING_ROWS = VIDEO_PRICING_DEFAULTS.map((row) => {
  return { ...row, kind: "video" };
});

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createVideoIoTestApp(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...builtInGenerationRoutes,
      ...videoIoGenerateRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
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
    throw new Error("Expected generated video to be uploaded to S3");
  }
  return command.input;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Expected record");
}

function readCallbackUrl(body: unknown): string {
  const value = asRecord(body).callback_url;
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error("Expected BytePlus callback_url");
}

async function postBytePlusWebhook(
  app: ReturnType<typeof createVideoIoTestApp>,
  callbackUrl: string,
  payload: unknown,
): Promise<void> {
  const url = new URL(callbackUrl);
  const response = await app.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
}

async function postMiniMaxWebhook(
  app: ReturnType<typeof createVideoIoTestApp>,
  callbackUrl: string,
  payload: unknown,
): Promise<Response> {
  const url = new URL(callbackUrl);
  return await app.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function readFalWebhookUrl(requestUrl: string | null): string {
  if (requestUrl) {
    const webhookUrl = new URL(requestUrl).searchParams.get("fal_webhook");
    if (webhookUrl) {
      return webhookUrl;
    }
  }
  throw new Error("Expected Fal request fal_webhook query parameter");
}

async function postFalWebhook(
  app: ReturnType<typeof createVideoIoTestApp>,
  requestUrl: string | null,
  payload: unknown,
): Promise<void> {
  await postFalWebhookEnvelope(app, requestUrl, {
    status: "COMPLETED",
    payload,
  });
}

async function postFalWebhookEnvelope(
  app: ReturnType<typeof createVideoIoTestApp>,
  requestUrl: string | null,
  payload: unknown,
): Promise<void> {
  const url = new URL(readFalWebhookUrl(requestUrl));
  const response = await app.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
}

function readAcceptedGenerationId(
  body: unknown,
  type: "video",
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
      tokenRequest: {
        keyName: "test-key",
        timestamp: 1_700_000_000_000,
        capability: '{"user:test-user":["subscribe"]}',
        clientId: "test-user",
        nonce: "test-nonce",
        mac: "test-mac",
      },
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

// Org/user isolation comes from random IDs. Pricing cleanup only bounds rows
// owned by this request scope.
async function seedVideoFixture(
  options: {
    readonly credits?: number;
    readonly missingPricing?: boolean;
    readonly tier?: OrgTier;
  } = {},
): Promise<VideoFixture> {
  const pricing = await createUsagePricingFixture(
    options.missingPricing
      ? {
          missing: VIDEO_PRICING_ROWS.filter((row) => {
            return row.provider === VIDEO_IO_MODEL;
          }),
        }
      : { configured: VIDEO_PRICING_ROWS },
  );
  onTestFinished(pricing.cleanup);
  const fixture = {
    orgId: `org_${randomUUID()}`,
    pricingResolution: pricing.resolution,
    userId: `user_${randomUUID()}`,
  };

  await seedOrgMetadata({
    orgId: fixture.orgId,
    tier: options.tier ?? "free",
    credits: options.credits ?? 10_000,
  });
  await store.set(
    seedOrgMembership$,
    { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
    context.signal,
  );

  return fixture;
}

// Reads the org credit balance through the product billing surface so charge
// assertions stay on externally observable state.
async function orgCredits(fixture: VideoFixture): Promise<number> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const app = createVideoIoTestApp(fixture.pricingResolution);
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

describe("POST /api/video-io/generate", () => {
  beforeEach(() => {
    mockEnv("OKOU_API_BACKEND_URL", WEB_ORIGIN);
    mockEnv("OKOU_WEB_URL", WEB_ORIGIN);
    server.use(
      http.get(CLOUDFLARE_MEDIA_FRAME_URL, () => {
        return new HttpResponse("video poster unavailable in route fixture", {
          status: 404,
        });
      }),
    );
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.ably.createTokenRequest.mockResolvedValue({
      keyName: "test-key",
      timestamp: 1_700_000_000_000,
      capability: '{"user:test-user":["subscribe"]}',
      clientId: "test-user",
      nonce: "test-nonce",
      mac: "test-mac",
    });
  });

  it("returns 401 when not authenticated", async () => {
    const app = createVideoIoTestApp();
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "a city at night" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("rejects unsupported durations before BytePlus", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        calledBytePlus = true;
        return HttpResponse.json({});
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city", duration: "3s" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Unsupported video duration for dreamina-seedance-2.0: 3s",
        code: "BAD_REQUEST",
      },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it("rejects BytePlus 4k requests before provider submission", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        calledBytePlus = true;
        return HttpResponse.json({});
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a city",
        model: "dreamina-seedance-2.0",
        resolution: "4k",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Unsupported video resolution for dreamina-seedance-2.0: 4k",
        code: "BAD_REQUEST",
      },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it.each([
    {
      firstFrameImageUrl: "https://example.com/first.png",
      imageUrls: ["https://example.com/reference.png"],
    },
    {
      firstFrameImageUrl: "https://example.com/first.png",
      videoUrls: ["https://example.com/reference.mp4"],
    },
    {
      firstFrameImageUrl: "https://example.com/first.png",
      audioUrls: ["https://example.com/reference.mp3"],
    },
    {
      lastFrameImageUrl: "https://example.com/last.png",
      imageUrls: ["https://example.com/reference.png"],
    },
    {
      lastFrameImageUrl: "https://example.com/last.png",
      videoUrls: ["https://example.com/reference.mp4"],
    },
    {
      lastFrameImageUrl: "https://example.com/last.png",
      audioUrls: ["https://example.com/reference.mp3"],
    },
    {
      first_frame_image_url: " https://example.com/first.png ",
      reference_video_urls: ["https://example.com/reference.mp4"],
    },
    {
      model: "dreamina-seedance-2.5",
      firstFrameImageUrl: "https://example.com/first.png",
      lastFrameImageUrl: "https://example.com/last.png",
      imageUrls: ["https://example.com/reference.png"],
      videoUrls: ["https://example.com/reference.mp4"],
      audioUrls: ["https://example.com/reference.mp3"],
    },
    {
      model: "dreamina-seedance-2.0-fast",
      firstFrameImageUrl: "https://example.com/first.png",
      imageUrls: ["https://example.com/reference.png"],
    },
    {
      model: "dreamina-seedance-2.0-mini",
      firstFrameImageUrl: "https://example.com/first.png",
      imageUrls: ["https://example.com/reference.png"],
    },
    {
      model: "seedance-1.5-pro",
      firstFrameImageUrl: "https://example.com/first.png",
      imageUrls: ["https://example.com/reference.png"],
    },
  ])(
    "rejects conflicting BytePlus frame and reference inputs %# before starting a job",
    async (inputs) => {
      const fixture = await seedVideoFixture({ credits: 0 });
      mocks.clerk.session(fixture.userId, fixture.orgId);
      let calledBytePlus = false;
      server.use(
        http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
          calledBytePlus = true;
          return HttpResponse.json({ id: "unexpected-byteplus-task" });
        }),
      );

      const app = createVideoIoTestApp(fixture.pricingResolution);
      const response = await app.request("/api/video-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: "animate the supplied media",
          ...inputs,
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message:
            "BytePlus frame images and reference media cannot be combined. Choose either first/last frames or reference images, videos, and audio.",
        },
      });
      expect(calledBytePlus).toBeFalsy();
      expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
      expect(context.mocks.ably.publish).not.toHaveBeenCalled();
      expect(context.mocks.s3.send).not.toHaveBeenCalled();
      await expect(orgCredits(fixture)).resolves.toBe(0);
    },
  );

  it("returns 402 when the org has no spendable credits", async () => {
    const fixture = await seedVideoFixture({ credits: 0 });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city" }),
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
  });

  it.each(["limited-free-1", "pro-suspend"] as const)(
    "returns 402 with the paid-plan upgrade message for %s orgs",
    async (tier) => {
      const fixture = await seedVideoFixture({
        credits: 10_000,
        tier,
      });
      mocks.clerk.session(fixture.userId, fixture.orgId);
      let calledBytePlus = false;
      server.use(
        http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
          calledBytePlus = true;
          return HttpResponse.json({});
        }),
      );

      const app = createVideoIoTestApp(fixture.pricingResolution);
      const response = await app.request("/api/video-io/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ prompt: "a city" }),
      });

      expect(response.status).toBe(402);
      await expect(response.json()).resolves.toStrictEqual({
        error: {
          message:
            "Built-in video generation requires Pro, Team, or Custom workspace access.",
          code: "PRO_REQUIRED",
        },
      });
      expect(calledBytePlus).toBeFalsy();
    },
  );

  it("allows Team orgs to submit paid video generation", async () => {
    const fixture = await seedVideoFixture({
      credits: 10_000,
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        calledBytePlus = true;
        await request.json();
        return HttpResponse.json({
          id: "team-video-task",
          status: "queued",
        });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city" }),
    });

    expect(response.status).toBe(202);
    readAcceptedGenerationId(await response.json(), "video", fixture.userId);
    expect(calledBytePlus).toBeTruthy();
  });

  it("allows Custom orgs to submit paid video generation", async () => {
    const fixture = await seedVideoFixture({
      credits: 10_000,
      tier: "custom",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        calledBytePlus = true;
        await request.json();
        return HttpResponse.json({
          id: "custom-video-task",
          status: "queued",
        });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city" }),
    });

    expect(response.status).toBe(202);
    readAcceptedGenerationId(await response.json(), "video", fixture.userId);
    expect(calledBytePlus).toBeTruthy();
  });

  it("keeps the request model over the run's default video model and reports it", async () => {
    // The run's model is a default, not an override. A caller that names a
    // model — because the user named one in the prompt — gets that model, and
    // its own parameters survive with it even when the default could not have
    // honoured them: the Kling pin is 4k-only, and 1080p still reaches Veo.
    const fixture = await seedVideoFixture();
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
    await setRunVideoModelFixture({
      runId,
      selectedVideoModel: KLING_V3_4K_MODEL,
    });

    let observedRequestUrl: string | null = null;
    let calledKling = false;
    server.use(
      http.post(FAL_VEO_FAST_QUEUE_URL, ({ request }) => {
        observedRequestUrl = request.url;
        return HttpResponse.json({
          request_id: "requested-veo-request",
          status_url: FAL_STATUS_URL,
          response_url: FAL_RESPONSE_URL,
        });
      }),
      http.post(KLING_V3_4K_QUEUE_URL, () => {
        calledKling = true;
        return HttpResponse.json({
          request_id: "unexpected-kling-request",
          status_url: KLING_STATUS_URL,
          response_url: KLING_RESPONSE_URL,
        });
      }),
      http.get(FAL_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a vertical concert stage reveal",
        model: "veo3.1-fast",
        duration: "8s",
        resolution: "1080p",
        aspectRatio: "9:16",
        generateAudio: true,
      }),
    });

    expect(response.status).toBe(202);
    expect(calledKling).toBeFalsy();
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    await postFalWebhook(app, observedRequestUrl, {
      video: {
        url: FAL_VIDEO_URL,
        content_type: "video/mp4",
      },
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      model: FAL_VEO_FAST_MODEL,
      resolution: "1080p",
      requestId: "requested-veo-request",
    });
  });

  it("rejects a resolution the request model cannot honour", async () => {
    // The caller chose both the model and the resolution, so the mismatch is
    // its own and the normal validation error is the right answer. The error
    // names the model the caller sent, never the run's default.
    const fixture = await seedVideoFixture();
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
    await setRunVideoModelFixture({
      runId,
      selectedVideoModel: KLING_V3_4K_MODEL,
    });

    let calledFal = false;
    server.use(
      http.post(FAL_VEO_FAST_QUEUE_URL, () => {
        calledFal = true;
        return HttpResponse.json({ request_id: "unexpected-veo-request" });
      }),
      http.post(KLING_V3_4K_QUEUE_URL, () => {
        calledFal = true;
        return HttpResponse.json({ request_id: "unexpected-kling-request" });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a vertical concert stage reveal",
        model: "veo3.1-fast",
        resolution: "2k",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Unsupported video resolution for veo3.1-fast: 2k",
        code: "BAD_REQUEST",
      },
    });
    expect(calledFal).toBeFalsy();
  });

  it("applies the run's video model when the request sends a blank model", async () => {
    // `parseVideoOptions` reads `model` through a helper that treats a blank
    // value as unset, so a caller sending `model: ""` has named nothing. If the
    // route answered that question differently it would skip the run's model
    // and silently generate with the catalog default instead.
    const fixture = await seedVideoFixture();
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
    await setRunVideoModelFixture({
      runId,
      selectedVideoModel: KLING_V3_4K_MODEL,
    });

    let calledKling = false;
    let calledBytePlus = false;
    server.use(
      http.post(KLING_V3_4K_QUEUE_URL, () => {
        calledKling = true;
        return HttpResponse.json({
          request_id: "blank-model-kling-request",
          status_url: KLING_STATUS_URL,
          response_url: KLING_RESPONSE_URL,
        });
      }),
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        calledBytePlus = true;
        return HttpResponse.json({ id: "unexpected-byteplus-task" });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a vertical concert stage reveal",
        model: "",
      }),
    });

    expect(response.status).toBe(202);
    expect(calledKling).toBeTruthy();
    expect(calledBytePlus).toBeFalsy();
  });

  it("applies the run's video model when the request names none", async () => {
    const fixture = await seedVideoFixture();
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
    await setRunVideoModelFixture({
      runId,
      selectedVideoModel: KLING_V3_4K_MODEL,
    });

    let observedRequestUrl: string | null = null;
    server.use(
      http.post(KLING_V3_4K_QUEUE_URL, ({ request }) => {
        observedRequestUrl = request.url;
        return HttpResponse.json({
          request_id: "pinned-kling-request",
          status_url: KLING_STATUS_URL,
          response_url: KLING_RESPONSE_URL,
        });
      }),
      http.get(KLING_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a vertical concert stage reveal",
        duration: "5s",
        aspectRatio: "9:16",
        generateAudio: true,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    await postFalWebhook(app, observedRequestUrl, {
      video: {
        url: KLING_VIDEO_URL,
        content_type: "video/mp4",
      },
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      model: KLING_V3_4K_MODEL,
      resolution: "4k",
      requestId: "pinned-kling-request",
    });
  });

  it("drops a request parameter the run's video model cannot honour", async () => {
    // Reproduces the production failure: the caller sized its parameters for
    // whichever model it assumed it would get, the run's default replaced that
    // assumption, and the request died on
    // `Unsupported video resolution for minimax-h3: 720p` — an error naming a
    // model the caller never sent. 720p is valid for the catalog default and
    // invalid for the Kling pin. Only reachable when the request names no
    // model; a request that names one keeps its own parameters.
    const fixture = await seedVideoFixture();
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
    await setRunVideoModelFixture({
      runId,
      selectedVideoModel: KLING_V3_4K_MODEL,
    });

    let observedRequestUrl: string | null = null;
    server.use(
      http.post(KLING_V3_4K_QUEUE_URL, ({ request }) => {
        observedRequestUrl = request.url;
        return HttpResponse.json({
          request_id: "reconciled-kling-request",
          status_url: KLING_STATUS_URL,
          response_url: KLING_RESPONSE_URL,
        });
      }),
      http.get(KLING_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a fluffy golden retriever puppy",
        resolution: "720p",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    await postFalWebhook(app, observedRequestUrl, {
      video: {
        url: KLING_VIDEO_URL,
        content_type: "video/mp4",
      },
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    // The run model's own resolution, not the one the caller sized for the
    // model it assumed, and reported back so the caller can say what was used.
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      model: KLING_V3_4K_MODEL,
      resolution: "4k",
    });
  });

  it("keeps the request model when the run video model snapshot is null", async () => {
    const fixture = await seedVideoFixture();
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
    await setRunVideoModelFixture({ runId, selectedVideoModel: null });

    let calledFal = false;
    server.use(
      http.post(FAL_VEO_FAST_QUEUE_URL, () => {
        calledFal = true;
        return HttpResponse.json({
          request_id: "legacy-null-pin-request",
          status_url: FAL_STATUS_URL,
          response_url: FAL_RESPONSE_URL,
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a city at night",
        model: "veo3.1-fast",
        duration: "8s",
        resolution: "4k",
        aspectRatio: "16:9",
      }),
    });

    expect(response.status).toBe(202);
    expect(calledFal).toBeTruthy();
  });

  it("keeps the request model for callers without a run ID", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledMiniMax = false;
    server.use(
      http.post(MINIMAX_VIDEO_GENERATION_URL, () => {
        calledMiniMax = true;
        return HttpResponse.json({ task_id: "session-minimax-request" });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a city at night",
        model: "h3",
        duration: "5s",
        resolution: "2k",
        aspectRatio: "16:9",
      }),
    });

    expect(response.status).toBe(202);
    expect(calledMiniMax).toBeTruthy();
  });

  it("returns 503 when video pricing is not configured", async () => {
    const fixture = await seedVideoFixture({
      credits: 1000,
      missingPricing: true,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        calledBytePlus = true;
        return HttpResponse.json({});
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Video generation pricing is not configured",
        code: "NOT_CONFIGURED",
      },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it.each([false, true])(
    "generates BytePlus video using the submission policy (private=%s)",
    async (privateArtifacts) => {
      const fixture = await seedVideoFixture();
      await updateFeatureSwitchesForUser(context, fixture, {
        [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
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

      let observedAuthorization: string | null = null;
      let observedBody: unknown = null;
      server.use(
        http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
          observedAuthorization = request.headers.get("authorization");
          observedBody = await request.json();
          return HttpResponse.json({
            id: "byteplus-video-task",
            status: "queued",
          });
        }),
        http.get(BYTEPLUS_VIDEO_URL, () => {
          return new HttpResponse(VIDEO_BYTES, {
            headers: { "content-type": "video/mp4" },
          });
        }),
      );

      const token = okouToken({
        userId: fixture.userId,
        orgId: fixture.orgId,
        runId,
      });
      const app = createVideoIoTestApp(fixture.pricingResolution);
      const response = await app.request("/api/video-io/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt: "a cinematic tracking shot through a neon market",
          duration: "8s",
          resolution: "720p",
          aspectRatio: "16:9",
          generateAudio: true,
        }),
      });

      expect(response.status).toBe(202);
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "video",
        fixture.userId,
      );

      await updateFeatureSwitchesForUser(context, fixture, {
        [FeatureSwitchKey.PrivateArtifacts]: !privateArtifacts,
      });
      const callbackUrl = readCallbackUrl(observedBody);
      await postBytePlusWebhook(app, callbackUrl, {
        id: "byteplus-video-task",
        model: VIDEO_IO_MODEL,
        status: "succeeded",
        content: {
          video_url: BYTEPLUS_VIDEO_URL,
        },
        usage: {
          completion_tokens: 123_456,
        },
      });
      await flushWaitUntilForTest();
      const webhookUrl = new URL(callbackUrl);
      expect(webhookUrl.origin).toBe(WEB_ORIGIN);
      expect(webhookUrl.pathname).toBe(
        `/api/webhooks/built-in-generations/byteplus/${generationId}`,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        `built-in-generation:${generationId}`,
        expect.objectContaining({
          generationId,
          type: "video",
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
        type: "video",
        status: "completed",
      });
      const body = readGenerationResult(statusBody);
      expect(body).toMatchObject({
        contentType: "video/mp4",
        size: VIDEO_BYTES.byteLength,
        creditsCharged: 1081,
        model: VIDEO_IO_MODEL,
        aspectRatio: "16:9",
        duration: "8s",
        durationSeconds: 8,
        resolution: "720p",
        generateAudio: true,
        ...(privateArtifacts ? {} : { sourceUrl: BYTEPLUS_VIDEO_URL }),
        requestId: "byteplus-video-task",
      });
      expect(observedAuthorization).toBe("Bearer test-byteplus-key");
      expect(observedBody).toMatchObject({
        model: VIDEO_IO_MODEL,
        content: [
          {
            type: "text",
            text: "a cinematic tracking shot through a neon market",
          },
        ],
        callback_url: callbackUrl,
        resolution: "720p",
        ratio: "16:9",
        duration: 8,
        generate_audio: true,
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
        throw new Error("Expected video response id, filename, and url");
      }
      const fileId = String(body.id);
      const filename = String(body.filename);
      const url = String(body.url);
      expect(filename).toBe(`video-${fileId.slice(0, 8)}.mp4`);

      const putInput = putObjectInput();
      if (privateArtifacts) {
        expect(body).not.toHaveProperty("sourceUrl");
        expect(putInput.Bucket).toBe("test-private-artifacts");
        expect(putInput.Key).toBe(`private-artifacts/${fileId}/${filename}`);
        expect(url).toBe(artifactReferencePath(fileId, filename));
        expect(
          JSON.stringify(context.mocks.ably.publish.mock.calls),
        ).not.toContain(BYTEPLUS_VIDEO_URL);
      } else {
        expect(putInput.Bucket).toBe(TEST_BUCKET);
        expect(putInput.Key).toMatch(/^artifacts\/[0-9a-z]{10}\.mp4$/u);
        expect(url).toBe(
          `https://a.okou.io/${String(putInput.Key).replace(/^artifacts\//u, "")}`,
        );
        expect(putInput.Metadata).toStrictEqual({
          "artifact-id": fileId,
          filename: encodeURIComponent(filename),
          "public-brand": "okou",
          "user-id": encodeURIComponent(fixture.userId),
        });
      }
      expect(putInput.ContentType).toBe("video/mp4");
      const putBody = putInput.Body;
      expect(Buffer.isBuffer(putBody)).toBeTruthy();
      if (!Buffer.isBuffer(putBody)) {
        throw new Error("Expected S3 put body to be a Buffer");
      }
      expect(putBody).toStrictEqual(VIDEO_BYTES);

      // The callback-token charge (123,456 tokens at the no-video 720p rate) is
      // asserted through the result body above and the exact org balance drop,
      // observed on the product billing surface.
      await expect(orgCredits(fixture)).resolves.toBe(10_000 - 1081);
    },
  );

  it("generates Seedance 2.0 Mini with video references and list-price gross-margin pricing", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "seedance-2-0-mini-video-task",
          status: "queued",
        });
      }),
      http.get(BYTEPLUS_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a cinematic product reveal",
        model: "dreamina-seedance-2.0-mini",
        duration: "8s",
        resolution: "720p",
        aspectRatio: "16:9",
        videoUrls: ["https://example.com/reference.mp4"],
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    const callbackUrl = readCallbackUrl(observedBody);
    expect(observedBody).toMatchObject({
      model: SEEDANCE_2_0_MINI_MODEL,
      callback_url: callbackUrl,
      resolution: "720p",
      ratio: "16:9",
      duration: 8,
      generate_audio: true,
    });
    const content = asRecord(observedBody).content;
    expect(Array.isArray(content)).toBeTruthy();
    if (!Array.isArray(content)) {
      throw new Error("Expected BytePlus content array");
    }
    expect(content).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "video_url",
          video_url: { url: "https://example.com/reference.mp4" },
          role: "reference_video",
        }),
      ]),
    );

    await postBytePlusWebhook(app, callbackUrl, {
      id: "seedance-2-0-mini-video-task",
      model: SEEDANCE_2_0_MINI_MODEL,
      status: "succeeded",
      content: { video_url: BYTEPLUS_VIDEO_URL },
      usage: { completion_tokens: 100_000 },
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      creditsCharged: 263,
      model: SEEDANCE_2_0_MINI_MODEL,
      duration: "8s",
      durationSeconds: 8,
      resolution: "720p",
      sourceUrl: BYTEPLUS_VIDEO_URL,
      requestId: "seedance-2-0-mini-video-task",
    });
    await expect(orgCredits(fixture)).resolves.toBe(10_000 - 263);
  });

  it("generates Seedance 2.5 at 1080p with expanded references and 25% markup", async () => {
    const fixture = await seedVideoFixture({ credits: 20_000 });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const referenceImageUrls = Array.from({ length: 30 }, (_, index) => {
      return `https://example.com/reference-${index + 1}.png`;
    });
    const referenceVideoUrls = Array.from({ length: 10 }, (_, index) => {
      return `https://example.com/reference-${index + 1}.mp4`;
    });
    const referenceAudioUrls = Array.from({ length: 10 }, (_, index) => {
      return `https://example.com/reference-${index + 1}.mp3`;
    });
    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "seedance-2-5-video-task",
          status: "queued",
        });
      }),
      http.get(BYTEPLUS_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "tell a complete cinematic story",
        model: "dreamina-seedance-2.5",
        duration: "30s",
        resolution: "1080p",
        aspectRatio: "16:9",
        imageUrls: referenceImageUrls,
        videoUrls: referenceVideoUrls,
        audioUrls: referenceAudioUrls,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    const callbackUrl = readCallbackUrl(observedBody);
    expect(observedBody).toMatchObject({
      model: SEEDANCE_2_5_MODEL,
      callback_url: callbackUrl,
      resolution: "1080p",
      ratio: "16:9",
      duration: 30,
      generate_audio: true,
    });
    const content = asRecord(observedBody).content;
    expect(Array.isArray(content)).toBeTruthy();
    if (!Array.isArray(content)) {
      throw new Error("Expected BytePlus content array");
    }
    expect(content).toHaveLength(51);
    const roles = content.map((entry) => {
      return asRecord(entry).role;
    });
    expect(
      roles.filter((role) => {
        return role === "reference_image";
      }),
    ).toHaveLength(30);
    expect(
      roles.filter((role) => {
        return role === "reference_video";
      }),
    ).toHaveLength(10);
    expect(
      roles.filter((role) => {
        return role === "reference_audio";
      }),
    ).toHaveLength(10);

    await postBytePlusWebhook(app, callbackUrl, {
      id: "seedance-2-5-video-task",
      model: SEEDANCE_2_5_MODEL,
      status: "succeeded",
      content: { video_url: BYTEPLUS_VIDEO_URL },
      usage: { completion_tokens: 100_000 },
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      creditsCharged: 875,
      model: SEEDANCE_2_5_MODEL,
      duration: "30s",
      durationSeconds: 30,
      resolution: "1080p",
      sourceUrl: BYTEPLUS_VIDEO_URL,
      requestId: "seedance-2-5-video-task",
    });
    await expect(orgCredits(fixture)).resolves.toBe(20_000 - 875);
  });

  it("allows Seedance 2.5 audio-only references", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "seedance-2-5-audio-task",
          status: "queued",
        });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "follow the rhythm and instrumentation",
        model: "dreamina-seedance-2.5",
        audioUrls: ["https://example.com/reference.mp3"],
      }),
    });

    expect(response.status).toBe(202);
    expect(observedBody).toMatchObject({
      model: SEEDANCE_2_5_MODEL,
      content: [
        {
          type: "text",
          text: "follow the rhythm and instrumentation",
        },
        {
          type: "audio_url",
          audio_url: { url: "https://example.com/reference.mp3" },
          role: "reference_audio",
        },
      ],
    });
  });

  it("submits Seedance 2.5 frame generation with its required adaptive ratio", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "seedance-2-5-frame-task",
          status: "queued",
        });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "animate the opening frame",
        model: "dreamina-seedance-2.5",
        aspectRatio: "4:3",
        firstFrameImageUrl: "https://example.com/first.png",
      }),
    });

    expect(response.status).toBe(202);
    expect(observedBody).toMatchObject({
      model: SEEDANCE_2_5_MODEL,
      ratio: "adaptive",
      content: [
        { type: "text", text: "animate the opening frame" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/first.png" },
          role: "first_frame",
        },
      ],
    });
  });

  it("submits a single Dreamina first-frame image without a frame role", async () => {
    const fixture = await seedVideoFixture();
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

    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "dreamina-video-task",
          status: "queued",
        });
      }),
      http.get(BYTEPLUS_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "animate the photo with natural motion",
        model: "dreamina-seedance-2.0",
        duration: "6s",
        resolution: "720p",
        aspectRatio: "4:3",
        firstFrameImageUrl: "https://example.com/first.png",
      }),
    });

    expect(response.status).toBe(202);
    const callbackUrl = readCallbackUrl(observedBody);

    await postBytePlusWebhook(app, callbackUrl, {
      id: "dreamina-video-task",
      status: "succeeded",
      content: {
        video_url: {
          url: BYTEPLUS_VIDEO_URL,
          content_type: "video/mp4",
        },
      },
      usage: {
        completion_tokens: 100_000,
      },
    });
    await flushWaitUntilForTest();

    expect(observedBody).toMatchObject({
      model: "dreamina-seedance-2-0-260128",
      resolution: "720p",
      ratio: "4:3",
      duration: 6,
      generate_audio: true,
      content: [
        {
          type: "text",
          text: "animate the photo with natural motion",
        },
        {
          type: "image_url",
          image_url: { url: "https://example.com/first.png" },
        },
      ],
    });
    const content = asRecord(observedBody).content;
    expect(Array.isArray(content)).toBeTruthy();
    if (!Array.isArray(content)) {
      throw new Error("Expected BytePlus content array");
    }
    expect(asRecord(content[1]).role).toBeUndefined();
  });

  it("submits Dreamina first and last frames without reference media", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const firstFrame = ownedArtifactReference(fixture.userId, "first.png");
    const lastFrame = ownedArtifactReference(fixture.userId, "last.png");
    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "dreamina-frame-task",
          status: "queued",
        });
      }),
    );

    const response = await createVideoIoTestApp(
      fixture.pricingResolution,
    ).request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "animate between the opening and closing frames",
        firstFrameImageUrl: firstFrame.url,
        lastFrameImageUrl: lastFrame.url,
        imageUrls: [],
        videoUrls: [],
        audioUrls: [],
        generateAudio: true,
      }),
    });

    expect(response.status).toBe(202);
    expect(observedBody).toMatchObject({
      generate_audio: true,
      content: [
        {
          type: "text",
          text: "animate between the opening and closing frames",
        },
        {
          type: "image_url",
          image_url: { url: expect.any(String) },
          role: "first_frame",
        },
        {
          type: "image_url",
          image_url: { url: expect.any(String) },
          role: "last_frame",
        },
      ],
    });
    const content = asRecord(observedBody).content;
    if (!Array.isArray(content)) {
      throw new Error("Expected BytePlus content array");
    }
    expectPresignedArtifactReference(
      asRecord(asRecord(content[1]).image_url).url,
      firstFrame.key,
    );
    expectPresignedArtifactReference(
      asRecord(asRecord(content[2]).image_url).url,
      lastFrame.key,
    );
  });

  it("submits multimodal Dreamina references and charges with-video pricing", async () => {
    const fixture = await seedVideoFixture({ credits: 10_000 });
    const imageReference = ownedArtifactReference(
      fixture.userId,
      "reference.png",
    );
    const videoReference = ownedArtifactReference(
      fixture.userId,
      "reference.mp4",
    );
    const audioReference = ownedArtifactReference(
      fixture.userId,
      "reference.mp3",
    );
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

    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "dreamina-video-task",
          status: "queued",
        });
      }),
      http.get(BYTEPLUS_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "preserve the character while matching the soundtrack",
        model: "dreamina-seedance-2.0",
        duration: "6s",
        resolution: "1080p",
        aspectRatio: "16:9",
        imageUrls: [imageReference.url],
        videoUrls: [videoReference.url],
        audioUrls: [audioReference.url],
        seed: 42,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    const callbackUrl = readCallbackUrl(observedBody);

    await postBytePlusWebhook(app, callbackUrl, {
      id: "dreamina-video-task",
      status: "succeeded",
      content: {
        video_url: {
          url: BYTEPLUS_VIDEO_URL,
          content_type: "video/mp4",
        },
      },
      usage: {
        completion_tokens: 200_000,
      },
    });
    await flushWaitUntilForTest();

    expect(observedBody).toMatchObject({
      model: "dreamina-seedance-2-0-260128",
      resolution: "1080p",
      ratio: "16:9",
      duration: 6,
      generate_audio: true,
      seed: 42,
      content: [
        {
          type: "text",
          text: "preserve the character while matching the soundtrack",
        },
        {
          type: "image_url",
          image_url: { url: expect.any(String) },
          role: "reference_image",
        },
        {
          type: "video_url",
          video_url: { url: expect.any(String) },
          role: "reference_video",
        },
        {
          type: "audio_url",
          audio_url: { url: expect.any(String) },
          role: "reference_audio",
        },
      ],
    });
    const providerContent = asRecord(observedBody).content;
    if (!Array.isArray(providerContent)) {
      throw new Error("Expected BytePlus content array");
    }
    expectPresignedArtifactReference(
      asRecord(asRecord(providerContent[1]).image_url).url,
      imageReference.key,
    );
    expectPresignedArtifactReference(
      asRecord(asRecord(providerContent[2]).video_url).url,
      videoReference.key,
    );
    expectPresignedArtifactReference(
      asRecord(asRecord(providerContent[3]).audio_url).url,
      audioReference.key,
    );

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      creditsCharged: 1175,
      model: "dreamina-seedance-2-0-260128",
      sourceUrl: BYTEPLUS_VIDEO_URL,
      requestId: "dreamina-video-task",
    });

    // creditsCharged 1175 = 200,000 tokens at the 1080p with-video rate
    // (5875/1M); the no-video rate would charge 1925, so the exact balance
    // drop pins the with-video pricing category.
    await expect(orgCredits(fixture)).resolves.toBe(10_000 - 1175);
  });

  it("generates MiniMax H3 with full references and charges every billed usage component", async () => {
    const fixture = await seedVideoFixture();
    const ownedImageReference = ownedArtifactReference(
      fixture.userId,
      "minimax-reference.png",
    );
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
    const referenceImageUrls = [
      ownedImageReference.url,
      ...Array.from({ length: 6 }, (_, index) => {
        return `https://example.com/reference-${index + 2}.png`;
      }),
    ];
    const referenceAudioUrls = [
      "https://example.com/reference-1.mp3",
      "https://example.com/reference-2.mp3",
      "https://example.com/reference-3.mp3",
    ];
    const referenceVideoUrl = "https://example.com/reference.mp4";

    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(MINIMAX_VIDEO_GENERATION_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({ task_id: "minimax-h3-task" });
      }),
      http.get(MINIMAX_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "preserve the character and follow the reference soundtrack",
        model: "h3",
        duration: "5s",
        aspectRatio: "16:9",
        imageUrls: referenceImageUrls,
        videoUrls: [referenceVideoUrl],
        audioUrls: referenceAudioUrls,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    const callbackUrl = readCallbackUrl(observedBody);
    const webhookUrl = new URL(callbackUrl);
    expect(webhookUrl.origin).toBe(WEB_ORIGIN);
    expect(webhookUrl.pathname).toBe(
      `/api/webhooks/built-in-generations/minimax/${generationId}`,
    );

    const challengeResponse = await postMiniMaxWebhook(app, callbackUrl, {
      challenge: "verify-minimax-callback",
    });
    expect(challengeResponse.status).toBe(200);
    await expect(challengeResponse.json()).resolves.toStrictEqual({
      challenge: "verify-minimax-callback",
    });

    const completionResponse = await postMiniMaxWebhook(app, callbackUrl, {
      task: {
        id: "minimax-h3-task",
        model: MINIMAX_H3_MODEL,
        status: "succeeded",
        content: { url: MINIMAX_VIDEO_URL },
        resolution: "2K",
        duration: 5,
        usage: {
          total_seconds: 9,
          input_seconds: 4,
          output_seconds: 5,
          input_image_count: 7,
        },
        ratio: "16:9",
        task_type: "generation",
        modality: "video",
      },
    });
    expect(completionResponse.status).toBe(200);

    expect(observedAuthorization).toBe("Bearer test-minimax-key");
    const providerContent = asRecord(observedBody).content;
    if (!Array.isArray(providerContent)) {
      throw new Error("Expected MiniMax content array");
    }
    const signedOwnedImageUrl = asRecord(
      asRecord(providerContent[1]).image_url,
    ).url;
    expectPresignedArtifactReference(
      signedOwnedImageUrl,
      ownedImageReference.key,
    );
    const providerReferenceImageUrls = [
      String(signedOwnedImageUrl),
      ...referenceImageUrls.slice(1),
    ];
    expect(observedBody).toStrictEqual({
      model: MINIMAX_H3_MODEL,
      content: [
        {
          type: "text",
          text: "preserve the character and follow the reference soundtrack",
        },
        ...providerReferenceImageUrls.map((url) => {
          return {
            type: "image_url",
            image_url: { url },
            role: "reference_image",
          };
        }),
        {
          type: "video_url",
          video_url: { url: referenceVideoUrl },
          role: "reference_video",
        },
        ...referenceAudioUrls.map((url) => {
          return {
            type: "audio_url",
            audio_url: { url },
            role: "reference_audio",
          };
        }),
      ],
      callback_url: callbackUrl,
      resolution: "2K",
      duration: 5,
      ratio: "16:9",
    });

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "video/mp4",
      size: VIDEO_BYTES.byteLength,
      creditsCharged: 1567,
      model: MINIMAX_H3_MODEL,
      aspectRatio: "16:9",
      duration: "5s",
      durationSeconds: 5,
      resolution: "2k",
      generateAudio: true,
      sourceUrl: MINIMAX_VIDEO_URL,
      requestId: "minimax-h3-task",
    });

    // 5 output seconds at 163 credits, 4 reference-video seconds at 163
    // credits, and 2 reference images after the five-image free tier at 50.
    await expect(orgCredits(fixture)).resolves.toBe(10_000 - 1567);
  });

  it("submits MiniMax H3 first and last frames with adaptive ratio", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let observedBody: unknown = null;
    server.use(
      http.post(MINIMAX_VIDEO_GENERATION_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({ task_id: "minimax-h3-frame-task" });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "transition naturally between the supplied frames",
        model: "minimax-h3",
        duration: "5s",
        firstFrameImageUrl: "https://example.com/first.png",
        lastFrameImageUrl: "https://example.com/last.png",
      }),
    });

    expect(response.status).toBe(202);
    const callbackUrl = readCallbackUrl(observedBody);
    expect(observedBody).toStrictEqual({
      model: MINIMAX_H3_MODEL,
      content: [
        {
          type: "text",
          text: "transition naturally between the supplied frames",
        },
        {
          type: "image_url",
          image_url: { url: "https://example.com/first.png" },
          role: "first_frame",
        },
        {
          type: "image_url",
          image_url: { url: "https://example.com/last.png" },
          role: "last_frame",
        },
      ],
      callback_url: callbackUrl,
      resolution: "2K",
      duration: 5,
      ratio: "adaptive",
    });

    const cancellationResponse = await postMiniMaxWebhook(app, callbackUrl, {
      task: {
        id: "minimax-h3-frame-task",
        status: "cancelled",
        error: { message: "test cancellation" },
      },
    });
    expect(cancellationResponse.status).toBe(200);
  });

  it("rejects silent MiniMax H3 requests before provider submission", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledMiniMax = false;
    server.use(
      http.post(MINIMAX_VIDEO_GENERATION_URL, () => {
        calledMiniMax = true;
        return HttpResponse.json({ task_id: "unexpected-task" });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a silent city",
        model: "minimax-h3",
        generateAudio: false,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "MiniMax H3 always generates native audio",
        code: "BAD_REQUEST",
      },
    });
    expect(calledMiniMax).toBeFalsy();
  });

  it("rejects MiniMax H3 prompts above the official 7000-character limit", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledMiniMax = false;
    server.use(
      http.post(MINIMAX_VIDEO_GENERATION_URL, () => {
        calledMiniMax = true;
        return HttpResponse.json({ task_id: "unexpected-task" });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "x".repeat(7001),
        model: "minimax-h3",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "prompt exceeds 7000 characters for MiniMax H3",
        code: "BAD_REQUEST",
      },
    });
    expect(calledMiniMax).toBeFalsy();
  });

  it("generates video files with the recommended Fal fallback model", async () => {
    const fixture = await seedVideoFixture();
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

    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_VEO_FAST_QUEUE_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json({
          request_id: "video-request",
          status_url: FAL_STATUS_URL,
          response_url: FAL_RESPONSE_URL,
        });
      }),
      http.get(FAL_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a cinematic tracking shot through a neon market",
        model: "veo3.1-fast",
        duration: "8s",
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: true,
        seed: 42,
        negativePrompt: "low quality",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      video: {
        url: FAL_VIDEO_URL,
        content_type: "video/mp4",
        file_name: "output.mp4",
        file_size: VIDEO_BYTES.byteLength,
      },
    });
    await flushWaitUntilForTest();

    const webhookUrl = new URL(readFalWebhookUrl(observedRequestUrl));
    expect(webhookUrl.origin).toBe(WEB_ORIGIN);
    expect(webhookUrl.pathname).toBe(
      `/api/webhooks/built-in-generations/fal/${generationId}`,
    );
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "a cinematic tracking shot through a neon market",
      aspect_ratio: "16:9",
      duration: "8s",
      resolution: "720p",
      generate_audio: true,
      auto_fix: true,
      safety_tolerance: "4",
      negative_prompt: "low quality",
      seed: 42,
    });

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "video/mp4",
      size: VIDEO_BYTES.byteLength,
      creditsCharged: 1504,
      model: FAL_VEO_FAST_MODEL,
      sourceUrl: FAL_VIDEO_URL,
      requestId: "video-request",
    });

    await postFalWebhookEnvelope(app, observedRequestUrl, {
      status: "ERROR",
      error: "Invalid status code: 422",
      payload: { detail: [{ type: "file_download_error" }] },
    });
    const afterLateFailure = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(afterLateFailure.status).toBe(200);
    await expect(afterLateFailure.json()).resolves.toMatchObject({
      status: "completed",
      result: body,
    });

    // creditsCharged 1504 = 8 seconds at the audio rate (188/s); the silent
    // rate would charge 1000, so the exact balance drop pins the category.
    await expect(orgCredits(fixture)).resolves.toBe(10_000 - 1504);
  });

  it("keeps an unclassified Fal video failure a generic failure without charging", async () => {
    const fixture = await seedVideoFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_VEO_FAST_QUEUE_URL, ({ request }) => {
        observedRequestUrl = request.url;
        return HttpResponse.json({
          request_id: "private-fal-video-request",
          status_url: FAL_STATUS_URL,
          response_url: FAL_RESPONSE_URL,
        });
      }),
    );
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "private-video-prompt",
        model: "veo3.1-fast",
        duration: "8s",
      }),
    });
    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    const payload = {
      status: "ERROR",
      error: "Invalid status code: 422",
      request_id: "private-fal-video-request",
      payload: {
        detail: [
          {
            type: "file_download_error",
            msg: "private-video-provider-message",
            input: { url: "https://private.example/input-video.mp4" },
          },
        ],
      },
    };
    await postFalWebhookEnvelope(app, observedRequestUrl, payload);
    await postFalWebhookEnvelope(app, observedRequestUrl, payload);
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const statusBody: unknown = await statusResponse.json();
    const expectedError = {
      code: "INTERNAL_SERVER_ERROR",
      message: "Generation failed",
    };
    expect(statusBody).toMatchObject({
      generationId,
      status: "failed",
      error: expectedError,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({ status: "failed", error: expectedError }),
    );
    const publicSurfaces = JSON.stringify({
      statusBody,
      realtime: context.mocks.ably.publish.mock.calls,
    });
    for (const privateValue of [
      "private-video-prompt",
      "private-video-provider-message",
      "private-fal-video-request",
      "private.example",
      "Invalid status code:",
    ]) {
      expect(publicSurfaces).not.toContain(privateValue);
    }
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    await expect(orgCredits(fixture)).resolves.toBe(10_000);
  });

  it("generates video files with the recommended Kling 4K model", async () => {
    const fixture = await seedVideoFixture();
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

    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(KLING_V3_4K_QUEUE_URL, async ({ request }) => {
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json({
          request_id: "kling-video-request",
          status_url: KLING_STATUS_URL,
          response_url: KLING_RESPONSE_URL,
        });
      }),
      http.get(KLING_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a vertical concert stage reveal",
        model: "kling-v3-4k",
        duration: "5s",
        aspectRatio: "9:16",
        generateAudio: true,
        negativePrompt: "low quality",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      video: {
        url: KLING_VIDEO_URL,
        content_type: "video/mp4",
      },
    });
    await flushWaitUntilForTest();

    expect(observedBody).toMatchObject({
      prompt: "a vertical concert stage reveal",
      aspect_ratio: "9:16",
      duration: "5",
      generate_audio: true,
      negative_prompt: "low quality",
    });

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      creditsCharged: 2625,
      model: KLING_V3_4K_MODEL,
      resolution: "4k",
      sourceUrl: KLING_VIDEO_URL,
      requestId: "kling-video-request",
    });

    // creditsCharged 2625 = 5 seconds at the 4k audio rate (525/s); the exact
    // balance drop pins the single settled charge.
    await expect(orgCredits(fixture)).resolves.toBe(10_000 - 2625);
  });

  it("records a failed job when BytePlus video generation fails", async () => {
    const fixture = await seedVideoFixture({
      credits: 1000,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "InvalidParameter",
              message:
                "The parameter `content[1].image_url` specified in the request is not valid.",
              param: "content[1].image_url",
              type: "BadRequest",
            },
          },
          { status: 400 },
        );
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "BytePlus video generation failed: The parameter `content[1].image_url` specified in the request is not valid. (content[1].image_url)",
        code: "BYTEPLUS_INVALID_PARAMETER",
      },
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
        type: "video",
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
      type: "video",
      status: "failed",
      error: {
        message:
          "BytePlus video generation failed: The parameter `content[1].image_url` specified in the request is not valid. (content[1].image_url)",
        code: "BYTEPLUS_INVALID_PARAMETER",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("explains BytePlus real-person image rejections without leaking the request ID", async () => {
    const fixture = await seedVideoFixture({
      credits: 1000,
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
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const headers = { authorization: `Bearer ${token}` };

    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json(
          {
            error: {
              code: "InputImageSensitiveContentDetected.PrivacyInformation",
              message:
                "The request failed because the input image 'content[1]' 'content[2]' 'content[3]' may contain real person. Request id: test-byteplus-request-id",
              type: "BadRequest",
            },
          },
          { status: 400 },
        );
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "animate the subjects",
        model: SEEDANCE_2_5_MODEL,
        imageUrls: [
          "https://example.com/reference-1.png",
          "https://example.com/reference-2.png",
          "https://example.com/reference-3.png",
        ],
      }),
    });

    expect(observedBody).toMatchObject({
      model: SEEDANCE_2_5_MODEL,
      content: [
        { type: "text", text: "animate the subjects" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/reference-1.png" },
          role: "reference_image",
        },
        {
          type: "image_url",
          image_url: { url: "https://example.com/reference-2.png" },
          role: "reference_image",
        },
        {
          type: "image_url",
          image_url: { url: "https://example.com/reference-3.png" },
          role: "reference_image",
        },
      ],
    });
    expect(response.status).toBe(400);
    const expectedError = {
      message:
        "This model does not allow directly uploaded images that may contain a real person. Remove or replace them before trying again.",
      code: "GENERATION_INPUT_REAL_PERSON_IMAGE_REJECTED",
    };
    await expect(response.json()).resolves.toStrictEqual({
      error: expectedError,
    });

    const generationId = readPublishedGenerationId(
      context.mocks.ably.publish.mock.calls,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "video",
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
      type: "video",
      status: "failed",
      error: expectedError,
    });
    expect(JSON.stringify(context.mocks.ably.publish.mock.calls)).not.toContain(
      "test-byteplus-request-id",
    );
    expect(JSON.stringify(statusBody)).not.toContain(
      "test-byteplus-request-id",
    );

    let acceptedTaskCount = 0;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        acceptedTaskCount += 1;
        return HttpResponse.json({
          id: `admission-proof-task-${String(acceptedTaskCount)}`,
          status: "queued",
        });
      }),
    );
    // The per-run in-flight limit is three. All three starts can be admitted
    // only if the synchronously failed submission released its active slot.
    for (let index = 0; index < 3; index += 1) {
      const admittedResponse = await app.request("/api/video-io/generate", {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: `admission proof ${String(index + 1)}`,
          model: SEEDANCE_2_5_MODEL,
        }),
      });
      expect(admittedResponse.status).toBe(202);
    }
    expect(acceptedTaskCount).toBe(3);
    await expect(orgCredits(fixture)).resolves.toBe(1000);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("records specific BytePlus webhook failure details on async failure", async () => {
    const fixture = await seedVideoFixture({
      credits: 1000,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "byteplus-video-task",
          status: "queued",
        });
      }),
    );

    const app = createVideoIoTestApp(fixture.pricingResolution);
    const response = await app.request("/api/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city" }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    const callbackUrl = readCallbackUrl(observedBody);

    await postBytePlusWebhook(app, callbackUrl, {
      id: "byteplus-video-task",
      status: "failed",
      error: {
        code: "InputImageSensitiveContentDetected.PrivacyInformation",
        message:
          "The request failed because the input image may contain real person.",
        type: "BadRequest",
      },
    });

    const statusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      generationId,
      type: "video",
      status: "failed",
      error: {
        message:
          "BytePlus video generation failed: The request failed because the input image may contain real person.",
        code: "BYTEPLUS_INPUT_IMAGE_SENSITIVE_CONTENT_DETECTED_PRIVACY_INFORMATION",
      },
    });

    // The failure details are fully asserted on the product status route
    // above; the internal job-row read added no product-visible coverage.
  });
});
