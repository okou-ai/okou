import { Buffer } from "node:buffer";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { builtInGenerationResponseSchema } from "@okouai/api-contracts/contracts/built-in-generation";
import { http, HttpResponse } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  completedImageResponseWithUsage,
  completedImageResponseWithoutUsage,
  mockOpenAiImageResponses,
  OPENAI_RESPONSES_URL,
} from "./helpers/openai-image-responses";
import { createPublicImageMember } from "./helpers/public-image-member";
import {
  createImageIoTestApp,
  orgCredits,
  readAcceptedGenerationId,
  tokenRequest,
} from "./helpers/public-image-run";
import { createRouteMocks } from "./helpers/route-test";
import { createDurableImageFixture } from "./helpers/durable-image-run";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const model = "gpt-image-2.5-flare";

beforeEach(() => {
  mockEnv("CRON_SECRET", "image-reconciliation-secret");
  mockEnv("OPENAI_API_KEY", "test-openai-key");
  context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  context.mocks.ably.publish.mockResolvedValue(undefined);
  context.mocks.s3.send.mockResolvedValue({});
});

function createFixture(
  preferences = setupApp({ context, routes: userModelPreferenceRoutes }),
) {
  return createDurableImageFixture(context, preferences);
}

describe("durable OpenAI Responses image generation", () => {
  it("requires cron authentication before provider I/O", async () => {
    let providerCalls = 0;
    server.use(
      http.all(`${OPENAI_RESPONSES_URL}*`, () => {
        providerCalls += 1;
        return HttpResponse.json({});
      }),
    );
    const app = createImageIoTestApp(context);
    for (const authorization of [undefined, "Bearer clerk-session"]) {
      const response = await app.request(
        "/api/cron/reconcile-image-generations",
        authorization ? { headers: { authorization } } : {},
      );
      expect(response.status).toBe(401);
    }
    expect(providerCalls).toBe(0);
  });

  it("queues without waiting for the image and polls the same response without a callback", async () => {
    const preferences = await setupApp({
      context,
      routes: userModelPreferenceRoutes,
      isolatePg: true,
    });
    const fixture = await createFixture(preferences);
    await fixture.actor.run(async () => {
      const provider = mockOpenAiImageResponses();
      const response = await fixture.generate();
      expect(response.status).toBe(202);
      const accepted: unknown = await response.json();
      expect(accepted).toMatchObject({ clientReconciliation: true });
      const generationId = readAcceptedGenerationId(
        accepted,
        "image",
        fixture.actor.userId,
      );
      const submission = provider.submission();
      expect(submission.generationId).toBe(generationId);
      expect(submission.body).toMatchObject({
        model: "gpt-4.1",
        background: true,
        store: true,
        metadata: { generation_id: generationId },
        tool_choice: { type: "image_generation" },
        max_tool_calls: 1,
        tools: [
          {
            type: "image_generation",
            model,
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
      await expect(fixture.status(generationId)).resolves.toMatchObject({
        generationId,
        status: "running",
      });
      await fixture.status(generationId);
      expect(provider.retrievals).toStrictEqual([]);
      await fixture.reconcile();
      expect(provider.retrievals).toStrictEqual([submission.id]);
      provider.responses.set(
        submission.id,
        completedImageResponseWithoutUsage(submission),
      );
      await fixture.reconcile();
      await fixture.reconcile();
      const snapshot = await fixture.status(generationId);
      expect(snapshot).toMatchObject({ generationId, status: "running" });
      expect(snapshot.error).toBeUndefined();
      expect(snapshot.result).toBeUndefined();
      expect(provider.retrievals).toStrictEqual([
        submission.id,
        submission.id,
        submission.id,
      ]);
      expect(provider.submissions).toHaveLength(1);
      await expect(orgCredits(context, fixture.actor)).resolves.toBe(10_000);
      const imageUploads = context.mocks.s3.send.mock.calls.filter(
        ([command]) => {
          return command instanceof PutObjectCommand;
        },
      );
      expect(imageUploads).toHaveLength(0);
      const published = JSON.stringify(context.mocks.ably.publish.mock.calls);
      expect(published).not.toContain("A private revised prompt");
      expect(published).not.toContain("generated image bytes");
    });
  });

  it("lets the owner advance one response without a cron secret and leaves GET observational", async () => {
    const fixture = await createFixture();
    await fixture.actor.run(async () => {
      const provider = mockOpenAiImageResponses();
      const response = await fixture.generate();
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.actor.userId,
      );
      await fixture.status(generationId);
      expect(provider.retrievals).toStrictEqual([]);
      const refresh = await fixture.app.request(
        `/api/built-in-generations/${generationId}/reconcile`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        },
      );
      expect(refresh.status).toBe(200);
      expect(
        builtInGenerationResponseSchema.parse(await refresh.json()),
      ).toMatchObject({ generationId, status: "running" });
      expect(provider.retrievals).toStrictEqual([provider.submission().id]);
      expect(provider.submissions).toHaveLength(1);
      await fixture.status(generationId);
      expect(provider.retrievals).toHaveLength(1);
    });
  });

  it("delivers the provider-backed tool ledger through owner refresh and settles exactly once", async () => {
    const preferences = await setupApp({
      context,
      routes: userModelPreferenceRoutes,
      isolatePg: true,
    });
    const fixture = await createFixture(preferences);
    await fixture.actor.run(async () => {
      const provider = mockOpenAiImageResponses();
      const response = await fixture.generate();
      expect(response.status).toBe(202);
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.actor.userId,
      );
      const submission = provider.submission();
      provider.responses.set(
        submission.id,
        completedImageResponseWithUsage(submission),
      );
      // Storage is a durable checkpoint; a separate short task settles it.
      // An intermediate artifact must not advertise an uncharged estimate.
      const checkpoint = await fixture.refresh(generationId);
      expect(checkpoint.status).toBe("running");
      expect(checkpoint.result).toBeUndefined();
      await expect(orgCredits(context, fixture.actor)).resolves.toBe(10_000);
      const completed = await fixture.refresh(generationId);
      expect(completed).toMatchObject({
        generationId,
        status: "completed",
        result: {
          contentType: "image/png",
          size: Buffer.byteLength("generated image bytes"),
          model,
          provider: "openai",
          privateArtifacts: true,
          // Separately rounded: image text 1 + image output 6 +
          // mainline input 1 + mainline output 1.
          creditsCharged: 9,
        },
      });
      expect(completed.result).toMatchObject({
        id: expect.any(String),
        url: expect.stringMatching(/\/artifacts\//u),
      });
      for (let repeat = 0; repeat < 2; repeat += 1) {
        await expect(fixture.refresh(generationId)).resolves.toStrictEqual(
          completed,
        );
        await fixture.reconcile();
        await expect(fixture.status(generationId)).resolves.toStrictEqual(
          completed,
        );
      }
      expect(provider.submissions).toHaveLength(1);
      expect(provider.retrievals).toStrictEqual([submission.id]);
      expect(provider.deletions).toStrictEqual([submission.id]);
      await expect(orgCredits(context, fixture.actor)).resolves.toBe(9991);
      const uploads = context.mocks.s3.send.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command): command is PutObjectCommand => {
          return (
            command instanceof PutObjectCommand &&
            command.input.ContentType === "image/png"
          );
        });
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.input).toMatchObject({
        Body: Buffer.from("generated image bytes"),
        ContentType: "image/png",
        Key: expect.stringMatching(/^private-artifacts\//u),
      });
    });
  });

  it("bills cached mainline input separately without counting it again as ordinary input", async () => {
    const fixture = await createFixture();
    await fixture.actor.run(async () => {
      const provider = mockOpenAiImageResponses();
      const response = await fixture.generate();
      const generationId = readAcceptedGenerationId(
        await response.json(),
        "image",
        fixture.actor.userId,
      );
      const submission = provider.submission();
      const completed = completedImageResponseWithUsage(submission);
      provider.responses.set(submission.id, {
        ...completed,
        usage: {
          input_tokens: 1_000_000,
          input_tokens_details: { cached_tokens: 500_000 },
          output_tokens: 100,
          total_tokens: 1_000_100,
        },
      });
      await fixture.refresh(generationId);
      await expect(fixture.refresh(generationId)).resolves.toMatchObject({
        status: "completed",
        result: { creditsCharged: 1258 },
      });
      await expect(orgCredits(context, fixture.actor)).resolves.toBe(8742);
      expect(provider.submissions).toHaveLength(1);
      expect(provider.retrievals).toStrictEqual([submission.id]);
    });
  });

  it.each(["missing-mainline", "image-total", "mainline-total"] as const)(
    "keeps a %s ledger recoverable without charging or storing an image",
    async (failure) => {
      const fixture = await createFixture();
      await fixture.actor.run(async () => {
        const provider = mockOpenAiImageResponses();
        const response = await fixture.generate();
        const generationId = readAcceptedGenerationId(
          await response.json(),
          "image",
          fixture.actor.userId,
        );
        const submission = provider.submission();
        const completed = completedImageResponseWithUsage(submission);
        provider.responses.set(submission.id, {
          ...completed,
          ...(failure === "missing-mainline"
            ? { usage: null }
            : failure === "mainline-total"
              ? { usage: { ...completed.usage, total_tokens: 583 } }
              : {
                  tool_usage: {
                    image_gen: {
                      ...completed.tool_usage.image_gen,
                      total_tokens: 256,
                    },
                  },
                }),
        });
        await expect(fixture.refresh(generationId)).resolves.toMatchObject({
          status: "running",
        });
        const pending = await fixture.status(generationId);
        expect(pending).toMatchObject({ generationId, status: "running" });
        expect(pending.result).toBeUndefined();
        expect(pending.error).toBeUndefined();
        await expect(orgCredits(context, fixture.actor)).resolves.toBe(10_000);
        expect(
          context.mocks.s3.send.mock.calls.filter(([command]) => {
            return command instanceof PutObjectCommand;
          }),
        ).toHaveLength(0);
        provider.responses.set(submission.id, completed);
        const checkpoint = await fixture.refresh(generationId);
        expect(checkpoint.status).toBe("running");
        expect(checkpoint.result).toBeUndefined();
        const finalized = await fixture.refresh(generationId);
        expect(finalized).toMatchObject({
          status: "completed",
          result: { creditsCharged: 9 },
        });
        await expect(fixture.refresh(generationId)).resolves.toStrictEqual(
          finalized,
        );
        await expect(orgCredits(context, fixture.actor)).resolves.toBe(9991);
        expect(provider.submissions).toHaveLength(1);
        expect(
          context.mocks.s3.send.mock.calls.filter(([command]) => {
            return (
              command instanceof PutObjectCommand &&
              command.input.ContentType === "image/png"
            );
          }),
        ).toHaveLength(1);
      });
    },
  );

  it("rejects an unrelated owner before retrieving a private provider response", async () => {
    const fixture = await createFixture();
    const provider = mockOpenAiImageResponses();
    const response = await fixture.generate();
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.actor.userId,
    );
    const other = await createPublicImageMember(context, { credits: 10_000 });
    await other.run(async () => {
      createRouteMocks(context).clerk.session(other.userId, other.orgId);
      const app = createImageIoTestApp(context);
      const refresh = await app.request(
        `/api/built-in-generations/${generationId}/reconcile`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        },
      );
      expect(refresh.status).toBe(404);
    });
    expect(provider.retrievals).toStrictEqual([]);
    expect(provider.submissions).toHaveLength(1);
  });

  it("maps source references and the edit mask to their Responses controls", async () => {
    const fixture = await createFixture();
    await fixture.actor.run(async () => {
      const provider = mockOpenAiImageResponses();
      const imageUrls = [
        "https://example.com/source-one.png",
        "https://example.com/source-two.png",
      ];
      const maskImageUrl = "https://example.com/edit-mask.png";
      const response = await fixture.generate({ imageUrls, maskImageUrl });
      expect(response.status).toBe(202);
      expect(provider.submission().body).toMatchObject({
        tools: [
          {
            type: "image_generation",
            model,
            action: "edit",
            input_image_mask: { image_url: maskImageUrl },
          },
        ],
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "A private product illustration" },
              { type: "input_image", image_url: imageUrls[0], detail: "auto" },
              { type: "input_image", image_url: imageUrls[1], detail: "auto" },
            ],
          },
        ],
      });
      expect(provider.submissions).toHaveLength(1);
      expect(provider.retrievals).toStrictEqual([]);
    });
  });

  it("publishes a failed job when the provider submission is interrupted", async () => {
    const fixture = await createFixture();
    await fixture.actor.run(async () => {
      const provider = mockOpenAiImageResponses({
        submit: () => {
          return HttpResponse.error();
        },
      });
      const response = await fixture.generate();
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "OPENAI_IMAGE_SUBMISSION_UNKNOWN" },
      });
      const { generationId } = provider.submission();
      await expect(fixture.status(generationId)).resolves.toMatchObject({
        generationId,
        status: "failed",
        error: { code: "OPENAI_IMAGE_SUBMISSION_UNKNOWN" },
      });
    });
  });

  it.each([
    ["invalid_image_file", undefined, "GENERATION_INPUT_MEDIA_INVALID"],
    ["moderation_blocked", "input", "GENERATION_INPUT_SAFETY_REJECTED"],
    ["moderation_blocked", "output", "GENERATION_OUTPUT_SAFETY_BLOCKED"],
  ] as const)(
    "preserves definitive provider rejection %s (%s)",
    async (code, stage, publicCode) => {
      const fixture = await createFixture();
      await fixture.actor.run(async () => {
        const provider = mockOpenAiImageResponses({
          submit: () => {
            return HttpResponse.json(
              {
                error: {
                  type: "image_generation_user_error",
                  code,
                  message: "Private provider details must not leak",
                  ...(stage
                    ? { moderation_details: { moderation_stage: stage } }
                    : {}),
                },
              },
              { status: 400 },
            );
          },
        });
        const response = await fixture.generate();
        expect(response.status).toBe(400);
        const body: unknown = await response.json();
        expect(body).toMatchObject({ error: { code: publicCode } });
        expect(JSON.stringify(body)).not.toContain("Private provider details");
        expect(provider.submissions).toHaveLength(1);
        expect(provider.retrievals).toStrictEqual([]);
        await expect(orgCredits(context, fixture.actor)).resolves.toBe(10_000);
      });
    },
  );
});
