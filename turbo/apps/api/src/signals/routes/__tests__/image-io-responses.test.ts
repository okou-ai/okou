import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { builtInGenerationContract } from "@okouai/api-contracts/contracts/built-in-generation";
import { imageIoGenerateContract } from "@okouai/api-contracts/contracts/image-io-generate";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { HttpResponse, http } from "msw";
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
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  OPENAI_RESPONSES_URL,
  completedImageResponseWithUsage,
  mockOpenAiImageResponses,
} from "./helpers/openai-image-responses";
import { tokenRequest } from "./helpers/public-image-run";
import { createRouteMocks } from "./helpers/route-test";

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const PRIVATE_BUCKET = "private-artifacts-test";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const GENERATED_IMAGE_BASE64 = Buffer.from("generated image bytes").toString(
  "base64",
);
const GENERATED_IMAGE_BYTES = Buffer.from("generated image bytes").byteLength;

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

function configureOpenAiImageEnv(): void {
  mockEnv("OPENAI_API_KEY", "test-openai-key");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("R2_PRIVATE_ARTIFACTS_BUCKET_NAME", PRIVATE_BUCKET);
  context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  context.mocks.ably.publish.mockResolvedValue(undefined);
  context.mocks.s3.send.mockResolvedValue({});
}

async function createFundedOpenAiAdmin(
  credits = 10_000,
): Promise<ApiTestUser & { readonly orgId: string }> {
  createWebhookCallbackApi(context).configureStripeBillingEnv();
  configureOpenAiImageEnv();
  const bdd = createBddApi(context);
  const admin = bdd.user({ orgRole: "org:admin" });
  if (!admin.orgId) {
    throw new Error("Expected an org-scoped admin");
  }
  const onboarded = await bdd.completeOnboarding(admin);
  expect(onboarded.status).toBe(200);

  const stripeApp = createAppWithRoutes({
    signal: context.signal,
    routes: webhooksStripeRoutes,
  });
  const amountCents = Math.floor(credits / 10);
  const stripeEvent = {
    id: `evt_oai_credits_${randomUUID()}`,
    type: "checkout.session.completed",
    created: Math.floor(now() / 1000),
    data: {
      object: {
        id: `cs_oai_${randomUUID()}`,
        invoice: null,
        subscription: null,
        customer: null,
        mode: "payment",
        payment_status: "paid",
        amount_subtotal: amountCents,
        amount_total: amountCents,
        metadata: {
          purpose: "credit_purchase",
          orgId: admin.orgId,
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

  signIn(admin);
  await accept(
    userModelPreference.update({
      headers: AUTH_HEADERS,
      body: {
        selectedModel: null,
        serviceTier: null,
        selectedImageModel: "gpt-image-2.5-flare",
      },
    }),
    [200],
  );
  context.mocks.s3.send.mockClear();
  context.mocks.ably.publish.mockClear();
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

function readUploadedPrivateKeys(): readonly {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string | undefined;
}[] {
  const uploads: {
    readonly bucket: string;
    readonly key: string;
    readonly contentType: string | undefined;
  }[] = [];
  for (const call of context.mocks.s3.send.mock.calls) {
    const command: unknown = call[0];
    if (
      typeof command === "object" &&
      command !== null &&
      command.constructor.name === "PutObjectCommand" &&
      "input" in command &&
      typeof command.input === "object" &&
      command.input !== null &&
      "Bucket" in command.input &&
      "Key" in command.input &&
      typeof command.input.Bucket === "string" &&
      typeof command.input.Key === "string"
    ) {
      const contentType =
        "ContentType" in command.input &&
        typeof command.input.ContentType === "string"
          ? command.input.ContentType
          : undefined;
      uploads.push({
        bucket: command.input.Bucket,
        key: command.input.Key,
        contentType,
      });
    }
  }
  return uploads;
}

async function settlePendingJobAsCancelled(
  owner: ApiTestUser,
  generationId: string,
  responseId: string,
): Promise<void> {
  server.use(
    http.get(`${OPENAI_RESPONSES_URL}/${responseId}`, () => {
      return HttpResponse.json({
        id: responseId,
        status: "cancelled",
        metadata: { generation_id: generationId },
        output: [],
        usage: null,
      });
    }),
  );
  signIn(owner);
  await accept(
    builtInGeneration.reconcile({
      headers: AUTH_HEADERS,
      params: { generationId },
      body: {},
    }),
    [200],
  );
}

test("image-io-responses-011 publishes a failed job when the provider submission is interrupted", async () => {
  const admin = await createFundedOpenAiAdmin();
  const generationIds: string[] = [];
  server.use(
    http.post(OPENAI_RESPONSES_URL, async ({ request }) => {
      const submission: unknown = await request.json();
      if (
        typeof submission === "object" &&
        submission !== null &&
        "metadata" in submission &&
        typeof submission.metadata === "object" &&
        submission.metadata !== null &&
        "generation_id" in submission.metadata &&
        typeof submission.metadata.generation_id === "string"
      ) {
        generationIds.push(submission.metadata.generation_id);
      }
      return HttpResponse.error();
    }),
  );

  signIn(admin);
  const failedSubmit = await accept(
    imageIoGenerate.post({
      headers: AUTH_HEADERS,
      body: {
        prompt: "A private product illustration",
        size: "1024x1024",
        quality: "medium",
        outputFormat: "png",
      },
    }),
    [503],
  );
  expect(failedSubmit.body.error.code).toBe("OPENAI_IMAGE_SUBMISSION_UNKNOWN");

  const [generationId] = generationIds;
  if (!generationId) {
    throw new Error("Expected OpenAI to receive the generation ID");
  }
  signIn(admin);
  const status = await accept(
    builtInGeneration.get({
      headers: AUTH_HEADERS,
      params: { generationId },
    }),
    [200],
  );
  expect(status.body).toMatchObject({
    status: "failed",
    error: { code: "OPENAI_IMAGE_SUBMISSION_UNKNOWN" },
  });
});

test("image-io-responses-013 preserves definitive provider rejection moderation_blocked (input)", async () => {
  const admin = await createFundedOpenAiAdmin();
  const submissions: unknown[] = [];
  const retrievals: string[] = [];
  server.use(
    http.post(OPENAI_RESPONSES_URL, async ({ request }) => {
      submissions.push(await request.json());
      return HttpResponse.json(
        {
          error: {
            type: "image_generation_user_error",
            code: "moderation_blocked",
            message: "private-moderation-detail",
            moderation_details: { moderation_stage: "input" },
          },
        },
        { status: 400 },
      );
    }),
    http.get(`${OPENAI_RESPONSES_URL}/:responseId`, ({ request }) => {
      retrievals.push(request.url);
      return HttpResponse.json({}, { status: 500 });
    }),
  );

  signIn(admin);
  const response = await accept(
    imageIoGenerate.post({
      headers: AUTH_HEADERS,
      body: {
        prompt: "A private product illustration",
        size: "1024x1024",
        quality: "medium",
        outputFormat: "png",
      },
    }),
    [400],
  );

  expect(response.body.error.code).toBe("GENERATION_INPUT_SAFETY_REJECTED");
  expect(JSON.stringify(response.body)).not.toContain(
    "private-moderation-detail",
  );
  expect(submissions).toHaveLength(1);
  expect(retrievals).toStrictEqual([]);
  await expect(readCredits(admin)).resolves.toBe(10_000);
});

test("image-io-responses-004 (1/2) submits the background Responses request and keeps the first reconcile running without charging", async () => {
  const admin = await createFundedOpenAiAdmin();
  const openAi = mockOpenAiImageResponses();

  signIn(admin);
  const submitted = await accept(
    imageIoGenerate.post({
      headers: AUTH_HEADERS,
      body: {
        prompt: "A private product illustration",
        size: "1024x1024",
        quality: "medium",
        outputFormat: "png",
      },
    }),
    [202],
  );
  expect(submitted.body.clientReconciliation).toBeTruthy();
  const generationId = submitted.body.generationId;

  const submission = openAi.submission();
  expect(submission.body).toMatchObject({
    model: "gpt-4.1",
    background: true,
    store: true,
    metadata: { generation_id: generationId },
    tool_choice: { type: "image_generation" },
    tools: [
      {
        type: "image_generation",
        model: "gpt-image-2.5-flare",
        action: "generate",
        size: "1024x1024",
        quality: "medium",
        output_format: "png",
      },
    ],
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "A private product illustration" },
        ],
      },
    ],
  });

  openAi.responses.set(
    submission.id,
    completedImageResponseWithUsage(submission),
  );

  signIn(admin);
  const firstReconcile = await accept(
    builtInGeneration.reconcile({
      headers: AUTH_HEADERS,
      params: { generationId },
      body: {},
    }),
    [200],
  );
  expect(firstReconcile.body.status).toBe("running");
  expect(firstReconcile.body.result).toBeUndefined();
  await expect(readCredits(admin)).resolves.toBe(10_000);
  expect(JSON.stringify(context.mocks.ably.publish.mock.calls)).not.toContain(
    "A private revised prompt",
  );
});

test("image-io-responses-004 (2/2) settles the provider tool ledger on second reconcile and stays idempotent on replay", async () => {
  const admin = await createFundedOpenAiAdmin();
  const openAi = mockOpenAiImageResponses();

  signIn(admin);
  const submitted = await accept(
    imageIoGenerate.post({
      headers: AUTH_HEADERS,
      body: {
        prompt: "A private product illustration",
        size: "1024x1024",
        quality: "medium",
        outputFormat: "png",
      },
    }),
    [202],
  );
  const generationId = submitted.body.generationId;
  const submission = openAi.submission();
  openAi.responses.set(
    submission.id,
    completedImageResponseWithUsage(submission),
  );

  signIn(admin);
  await accept(
    builtInGeneration.reconcile({
      headers: AUTH_HEADERS,
      params: { generationId },
      body: {},
    }),
    [200],
  );

  const secondReconcile = await accept(
    builtInGeneration.reconcile({
      headers: AUTH_HEADERS,
      params: { generationId },
      body: {},
    }),
    [200],
  );
  expect(secondReconcile.body).toMatchObject({
    generationId,
    status: "completed",
    result: {
      contentType: "image/png",
      size: GENERATED_IMAGE_BYTES,
      model: "gpt-image-2.5-flare",
      provider: "openai",
      privateArtifacts: true,
      revisedPrompt: "A private revised prompt",
      creditsCharged: 9,
    },
  });
  expect(context.mocks.ably.publish.mock.calls).toContainEqual([
    `built-in-generation:${generationId}`,
    secondReconcile.body,
  ]);
  expect(JSON.stringify(context.mocks.ably.publish.mock.calls)).not.toContain(
    GENERATED_IMAGE_BASE64,
  );

  const thirdReconcile = await accept(
    builtInGeneration.reconcile({
      headers: AUTH_HEADERS,
      params: { generationId },
      body: {},
    }),
    [200],
  );
  const finalRead = await accept(
    builtInGeneration.get({
      headers: AUTH_HEADERS,
      params: { generationId },
    }),
    [200],
  );
  expect(thirdReconcile.body).toStrictEqual(secondReconcile.body);
  expect(finalRead.body).toStrictEqual(secondReconcile.body);
  expect(openAi.submissions).toHaveLength(1);
  expect(openAi.retrievals).toHaveLength(1);
  await expect(readCredits(admin)).resolves.toBe(9991);

  const privatePngUploads = readUploadedPrivateKeys().filter((upload) => {
    return (
      upload.bucket === PRIVATE_BUCKET &&
      upload.key.startsWith("private-artifacts/") &&
      upload.contentType === "image/png"
    );
  });
  expect(privatePngUploads).toHaveLength(1);
});

test("image-io-responses-009 rejects an unrelated owner before retrieving a private provider response", async () => {
  const owner = await createFundedOpenAiAdmin();
  const otherOwner = await createFundedOpenAiAdmin();
  const openAi = mockOpenAiImageResponses();

  signIn(owner);
  const submitted = await accept(
    imageIoGenerate.post({
      headers: AUTH_HEADERS,
      body: {
        prompt: "A private product illustration",
        size: "1024x1024",
        quality: "medium",
        outputFormat: "png",
      },
    }),
    [202],
  );
  const generationId = submitted.body.generationId;

  signIn(otherOwner);
  const denied = await accept(
    builtInGeneration.reconcile({
      headers: AUTH_HEADERS,
      params: { generationId },
      body: {},
    }),
    [404],
  );
  expect(denied.status).toBe(404);
  expect(openAi.retrievals).toStrictEqual([]);
  expect(openAi.submissions).toHaveLength(1);

  await settlePendingJobAsCancelled(
    owner,
    generationId,
    openAi.submission().id,
  );
});

test("image-io-responses-010 maps source references and the edit mask to their Responses controls", async () => {
  const admin = await createFundedOpenAiAdmin();
  const openAi = mockOpenAiImageResponses();
  const prompt = "A private product illustration";
  const imageUrls = [
    "https://images.example.test/source-one.png",
    "https://images.example.test/source-two.png",
  ];
  const maskImageUrl = "https://images.example.test/mask.png";

  signIn(admin);
  const submitted = await accept(
    imageIoGenerate.post({
      headers: AUTH_HEADERS,
      body: {
        prompt,
        size: "1024x1024",
        quality: "medium",
        outputFormat: "png",
        imageUrls,
        maskImageUrl,
      },
    }),
    [202],
  );

  expect(openAi.submissions).toHaveLength(1);
  expect(openAi.submission().body).toMatchObject({
    tools: [
      {
        type: "image_generation",
        action: "edit",
        input_image_mask: { image_url: maskImageUrl },
      },
    ],
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageUrls[0], detail: "auto" },
          { type: "input_image", image_url: imageUrls[1], detail: "auto" },
        ],
      },
    ],
  });
  expect(openAi.retrievals).toStrictEqual([]);

  await settlePendingJobAsCancelled(
    admin,
    submitted.body.generationId,
    openAi.submission().id,
  );
});
