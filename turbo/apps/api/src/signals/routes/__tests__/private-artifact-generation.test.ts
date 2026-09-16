import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { builtInGenerationContract } from "@okouai/api-contracts/contracts/built-in-generation";
import {
  imageIoGenerateContract,
  imageIoGenerateResponseSchema,
} from "@okouai/api-contracts/contracts/image-io-generate";
import { voiceIoSpeechContract } from "@okouai/api-contracts/contracts/voice-io-speech";
import { videoIoGenerateContract } from "@okouai/api-contracts/contracts/video-io-generate";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import {
  webhookBuiltInGenerationBytePlusContract,
  webhookBuiltInGenerationFalContract,
  webhookBuiltInGenerationMiniMaxContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createUsagePricingFixture } from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { builtInGenerationRoutes } from "../built-in-generation";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { voiceIoSpeechRoutes } from "../voice-io-speech";
import { videoIoGenerateRoutes } from "../video-io-generate";
import { webFileUrlRoutes } from "../web-file-url";
import { webDownloadRoutes } from "../web-download";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { createBddApi } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const billing = createBillingMediaApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const privateBucket = "test-private-artifacts";
const publicBucket = "test-user-artifacts";
const imageBytes = Buffer.from("private generated image");
const sourceUrl = "https://fal.media/private-generation/output.jpg";
const signedReference =
  "https://private-r2.example/reference?signature=temporary";

async function createFixture(privateArtifacts: boolean) {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected organization");
  }
  await bdd.completeOnboarding(actor);
  webhooks.configureStripeWebhookSecret();
  webhooks.acceptNextStripeWebhookEvent({
    id: `evt_${randomUUID()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${randomUUID()}`,
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
  await webhooks.requestStripeWebhook(
    "{}",
    { "stripe-signature": "valid-signature" },
    [200],
  );
  await billing.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
  });
  const pricing = await createUsagePricingFixture({
    configured: [
      {
        kind: "image",
        provider: "fal-ai/qwen-image",
        category: "output_megapixel",
        unitPrice: 24,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "seedream-5-0-lite-260128",
        category: "provider_cost_usd_micros",
        unitPrice: 1250,
        unitSize: 1_000_000,
      },
      {
        kind: "audio",
        provider: "gpt-4o-mini-tts",
        category: "output_audio_seconds",
        unitPrice: 5,
        unitSize: 1,
      },
      {
        kind: "video",
        provider: "dreamina-seedance-2-0-260128",
        category: "output_video_tokens.480p_720p.no_video",
        unitPrice: 8750,
        unitSize: 1_000_000,
      },
      ...[
        "output_video_seconds.768p",
        "output_video_seconds.2k",
        "input_video_seconds.768p",
        "input_video_seconds.2k",
        "input_image.additional",
      ].map((category) => {
        return {
          kind: "video",
          provider: "MiniMax-H3",
          category,
          unitPrice: 100,
          unitSize: 1,
        };
      }),
    ],
  });
  onTestFinished(async () => {
    await pricing.cleanup();
  });
  const api = setupApp({
    context,
    usagePricingResolution: pricing.resolution,
    routes: [
      ...imageIoGenerateRoutes,
      ...builtInGenerationRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...webFileUrlRoutes,
      ...webDownloadRoutes,
      ...voiceIoSpeechRoutes,
      ...videoIoGenerateRoutes,
    ],
  });
  return {
    actor: { ...actor, orgId: actor.orgId },
    api,
    usagePricingResolution: pricing.resolution,
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function enableVideoGeneration(fixture: Fixture) {
  webhooks.configureStripeBillingEnv();
  context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
  const grantedAt = now();
  const expiresAt = new Date(grantedAt + 7 * 24 * 60 * 60 * 1000);
  await webhooks.postStripeEvent(
    {
      id: `evt_${randomUUID()}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID()}`,
          customer: `cus_${randomUUID()}`,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            orgId: fixture.actor.orgId,
            tier: "team",
            duration: "7d",
            atomGrantExpiresAt: expiresAt.toISOString(),
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: Math.floor(grantedAt / 1000),
                  end: Math.floor(expiresAt.getTime() / 1000),
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      },
    },
    [200],
  );
}

async function queueImage(fixture: Fixture, imageUrls?: readonly string[]) {
  mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
  const response = await accept(
    fixture.api(imageIoGenerateContract).post({
      headers,
      body: { prompt: "A private landscape", model: "qwen-image", imageUrls },
    }),
    [202],
  );
  return response.body.generationId;
}

async function completeImage(fixture: Fixture, generationId: string) {
  await accept(
    fixture.api(webhookBuiltInGenerationFalContract).post({
      params: { generationId },
      query: { token: webhooks.falGenerationWebhookToken(generationId) },
      body: JSON.stringify({
        status: "COMPLETED",
        payload: {
          images: [
            {
              url: sourceUrl,
              width: 1024,
              height: 1024,
              content_type: "image/jpeg",
            },
          ],
          cover_url: "https://provider.example/cover.jpg",
        },
      }),
    }),
    [200],
  );
  await flushWaitUntilForTest();
  mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
  const response = await accept(
    fixture
      .api(builtInGenerationContract)
      .get({ headers, params: { generationId } }),
    [200],
  );
  expect(response.body.status).toBe("completed");
  return imageIoGenerateResponseSchema.parse(response.body.result);
}

describe("managed artifact privacy", () => {
  const objects = new Map<string, PutObjectCommandInput>();
  const providerInputs: unknown[] = [];

  beforeEach(() => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    objects.clear();
    providerInputs.length = 0;
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    context.mocks.ably.createTokenRequest.mockResolvedValue({
      keyName: "test-key",
      timestamp: 1_700_000_000,
      capability: "{}",
      nonce: "nonce",
      mac: "mac",
    });
    context.mocks.s3.getSignedUrl.mockResolvedValue(signedReference);
    context.mocks.s3.send.mockImplementation((command) => {
      if (command instanceof PutObjectCommand) {
        objects.set(
          `${command.input.Bucket}/${command.input.Key}`,
          command.input,
        );
        return Promise.resolve({});
      }
      if (
        command instanceof HeadObjectCommand ||
        command instanceof GetObjectCommand
      ) {
        const object = objects.get(
          `${command.input.Bucket}/${command.input.Key}`,
        );
        if (
          !object ||
          !(
            object.Body instanceof Uint8Array || typeof object.Body === "string"
          )
        ) {
          return Promise.reject(
            Object.assign(new Error("Missing object"), { name: "NotFound" }),
          );
        }
        const body = Buffer.from(object.Body);
        return Promise.resolve({
          ETag: '"stored-object"',
          ContentLength: body.byteLength,
          ContentType: object.ContentType,
          Metadata: object.Metadata,
          Body: Readable.from([body]),
        });
      }
      return Promise.resolve({});
    });
    server.use(
      http.post("https://queue.fal.run/*", async ({ request }) => {
        providerInputs.push(await request.json());
        return HttpResponse.json({
          request_id: randomUUID(),
          status_url: "https://queue.fal.run/status",
          response_url: "https://queue.fal.run/result",
        });
      }),
      http.get(sourceUrl, () => {
        return new HttpResponse(imageBytes, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );
  });

  afterEach(async () => {
    await flushWaitUntilForTest();
  });

  it.each([false, true])(
    "uses the image submission policy after the switch changes (private=%s)",
    async (enabled) => {
      const fixture = await createFixture(enabled);
      const generationId = await queueImage(fixture);
      await billing.updateFeatureSwitches(fixture.actor, {
        [FeatureSwitchKey.PrivateArtifacts]: !enabled,
      });
      const result = await completeImage(fixture, generationId);
      const stored = [...objects.values()].find((object) => {
        return (
          object.Body === imageBytes || object.ContentType === "image/jpeg"
        );
      });
      expect(stored?.Bucket).toBe(enabled ? privateBucket : publicBucket);
      if (enabled) {
        expect(result.url).toMatch(/^\/artifacts\/[a-z0-9]{10}\.jpg$/u);
        expect(result.sourceUrl).toBeUndefined();
        expect(result.embedUrl).toBeUndefined();
        const serializedEvents = JSON.stringify(
          context.mocks.ably.publish.mock.calls,
        );
        expect(serializedEvents).not.toContain(sourceUrl);
        expect(serializedEvents).not.toContain("cover_url");
        expect(serializedEvents).not.toContain("private-artifacts/");
        expect(serializedEvents).not.toContain(signedReference);
        const preview = await accept(
          fixture
            .api(webFilesContract)
            .fileUrl({ headers, query: { file_id: result.id } }),
          [200],
        );
        expect(preview.body).toStrictEqual({
          url: signedReference,
          publicUrl: null,
          expiresAt: expect.any(String),
        });
        expect(
          context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[2],
        ).toMatchObject({ expiresIn: 172_800 });
        const downloaded = await accept(
          fixture
            .api(webFilesContract)
            .download({ headers, query: { file_id: result.id } }),
          [200],
        );
        expect(downloaded.body).toBeInstanceOf(Blob);
        if (!(downloaded.body instanceof Blob)) {
          throw new Error("Expected image download");
        }
        await expect(downloaded.body.text()).resolves.toBe(
          imageBytes.toString(),
        );
        for (const [userId, orgId] of [
          [`user_${randomUUID()}`, fixture.actor.orgId],
          [fixture.actor.userId, `org_${randomUUID()}`],
        ]) {
          if (!userId || !orgId) {
            throw new Error("Missing viewer identity");
          }
          mocks.clerk.session(userId, orgId);
          await accept(
            fixture
              .api(builtInGenerationContract)
              .get({ headers, params: { generationId } }),
            [404],
          );
          await accept(
            fixture
              .api(webFilesContract)
              .fileUrl({ headers, query: { file_id: result.id } }),
            [404],
          );
          await accept(
            fixture
              .api(webFilesContract)
              .download({ headers, query: { file_id: result.id } }),
            [404],
          );
        }
        context.mocks.clerk.authenticateRequest.mockResolvedValue({
          isAuthenticated: false,
        });
        await accept(
          fixture
            .api(webFilesContract)
            .download({ headers: {}, query: { file_id: result.id } }),
          [401],
        );
      } else {
        const writes = [...objects.keys()];
        const contentWrite = writes.findIndex((key) => {
          return key.startsWith(`${publicBucket}/artifacts/`);
        });
        const registrationWrite = writes.findIndex((key) => {
          return key.startsWith("test-hosted-sites/artifact-delivery/files/");
        });
        expect(registrationWrite).toBeGreaterThanOrEqual(0);
        expect(contentWrite).toBeGreaterThan(registrationWrite);
        expect(result.url).toMatch(/^https:\/\/a\.okou\.io\//u);
        expect(result.sourceUrl).toBe(sourceUrl);
        expect(result.embedUrl).toBe(
          `${result.url}?thumbnail=1&fit=scale-down&quality=85`,
        );
        mocks.clerk.session(`user_${randomUUID()}`, fixture.actor.orgId);
        await accept(
          fixture
            .api(builtInGenerationContract)
            .get({ headers, params: { generationId } }),
          [200],
        );
      }
    },
  );

  it("resolves an owned private input after rollback and keeps the stable reference in the next result", async () => {
    const fixture = await createFixture(true);
    const image = await completeImage(fixture, await queueImage(fixture));
    await billing.updateFeatureSwitches(fixture.actor, {
      [FeatureSwitchKey.PrivateArtifacts]: false,
    });
    const nextId = await queueImage(fixture, [image.url]);
    expect(JSON.stringify(providerInputs.at(-1))).toContain(signedReference);
    expect(JSON.stringify(providerInputs.at(-1))).not.toContain(image.url);
    expect(context.mocks.s3.getSignedUrl.mock.calls.at(-1)).toMatchObject({
      1: {
        input: {
          Bucket: privateBucket,
          Key: `private-artifacts/${image.id}/${image.filename}`,
        },
      },
      2: { expiresIn: 172_800 },
    });
    const next = await completeImage(fixture, nextId);
    expect(next.sourceImageUrls).toStrictEqual([image.url]);
    expect(JSON.stringify(next)).not.toContain(signedReference);
  });

  it("does not forward another user's private reference or sign it for a provider", async () => {
    const fixture = await createFixture(true);
    const image = await completeImage(fixture, await queueImage(fixture));
    const requestCount = providerInputs.length;
    const signatureCount = context.mocks.s3.getSignedUrl.mock.calls.length;
    mocks.clerk.session(`user_${randomUUID()}`, fixture.actor.orgId);
    const response = await fixture.api(imageIoGenerateContract).post({
      headers,
      body: {
        model: "qwen-image",
        prompt: "Use reference",
        imageUrls: [image.url],
      },
    });
    expect(response.status).toBe(400);
    expect(providerInputs).toHaveLength(requestCount);
    expect(context.mocks.s3.getSignedUrl.mock.calls).toHaveLength(
      signatureCount,
    );
  });

  it.each([
    { provider: "byteplus", privateArtifacts: false },
    { provider: "byteplus", privateArtifacts: true },
    { provider: "minimax", privateArtifacts: false },
    { provider: "minimax", privateArtifacts: true },
  ])(
    "redacts private input signatures from $provider failure delivery (private output=$privateArtifacts)",
    async ({ provider, privateArtifacts }) => {
      const fixture = await createFixture(true);
      await enableVideoGeneration(fixture);
      const image = await completeImage(fixture, await queueImage(fixture));
      await billing.updateFeatureSwitches(fixture.actor, {
        [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
      });
      let providerInput: unknown;
      server.use(
        http.post(
          provider === "byteplus"
            ? "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks"
            : "https://api.minimax.io/v2/video_generation",
          async ({ request }) => {
            providerInput = await request.json();
            return HttpResponse.json(
              provider === "byteplus"
                ? { id: randomUUID() }
                : { task_id: randomUUID() },
            );
          },
        ),
      );
      const queued = await accept(
        fixture.api(videoIoGenerateContract).post({
          headers,
          body: {
            prompt: "Animate the private reference",
            model:
              provider === "byteplus" ? "dreamina-seedance-2.0" : "minimax-h3",
            duration: "5s",
            imageUrls: [image.url],
          },
        }),
        [202],
      );
      expect(JSON.stringify(providerInput)).toContain(signedReference);
      if (
        typeof providerInput !== "object" ||
        providerInput === null ||
        !("callback_url" in providerInput) ||
        typeof providerInput.callback_url !== "string"
      ) {
        throw new Error("Expected provider callback URL");
      }
      const token = new URL(providerInput.callback_url).searchParams.get(
        "token",
      );
      if (!token) {
        throw new Error("Expected provider callback token");
      }
      const generationId = queued.body.generationId;
      const error = {
        code: "InputDownloadFailed",
        message: `Could not download ${signedReference}`,
      };
      const callback = {
        params: { generationId },
        query: { token },
        body: JSON.stringify(
          provider === "byteplus"
            ? { status: "failed", error }
            : { task: { status: "failed", error } },
        ),
      };
      await accept(
        provider === "byteplus"
          ? fixture.api(webhookBuiltInGenerationBytePlusContract).post(callback)
          : fixture.api(webhookBuiltInGenerationMiniMaxContract).post(callback),
        [200],
      );
      const status = await accept(
        fixture.api(builtInGenerationContract).get({
          headers,
          params: { generationId },
        }),
        [200],
      );
      const expectedError = {
        code: `${provider.toUpperCase()}_INPUT_DOWNLOAD_FAILED`,
        message: `${provider === "byteplus" ? "BytePlus" : "MiniMax"} video generation failed: Could not download [redacted presigned URL]`,
      };
      expect(status.body).toMatchObject({
        status: "failed",
        error: expectedError,
      });
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        `built-in-generation:${generationId}`,
        expect.objectContaining({ status: "failed", error: expectedError }),
      );
      expect(
        JSON.stringify(context.mocks.ably.publish.mock.calls),
      ).not.toContain(signedReference);
      if (!privateArtifacts) {
        mocks.clerk.session(`user_${randomUUID()}`, fixture.actor.orgId);
        const otherViewer = await accept(
          fixture.api(builtInGenerationContract).get({
            headers,
            params: { generationId },
          }),
          [200],
        );
        expect(otherViewer.body.error).toStrictEqual(expectedError);
      }
    },
  );

  it("fails private completion without falling back to the public bucket when credentials are missing", async () => {
    const fixture = await createFixture(true);
    const generationId = await queueImage(fixture);
    mockEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", undefined);
    // The typed webhook contract does not model an infrastructure 500.
    const callbackApp = createAppWithRoutes({
      signal: context.signal,
      routes: webhooksBuiltInGenerationRoutes,
      usagePricingResolution: fixture.usagePricingResolution,
    });
    const rejected = await callbackApp.request(
      `/api/webhooks/built-in-generations/fal/${generationId}?token=${webhooks.falGenerationWebhookToken(generationId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          status: "COMPLETED",
          payload: { images: [{ url: sourceUrl, width: 1024, height: 1024 }] },
        }),
      },
    );
    expect(rejected.status).toBe(500);
    await flushWaitUntilForTest();
    const job = await accept(
      fixture
        .api(builtInGenerationContract)
        .get({ headers, params: { generationId } }),
      [200],
    );
    expect(job.body.status).toBe("running");
    expect(job.body.result).toBeUndefined();
    expect(
      [...objects.values()].filter((object) => {
        return object.ContentType === "image/jpeg";
      }),
    ).toStrictEqual([]);
    mockEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", "test-private-access-key");
    const retried = await completeImage(fixture, generationId);
    expect(retried.url).toContain("/artifacts/");
  });

  it("keeps BytePlus image completion private when the provider finishes after rollback", async () => {
    const fixture = await createFixture(true);
    server.use(
      http.post(
        "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations",
        async () => {
          await billing.updateFeatureSwitches(fixture.actor, {
            [FeatureSwitchKey.PrivateArtifacts]: false,
          });
          return HttpResponse.json({
            model: "seedream-5-0-lite-260128",
            data: [
              { url: sourceUrl, size: "2048x2048", output_format: "jpeg" },
            ],
          });
        },
      ),
    );
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
    const queued = await accept(
      fixture.api(imageIoGenerateContract).post({
        headers,
        body: { model: "seedream5-lite", prompt: "Private landscape" },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const job = await accept(
      fixture
        .api(builtInGenerationContract)
        .get({ headers, params: { generationId: queued.body.generationId } }),
      [200],
    );
    expect(job.body.status).toBe("completed");
    const result = imageIoGenerateResponseSchema.parse(job.body.result);
    expect(result.url).toContain("/artifacts/");
    expect(result.sourceUrl).toBeUndefined();
    expect(result.embedUrl).toBeUndefined();
    expect(
      [...objects.values()].find((object) => {
        return object.ContentType === "image/jpeg";
      })?.Bucket,
    ).toBe(privateBucket);
  });

  it("captures private synchronous speech before the provider completes", async () => {
    const fixture = await createFixture(true);
    const wav = Buffer.alloc(44 + 48_000);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24_000, 24);
    wav.writeUInt32LE(48_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(48_000, 40);
    server.use(
      http.post("https://api.openai.com/v1/audio/speech", async () => {
        await billing.updateFeatureSwitches(fixture.actor, {
          [FeatureSwitchKey.PrivateArtifacts]: false,
        });
        return new HttpResponse(wav, {
          headers: { "Content-Type": "audio/wav" },
        });
      }),
    );
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
    const speech = await accept(
      fixture
        .api(voiceIoSpeechContract)
        .post({ headers, body: { text: "Private speech", voice: "alloy" } }),
      [200],
    );
    expect(speech.body.url).toContain("/artifacts/");
    expect(
      [...objects.values()].find((object) => {
        return object.ContentType === "audio/wav";
      })?.Bucket,
    ).toBe(privateBucket);
    const preview = await accept(
      fixture
        .api(webFilesContract)
        .fileUrl({ headers, query: { file_id: speech.body.id } }),
      [200],
    );
    expect(preview.body.publicUrl).toBeNull();
  });
});
