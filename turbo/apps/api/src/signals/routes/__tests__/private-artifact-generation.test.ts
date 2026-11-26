import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { builtInGenerationContract } from "@okouai/api-contracts/contracts/built-in-generation";
import { imageIoGenerateContract } from "@okouai/api-contracts/contracts/image-io-generate";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { builtInGenerationRoutes } from "../built-in-generation";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webFileUrlRoutes } from "../web-file-url";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { tokenRequest } from "./helpers/public-image-run";
import { createRouteMocks } from "./helpers/route-test";

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const PRIVATE_BUCKET = "private-artifacts-test";
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9,
]);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const EXPECTED_SIGNED_TTL_SECONDS = 172_800;

const context = testContext();
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
const webFiles = setupApp({ context, routes: webFileUrlRoutes })(
  webFilesContract,
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

function signOut(): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
}

function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  return Buffer.alloc(0);
}

function configurePrivateImageEnv(): void {
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("FAL_KEY", "fal-test-key");
  mockEnv("R2_PRIVATE_ARTIFACTS_BUCKET_NAME", PRIVATE_BUCKET);
  context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  context.mocks.ably.publish.mockResolvedValue(undefined);

  const objects = new Map<
    string,
    { readonly bytes: Buffer; readonly contentType: string | undefined }
  >();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      typeof command !== "object" ||
      command === null ||
      !("input" in command) ||
      typeof command.input !== "object" ||
      command.input === null
    ) {
      return Promise.resolve({});
    }
    const name = command.constructor.name;
    const input = command.input;
    const bucket =
      "Bucket" in input && typeof input.Bucket === "string" ? input.Bucket : "";
    const key =
      "Key" in input && typeof input.Key === "string" ? input.Key : "";
    const storageKey = `${bucket}/${key}`;

    if (name === "PutObjectCommand") {
      const bytes = "Body" in input ? toBuffer(input.Body) : Buffer.alloc(0);
      const contentType =
        "ContentType" in input && typeof input.ContentType === "string"
          ? input.ContentType
          : undefined;
      objects.set(storageKey, { bytes, contentType });
      return Promise.resolve({ ETag: '"etag-1"' });
    }
    if (name === "HeadObjectCommand") {
      const stored = objects.get(storageKey);
      if (!stored) {
        const missing = Object.assign(new Error("NoSuchKey"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
        return Promise.reject(missing);
      }
      return Promise.resolve({
        ContentLength: stored.bytes.byteLength,
        ContentType: stored.contentType,
        ETag: '"etag-1"',
      });
    }
    if (name === "GetObjectCommand") {
      const stored = objects.get(storageKey);
      if (!stored) {
        const missing = Object.assign(new Error("NoSuchKey"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
        return Promise.reject(missing);
      }
      return Promise.resolve({
        Body: Readable.from([stored.bytes]),
        ContentLength: stored.bytes.byteLength,
        ContentType: stored.contentType,
        ETag: '"etag-1"',
      });
    }
    return Promise.resolve({});
  });
}

async function createFundedMember(): Promise<
  ApiTestUser & { readonly orgId: string }
> {
  createWebhookCallbackApi(context).configureStripeBillingEnv();
  const bdd = createBddApi(context);
  const member = bdd.user({ orgRole: "org:admin" });
  if (!member.orgId) {
    throw new Error("Expected an org-scoped member");
  }
  const onboarded = await bdd.completeOnboarding(member);
  expect(onboarded.status).toBe(200);

  const stripeApp = createAppWithRoutes({
    signal: context.signal,
    routes: webhooksStripeRoutes,
  });
  const stripeEvent = {
    id: `evt_priv_credits_${randomUUID()}`,
    type: "checkout.session.completed",
    created: Math.floor(now() / 1000),
    data: {
      object: {
        id: `cs_priv_${randomUUID()}`,
        invoice: null,
        subscription: null,
        customer: null,
        mode: "payment",
        payment_status: "paid",
        amount_subtotal: 50_000,
        amount_total: 50_000,
        metadata: {
          purpose: "credit_purchase",
          orgId: member.orgId,
          creditsAmountMode: "amount_total",
          creditsExpiresAt: new Date(
            nowDate().getTime() + THIRTY_DAYS_MS,
          ).toISOString(),
        },
      },
    },
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
  await flushWaitUntilForTest();

  return { ...member, orgId: member.orgId };
}

async function selectFluxPro(actor: ApiTestUser): Promise<void> {
  signIn(actor);
  await accept(
    userModelPreference.update({
      headers: AUTH_HEADERS,
      body: {
        selectedModel: null,
        serviceTier: null,
        selectedImageModel: "fal-ai/flux-pro/v1.1",
      },
    }),
    [200],
  );
}

interface CompletedPrivateImage {
  readonly generationId: string;
  readonly artifactId: string;
  readonly artifactUrl: string;
  readonly result: Readonly<Record<string, unknown>>;
  readonly falSourceUrl: string;
}

function readStringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string field "${key}" in generation result`);
  }
  return value;
}

async function completePrivateImageGeneration(
  actor: ApiTestUser,
  options: {
    readonly prompt?: string;
    readonly imageUrls?: readonly string[];
    readonly onFalRequest?: (body: unknown) => void;
  } = {},
): Promise<CompletedPrivateImage> {
  const falSourceUrl = `https://fal.media/files/private-${randomUUID()}.jpg`;
  let webhookUrl: string | null = null;
  server.use(
    http.post("https://queue.fal.run/*", async ({ request }) => {
      webhookUrl = new URL(request.url).searchParams.get("fal_webhook");
      options.onFalRequest?.(await request.json());
      const requestId = `fal_req_${randomUUID()}`;
      return HttpResponse.json({
        request_id: requestId,
        status_url: `https://queue.fal.run/fal-ai/flux-pro/v1.1/requests/${requestId}/status`,
        response_url: `https://queue.fal.run/fal-ai/flux-pro/v1.1/requests/${requestId}`,
      });
    }),
    http.get(falSourceUrl, () => {
      return new HttpResponse(JPEG_BYTES, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }),
  );

  signIn(actor);
  const queued = await accept(
    imageIoGenerate.post({
      headers: AUTH_HEADERS,
      body: {
        prompt: options.prompt ?? "Private studio portrait",
        ...(options.imageUrls ? { imageUrls: [...options.imageUrls] } : {}),
      },
    }),
    [202],
  );
  const generationId = queued.body.generationId;
  if (!webhookUrl) {
    throw new Error("Expected Fal submission to include fal_webhook");
  }

  const webhookTarget = new URL(webhookUrl);
  const webhookApp = createAppWithRoutes({
    signal: context.signal,
    routes: webhooksBuiltInGenerationRoutes,
  });
  const webhookResponse = await webhookApp.request(
    `${webhookTarget.pathname}${webhookTarget.search}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "COMPLETED",
        payload: {
          images: [
            {
              url: falSourceUrl,
              content_type: "image/jpeg",
              width: 1024,
              height: 1024,
            },
          ],
        },
      }),
    },
  );
  expect(webhookResponse.status).toBe(200);
  await flushWaitUntilForTest();

  signIn(actor);
  const completed = await accept(
    builtInGeneration.get({
      headers: AUTH_HEADERS,
      params: { generationId },
    }),
    [200],
  );
  expect(completed.body.status).toBe("completed");
  if (!completed.body.result) {
    throw new Error("Expected completed generation result");
  }
  const artifactId = readStringField(completed.body.result, "id");
  const artifactUrl = readStringField(completed.body.result, "url");
  return {
    generationId,
    artifactId,
    artifactUrl,
    result: completed.body.result,
    falSourceUrl,
  };
}

function readUploadedPrivateObjects(): readonly {
  readonly bucket: string;
  readonly key: string;
}[] {
  const uploaded: { readonly bucket: string; readonly key: string }[] = [];
  for (const call of context.mocks.s3.send.mock.calls) {
    const command: unknown = call[0];
    if (
      typeof command === "object" &&
      command !== null &&
      "input" in command &&
      typeof command.input === "object" &&
      command.input !== null &&
      "Bucket" in command.input &&
      "Key" in command.input &&
      typeof command.input.Bucket === "string" &&
      typeof command.input.Key === "string"
    ) {
      uploaded.push({
        bucket: command.input.Bucket,
        key: command.input.Key,
      });
    }
  }
  return uploaded;
}

function readSignedUrlCalls(): readonly {
  readonly bucket: string;
  readonly key: string;
  readonly expiresIn: number | undefined;
}[] {
  const signed: {
    readonly bucket: string;
    readonly key: string;
    readonly expiresIn: number | undefined;
  }[] = [];
  for (const call of context.mocks.s3.getSignedUrl.mock.calls) {
    const command: unknown = call[1];
    const options: unknown = call[2];
    if (
      typeof command === "object" &&
      command !== null &&
      "input" in command &&
      typeof command.input === "object" &&
      command.input !== null &&
      "Bucket" in command.input &&
      "Key" in command.input &&
      typeof command.input.Bucket === "string" &&
      typeof command.input.Key === "string"
    ) {
      const expiresIn =
        typeof options === "object" &&
        options !== null &&
        "expiresIn" in options &&
        typeof options.expiresIn === "number"
          ? options.expiresIn
          : undefined;
      signed.push({
        bucket: command.input.Bucket,
        key: command.input.Key,
        expiresIn,
      });
    }
  }
  return signed;
}

test("private-artifact-generation-001 (1/2) stores completed generated images privately, keeps realtime clean, and resolves owner signed file URLs", async () => {
  configurePrivateImageEnv();
  const owner = await createFundedMember();
  await selectFluxPro(owner);

  const completed = await completePrivateImageGeneration(owner);

  expect(completed.result.privateArtifacts).toBeTruthy();
  expect(completed.result.sourceUrl).toBeUndefined();
  expect(completed.result.embedUrl).toBeUndefined();

  const parsedArtifactUrl = new URL(completed.artifactUrl);
  const pathSegments = parsedArtifactUrl.pathname.split("/").filter(Boolean);
  expect(pathSegments[0]).toBe("artifacts");
  const filename = pathSegments[1] ?? "";
  expect(filename.endsWith(".jpg")).toBeTruthy();
  expect(filename.slice(0, -4)).toHaveLength(10);

  const uploadedObjects = readUploadedPrivateObjects();
  expect(uploadedObjects).toContainEqual({
    bucket: PRIVATE_BUCKET,
    key: expect.stringContaining(`private-artifacts/${completed.artifactId}/`),
  });

  const realtimePayloads = context.mocks.ably.publish.mock.calls.map((call) => {
    return JSON.stringify(call);
  });
  for (const payload of realtimePayloads) {
    expect(payload).not.toContain(completed.falSourceUrl);
    expect(payload).not.toContain("cover_url");
    expect(payload).not.toContain("private-artifacts/");
    expect(payload).not.toContain("r2.example.com");
  }

  signIn(owner);
  const fileUrlResponse = await accept(
    webFiles.fileUrl({
      headers: AUTH_HEADERS,
      query: { file_id: completed.artifactId },
    }),
    [200],
  );
  expect(fileUrlResponse.body.publicUrl).toBeNull();
  expect(fileUrlResponse.body.previewImageUrl).toBeNull();
  const signedPreviewUrl = new URL(fileUrlResponse.body.url);
  expect(signedPreviewUrl.searchParams.get("object")).toContain(
    `${PRIVATE_BUCKET}/private-artifacts/${completed.artifactId}/`,
  );

  const signedCalls = readSignedUrlCalls();
  expect(signedCalls).toContainEqual(
    expect.objectContaining({
      bucket: PRIVATE_BUCKET,
      key: expect.stringContaining(
        `private-artifacts/${completed.artifactId}/`,
      ),
      expiresIn: EXPECTED_SIGNED_TTL_SECONDS,
    }),
  );
});

test("private-artifact-generation-001 (2/2) denies colleague, cross-organization, and unauthenticated reads of private generated images", async () => {
  configurePrivateImageEnv();
  const owner = await createFundedMember();
  await selectFluxPro(owner);
  const completed = await completePrivateImageGeneration(owner);

  const bdd = createBddApi(context);
  const colleague = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
  const sameUserOtherOrg = bdd.user({
    userId: owner.userId,
    orgRole: "org:admin",
  });

  signIn(colleague);
  const colleagueGen = await accept(
    builtInGeneration.get({
      headers: AUTH_HEADERS,
      params: { generationId: completed.generationId },
    }),
    [404],
  );
  expect(colleagueGen.status).toBe(404);
  const colleagueFile = await accept(
    webFiles.fileUrl({
      headers: AUTH_HEADERS,
      query: { file_id: completed.artifactId },
    }),
    [404],
  );
  expect(colleagueFile.status).toBe(404);

  signIn(sameUserOtherOrg);
  const otherOrgGen = await accept(
    builtInGeneration.get({
      headers: AUTH_HEADERS,
      params: { generationId: completed.generationId },
    }),
    [404],
  );
  expect(otherOrgGen.status).toBe(404);
  const otherOrgFile = await accept(
    webFiles.fileUrl({
      headers: AUTH_HEADERS,
      query: { file_id: completed.artifactId },
    }),
    [404],
  );
  expect(otherOrgFile.status).toBe(404);

  signOut();
  const unauthFile = await accept(
    webFiles.fileUrl({
      headers: {},
      query: { file_id: completed.artifactId },
    }),
    [401],
  );
  expect(unauthFile.status).toBe(401);
});

test("private-artifact-generation-003 resolves an owned private input and keeps the stable reference in the next result", async () => {
  configurePrivateImageEnv();
  const owner = await createFundedMember();
  await selectFluxPro(owner);
  const first = await completePrivateImageGeneration(owner, {
    prompt: "Initial private source image",
  });

  let secondFalBody: unknown = null;
  const second = await completePrivateImageGeneration(owner, {
    prompt: "Refine the private source image",
    imageUrls: [first.artifactUrl],
    onFalRequest: (body) => {
      secondFalBody = body;
    },
  });

  if (
    typeof secondFalBody !== "object" ||
    secondFalBody === null ||
    !("image_url" in secondFalBody) ||
    typeof secondFalBody.image_url !== "string"
  ) {
    throw new Error("Expected Fal redux request to carry image_url");
  }
  expect(secondFalBody.image_url).not.toBe(first.artifactUrl);
  const signedForProvider = new URL(secondFalBody.image_url);
  expect(signedForProvider.searchParams.get("object")).toContain(
    `${PRIVATE_BUCKET}/private-artifacts/${first.artifactId}/`,
  );
  expect(readSignedUrlCalls()).toContainEqual(
    expect.objectContaining({
      bucket: PRIVATE_BUCKET,
      key: expect.stringContaining(`private-artifacts/${first.artifactId}/`),
      expiresIn: EXPECTED_SIGNED_TTL_SECONDS,
    }),
  );

  expect(second.result.sourceImageUrls).toStrictEqual([first.artifactUrl]);
  expect(JSON.stringify(second.result)).not.toContain("r2.example.com");
});

test("private-artifact-generation-004 does not forward another user's private reference or sign it for a provider", async () => {
  configurePrivateImageEnv();
  const owner = await createFundedMember();
  await selectFluxPro(owner);
  const first = await completePrivateImageGeneration(owner);

  const colleague = createBddApi(context).user({
    orgId: owner.orgId,
    orgRole: "org:member",
  });
  await selectFluxPro(colleague);

  let extraFalRequests = 0;
  server.use(
    http.post("https://queue.fal.run/*", () => {
      extraFalRequests += 1;
      return HttpResponse.json({}, { status: 500 });
    }),
  );
  const signedCallsBefore = context.mocks.s3.getSignedUrl.mock.calls.length;

  signIn(colleague);
  await accept(
    imageIoGenerate.post({
      headers: AUTH_HEADERS,
      body: {
        prompt: "Attempt to borrow colleague artifact",
        imageUrls: [first.artifactUrl],
      },
    }),
    [400],
  );

  expect(extraFalRequests).toBe(0);
  expect(context.mocks.s3.getSignedUrl.mock.calls).toHaveLength(
    signedCallsBefore,
  );
});
