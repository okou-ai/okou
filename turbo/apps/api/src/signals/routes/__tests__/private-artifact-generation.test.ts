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
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { webhookBuiltInGenerationFalContract } from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";

import { server } from "../../../mocks/server";
import { createPublicImageMember } from "./helpers/public-image-member";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { builtInGenerationRoutes } from "../built-in-generation";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webFileUrlRoutes } from "../web-file-url";
import { webDownloadRoutes } from "../web-download";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";

import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";

import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const billing = createBillingMediaApi(context);

const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const privateBucket = "test-private-artifacts";
const publicBucket = "test-user-artifacts";
const imageBytes = Buffer.from("private generated image");
const sourceUrl = "https://fal.media/private-generation/output.jpg";
const signedReference =
  "https://private-r2.example/reference?signature=temporary";

async function createFixture(privateArtifacts: boolean) {
  const actor = await createPublicImageMember(context, {
    credits: 1_000_000,
    ownsFeatures: true,
  });
  await actor.run(() => {
    return billing.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
    });
  });
  const api = setupApp({
    context,
    routes: [
      ...imageIoGenerateRoutes,
      ...userModelPreferenceRoutes,
      ...builtInGenerationRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...webFileUrlRoutes,
      ...webDownloadRoutes,
    ],
  });
  return { actor, api, run: actor.run };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

describe("managed artifact privacy", () => {
  const callbacks = new Map<string, URL>();

  function callbackFor(generationId: string) {
    const callback = callbacks.get(generationId);
    if (!callback) {
      throw new Error("Expected the provider's actual callback URL");
    }
    return callback;
  }

  async function useImageModel(fixture: Fixture, model: ImageModelId) {
    await fixture.run(() => {
      return accept(
        fixture.api(userModelPreferenceContract).update({
          headers,
          body: {
            selectedModel: null,
            serviceTier: null,
            selectedImageModel: model,
          },
        }),
        [200],
      );
    });
  }

  async function queueImage(
    fixture: Fixture,
    imageUrls?: readonly string[],
    requirePrivateArtifact = false,
  ) {
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
    await fixture.run(() => {
      return useImageModel(fixture, "fal-ai/flux-pro/v1.1");
    });
    const client = fixture.api(imageIoGenerateContract);
    const create = requirePrivateArtifact ? client.postPrivate : client.post;
    const response = await fixture.run(() => {
      return accept(
        create({
          headers,
          body: {
            prompt: "A private landscape",
            imageUrls,
            ...(requirePrivateArtifact ? { requirePrivateArtifact: true } : {}),
          },
        }),
        [202],
      );
    });
    return response.body.generationId;
  }

  async function completeImage(fixture: Fixture, generationId: string) {
    await fixture.run(() => {
      return accept(
        fixture.api(webhookBuiltInGenerationFalContract).post({
          params: { generationId },
          query: {
            token: callbackFor(generationId).searchParams.get("token") ?? "",
          },
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
    });
    await fixture.run(() => {
      return flushWaitUntilForTest();
    });
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
    const response = await fixture.run(() => {
      return accept(
        fixture
          .api(builtInGenerationContract)
          .get({ headers, params: { generationId } }),
        [200],
      );
    });
    expect(response.body.status).toBe("completed");
    return imageIoGenerateResponseSchema.parse(response.body.result);
  }

  const objects = new Map<string, PutObjectCommandInput>();
  const providerInputs: unknown[] = [];

  beforeEach(() => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    objects.clear();
    callbacks.clear();
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
        const callback = new URL(request.url).searchParams.get("fal_webhook");
        if (!callback) {
          throw new Error("Expected a real Fal webhook URL");
        }
        const url = new URL(callback);
        const generationId = url.pathname.split("/").at(-1);
        if (!generationId) {
          throw new Error("Expected the generation ID in the callback URL");
        }
        callbacks.set(generationId, url);
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

  it.each([
    { enabled: false, guarded: false },
    { enabled: true, guarded: false },
    { enabled: true, guarded: true },
  ])(
    "uses the image submission policy after rollback (private=$enabled, guarded=$guarded)",
    async ({ enabled, guarded }) => {
      const fixture = await createFixture(enabled);
      await fixture.run(async () => {
        const generationId = await fixture.run(() => {
          return queueImage(fixture, undefined, guarded);
        });
        await fixture.run(() => {
          return billing.updateFeatureSwitches(fixture.actor, {
            [FeatureSwitchKey.PrivateArtifacts]: !enabled,
          });
        });
        const result = await fixture.run(() => {
          return completeImage(fixture, generationId);
        });
        expect(result.privateArtifacts).toBe(enabled);
        const stored = [...objects.values()].find((object) => {
          return (
            object.Body === imageBytes || object.ContentType === "image/jpeg"
          );
        });
        expect(stored?.Bucket).toBe(enabled ? privateBucket : publicBucket);
        if (enabled) {
          expect(result.url).toMatch(
            /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.jpg$/u,
          );
          expect(result.sourceUrl).toBeUndefined();
          expect(result.embedUrl).toBeUndefined();
          const serializedEvents = JSON.stringify(
            context.mocks.ably.publish.mock.calls,
          );
          expect(serializedEvents).not.toContain(sourceUrl);
          expect(serializedEvents).not.toContain("cover_url");
          expect(serializedEvents).not.toContain("private-artifacts/");
          expect(serializedEvents).not.toContain(signedReference);
          const preview = await fixture.run(() => {
            return accept(
              fixture
                .api(webFilesContract)
                .fileUrl({ headers, query: { file_id: result.id } }),
              [200],
            );
          });
          expect(preview.body).toStrictEqual({
            url: signedReference,
            publicUrl: null,
            previewImageUrl: null,
            expiresAt: expect.any(String),
          });
          expect(
            context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[2],
          ).toMatchObject({ expiresIn: 172_800 });
          const downloaded = await fixture.run(() => {
            return accept(
              fixture
                .api(webFilesContract)
                .download({ headers, query: { file_id: result.id } }),
              [200],
            );
          });
          expect(downloaded.body).toBeInstanceOf(Blob);
          if (!(downloaded.body instanceof Blob)) {
            throw new Error("Expected image download");
          }
          await fixture.run(() => {
            return expect(downloaded.body.text()).resolves.toBe(
              imageBytes.toString(),
            );
          });
          for (const [userId, orgId] of [
            [`user_${randomUUID()}`, fixture.actor.orgId],
            [fixture.actor.userId, `org_${randomUUID()}`],
          ]) {
            if (!userId || !orgId) {
              throw new Error("Missing viewer identity");
            }
            mocks.clerk.session(userId, orgId);
            await fixture.run(() => {
              return accept(
                fixture
                  .api(builtInGenerationContract)
                  .get({ headers, params: { generationId } }),
                [404],
              );
            });
            await fixture.run(() => {
              return accept(
                fixture
                  .api(webFilesContract)
                  .fileUrl({ headers, query: { file_id: result.id } }),
                [404],
              );
            });
            await fixture.run(() => {
              return accept(
                fixture
                  .api(webFilesContract)
                  .download({ headers, query: { file_id: result.id } }),
                [404],
              );
            });
          }
          context.mocks.clerk.authenticateRequest.mockResolvedValue({
            isAuthenticated: false,
          });
          await fixture.run(() => {
            return accept(
              fixture
                .api(webFilesContract)
                .download({ headers: {}, query: { file_id: result.id } }),
              [401],
            );
          });
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
          await fixture.run(() => {
            return accept(
              fixture
                .api(builtInGenerationContract)
                .get({ headers, params: { generationId } }),
              [200],
            );
          });
        }
      });
    },
  );

  it("resolves an owned private input after rollback and keeps the stable reference in the next result", async () => {
    const fixture = await createFixture(true);
    await fixture.run(async () => {
      const image = await fixture.run(async () => {
        return completeImage(fixture, await queueImage(fixture));
      });
      await fixture.run(() => {
        return billing.updateFeatureSwitches(fixture.actor, {
          [FeatureSwitchKey.PrivateArtifacts]: false,
        });
      });
      const nextId = await fixture.run(() => {
        return queueImage(fixture, [image.url]);
      });
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
      const next = await fixture.run(() => {
        return completeImage(fixture, nextId);
      });
      expect(next.sourceImageUrls).toStrictEqual([image.url]);
      expect(JSON.stringify(next)).not.toContain(signedReference);
    });
  });

  it("does not forward another user's private reference or sign it for a provider", async () => {
    const fixture = await createFixture(true);
    await fixture.run(async () => {
      const image = await fixture.run(async () => {
        return completeImage(fixture, await queueImage(fixture));
      });
      const requestCount = providerInputs.length;
      const signatureCount = context.mocks.s3.getSignedUrl.mock.calls.length;
      mocks.clerk.session(`user_${randomUUID()}`, fixture.actor.orgId);
      await fixture.run(() => {
        return useImageModel(fixture, "fal-ai/flux-pro/v1.1");
      });
      const response = await fixture.run(() => {
        return fixture.api(imageIoGenerateContract).post({
          headers,
          body: {
            prompt: "Use reference",
            imageUrls: [image.url],
          },
        });
      });
      expect(response.status).toBe(400);
      expect(providerInputs).toHaveLength(requestCount);
      expect(context.mocks.s3.getSignedUrl.mock.calls).toHaveLength(
        signatureCount,
      );
    });
  });

  it("fails private completion without falling back to the public bucket when credentials are missing", async () => {
    const fixture = await createFixture(true);
    await fixture.run(async () => {
      const generationId = await fixture.run(() => {
        return queueImage(fixture);
      });
      mockEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", undefined);
      // The typed webhook contract does not model an infrastructure 500.
      const callbackApp = createAppWithRoutes({
        signal: context.signal,
        routes: webhooksBuiltInGenerationRoutes,
      });
      const rejected = await fixture.run(async () => {
        return await callbackApp.request(
          `${callbackFor(generationId).pathname}${callbackFor(generationId).search}`,
          {
            method: "POST",
            body: JSON.stringify({
              status: "COMPLETED",
              payload: {
                images: [{ url: sourceUrl, width: 1024, height: 1024 }],
              },
            }),
          },
        );
      });
      expect(rejected.status).toBe(500);
      await fixture.run(() => {
        return flushWaitUntilForTest();
      });
      const job = await fixture.run(() => {
        return accept(
          fixture
            .api(builtInGenerationContract)
            .get({ headers, params: { generationId } }),
          [200],
        );
      });
      expect(job.body.status).toBe("running");
      expect(job.body.result).toBeUndefined();
      expect(
        [...objects.values()].filter((object) => {
          return object.ContentType === "image/jpeg";
        }),
      ).toStrictEqual([]);
      mockEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", "test-private-access-key");
      const retried = await fixture.run(() => {
        return completeImage(fixture, generationId);
      });
      expect(retried.url).toContain("/artifacts/");
    });
  });
});
