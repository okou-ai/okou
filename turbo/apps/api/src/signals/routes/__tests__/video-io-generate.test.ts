import { randomUUID } from "node:crypto";
import { builtInGenerationContract } from "@okouai/api-contracts/contracts/built-in-generation";
import { videoIoGenerateResponseSchema } from "@okouai/api-contracts/contracts/video-io-generate";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { server } from "../../../mocks/server";
import { seedPreviouslyAcceptedVideoJob } from "../../../test-fixtures/previously-accepted-video-job";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
} from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { installArtifactReferenceStorage } from "./helpers/artifact-reference-storage";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const videoBytes = Buffer.from("previously accepted video output");
const providers = [
  {
    provider: "byteplus",
    model: "dreamina-seedance-2-0-260128",
    duration: "8s",
    resolution: "720p",
    categories: ["output_video_tokens.480p_720p.no_video"],
    credits: 100,
  },
  {
    provider: "fal",
    model: "fal-ai/veo3.1/fast",
    duration: "8s",
    resolution: "720p",
    categories: ["output_video_seconds.audio"],
    credits: 800,
  },
  {
    provider: "minimax",
    model: "MiniMax-H3",
    duration: "5s",
    resolution: "2k",
    categories: [
      "output_video_seconds.768p",
      "output_video_seconds.2k",
      "input_video_seconds.768p",
      "input_video_seconds.2k",
      "input_image.additional",
    ],
    credits: 500,
  },
] as const;

describe("completion of video jobs accepted before retirement", () => {
  beforeEach(() => {
    installArtifactReferenceStorage(context);
    server.use(
      http.get(/\/cdn-cgi\/media\//, () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.post("https://files.okou.app/__artifact-video-poster", () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );
  });

  it.each(
    providers.flatMap((provider) => {
      return [
        { ...provider, privateArtifacts: false },
        { ...provider, privateArtifacts: true },
      ];
    }),
  )(
    "completes and charges $provider once with its recorded visibility (private=$privateArtifacts)",
    async (entry) => {
      const identity = {
        orgId: `org_${randomUUID()}`,
        userId: `user_${randomUUID()}`,
      };
      await seedOrgMetadata({
        orgId: identity.orgId,
        tier: "team",
        credits: 10_000,
      });
      await createStore().set(
        seedOrgMembership$,
        { ...identity, role: "admin" },
        context.signal,
      );
      context.mocks.clerk.session(identity.userId, identity.orgId);
      const pricing = await createUsagePricingFixture({
        configured: entry.categories.map((category) => {
          return {
            kind: "video",
            provider: entry.model,
            category,
            unitPrice: 100,
            unitSize: 1,
          };
        }),
      });
      onTestFinished(pricing.cleanup);
      // Retirement prevents new submissions; the fixture is the persisted job
      // an old API already accepted. All completion assertions use real endpoints.
      const job = await seedPreviouslyAcceptedVideoJob({
        ...identity,
        privateArtifacts: entry.privateArtifacts,
        provider: entry.provider,
        providerJobId: `task_${randomUUID()}`,
        request: {
          prompt: "A product introduction",
          model: entry.model,
          duration: entry.duration,
          resolution: entry.resolution,
          aspectRatio: "16:9",
          generateAudio: true,
        },
      });
      const sourceUrl = `https://video.example/${job.generationId}.mp4`;
      server.use(
        http.get(sourceUrl, () => {
          return new HttpResponse(videoBytes, {
            headers: { "content-type": "video/mp4" },
          });
        }),
      );
      const routes = [
        ...builtInGenerationRoutes,
        ...webhooksBuiltInGenerationRoutes,
        ...billingStatusRoutes,
      ];
      const app = createAppWithRoutes({
        signal: context.signal,
        routes,
        usagePricingResolution: pricing.resolution,
      });
      const client = setupApp({
        context,
        routes,
        usagePricingResolution: pricing.resolution,
      })(builtInGenerationContract);
      const callbackBody =
        entry.provider === "fal"
          ? {
              status: "OK",
              payload: { video: { url: sourceUrl, content_type: "video/mp4" } },
            }
          : entry.provider === "byteplus"
            ? {
                status: "succeeded",
                content: { video_url: sourceUrl },
                usage: { completion_tokens: 1 },
              }
            : {
                task: {
                  id: `minimax_${job.generationId}`,
                  status: "succeeded",
                  content: { url: sourceUrl },
                  resolution: "2K",
                  usage: {
                    output_seconds: 5,
                    input_seconds: 0,
                    input_image_count: 0,
                  },
                },
              };
      for (const delivery of [1, 2]) {
        const response = await app.request(job.callbackPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(callbackBody),
        });
        expect(response.status, `callback delivery ${delivery}`).toBe(200);
        await flushWaitUntilForTest();
      }
      const completed = await accept(
        client.get({ headers, params: { generationId: job.generationId } }),
        [200],
      );
      expect(completed.body.status).toBe("completed");
      const result = videoIoGenerateResponseSchema.parse(completed.body.result);
      expect(result).toMatchObject({
        contentType: "video/mp4",
        size: videoBytes.byteLength,
        model: entry.model,
        privateArtifacts: entry.privateArtifacts,
        creditsCharged: entry.credits,
      });
      if (entry.privateArtifacts) {
        expect(result.url).toContain("/artifacts/");
        expect(result.sourceUrl).toBeUndefined();
        context.mocks.clerk.session(`user_${randomUUID()}`, identity.orgId);
        const peer = await client.get({
          headers,
          params: { generationId: job.generationId },
        });
        expect(peer.status).toBe(404);
        context.mocks.clerk.session(identity.userId, identity.orgId);
      } else {
        expect(result.sourceUrl).toBe(sourceUrl);
      }
      const balance = await app.request("/api/billing/status", { headers });
      expect(balance.status).toBe(200);
      await expect(balance.json()).resolves.toMatchObject({
        credits: 10_000 - entry.credits,
      });
    },
  );
});
