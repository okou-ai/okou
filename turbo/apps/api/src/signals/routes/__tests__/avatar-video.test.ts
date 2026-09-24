import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installArtifactReferenceStorage } from "./helpers/artifact-reference-storage";
import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { seedPreviouslyAcceptedVideoJob } from "../../../test-fixtures/previously-accepted-video-job";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactReferenceRoutes } from "../artifact-references";
import { avatarVideoRoutes } from "../avatar-video";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { seedCompose$, seedRun$ } from "./helpers/usage-state";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

const JOGGAI_WEBHOOK_SECRET = randomUUID();
const GENERATED_VIDEO_URL = "https://res.jogg.ai/avatar-video.mp4";
const VIDEO_BYTES = Buffer.from("generated avatar video");
const AVATAR_VIDEO_PRICING_ROWS = [
  {
    kind: "video",
    provider: "joggai-talking-avatar",
    category: "output_video_joggai_credits",
    unitPrice: 623,
    unitSize: 1,
  },
] as const satisfies readonly UsagePricingRow[];

interface AvatarVideoFixture {
  readonly orgId: string;
  readonly usagePricingResolution: UsagePricingFixture["resolution"];
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createAvatarVideoTestApp(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...avatarVideoRoutes,
      ...artifactCatalogRoutes,
      ...artifactReferenceRoutes,
      ...builtInGenerationRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
    ],
    usagePricingResolution,
  });
}

async function seedAvatarVideoFixture(options?: {
  readonly withPricing?: boolean;
}): Promise<AvatarVideoFixture> {
  const pricing = await createUsagePricingFixture(
    (options?.withPricing ?? true)
      ? { configured: AVATAR_VIDEO_PRICING_ROWS }
      : { missing: AVATAR_VIDEO_PRICING_ROWS },
  );
  onTestFinished(pricing.cleanup);
  const fixture = {
    orgId: `org_${randomUUID()}`,
    usagePricingResolution: pricing.resolution,
    userId: `user_${randomUUID()}`,
  };
  await seedOrgMetadata({
    orgId: fixture.orgId,
    tier: "team",
    credits: 10_000,
  });
  await store.set(
    seedOrgMembership$,
    { ...fixture, role: "admin" },
    context.signal,
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Expected record");
}

async function orgCredits(fixture: AvatarVideoFixture): Promise<number> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const response = await createAvatarVideoTestApp(
    fixture.usagePricingResolution,
  ).request("/api/billing/status", { headers: authHeaders() });
  expect(response.status).toBe(200);
  const body = asRecord(await response.json());
  if (typeof body.credits !== "number") {
    throw new Error("Expected numeric credit balance");
  }
  return body.credits;
}

describe("JoggAI built-in avatar video routes", () => {
  beforeEach(() => {
    mockEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://artifacts.okou.test");
    mockEnv("JOGGAI_WEBHOOK_SECRET", JOGGAI_WEBHOOK_SECRET);
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

  it("accepts JoggAI's documented webhook video ID", async () => {
    const webhookBody = JSON.stringify({
      event_id: "event-documented-video-id",
      event: "generated_avatar_video_success",
      timestamp: 1_700_000_000,
      data: {
        video_id: "jogg-documented-video",
        status: "completed",
        video_url: GENERATED_VIDEO_URL,
        cover_url: "https://res.jogg.ai/avatar-video.jpg",
        duration: 30,
      },
    });
    const signature = createHmac("sha256", JOGGAI_WEBHOOK_SECRET)
      .update(webhookBody)
      .digest("hex");

    const response = await createAvatarVideoTestApp().request(
      "/api/webhooks/built-in-generations/joggai",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": signature,
        },
        body: webhookBody,
      },
    );

    expect(response.status).toBe(200);
  });

  it.each([false, true])(
    "completes a previously accepted avatar job with its recorded policy (private=%s)",
    async (privateArtifacts) => {
      const fixture = await seedAvatarVideoFixture();
      installArtifactReferenceStorage(context);
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
      const videoDownloadStarted = createDeferredPromise<void>(context.signal);
      const releaseVideoDownload = createDeferredPromise<void>(context.signal);
      server.use(
        http.get(GENERATED_VIDEO_URL, async () => {
          videoDownloadStarted.resolve(undefined);
          await releaseVideoDownload.promise;
          return new HttpResponse(VIDEO_BYTES, {
            headers: { "content-type": "video/mp4" },
          });
        }),
        http.get(/\/cdn-cgi\/media\//, () => {
          return new HttpResponse(Buffer.from("avatar video poster"), {
            headers: { "content-type": "image/jpeg" },
          });
        }),
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);
      const app = createAvatarVideoTestApp(fixture.usagePricingResolution);
      // New requests now return 410, so only a historical job fixture can
      // exercise a callback that arrives after the retirement deploy.
      const providerVideoId = `jogg_${randomUUID()}`;
      const { generationId } = await seedPreviouslyAcceptedVideoJob({
        ...fixture,
        runId,
        privateArtifacts,
        provider: "joggai",
        providerJobId: providerVideoId,
        request: {
          avatarId: 81,
          voiceId: "en-US-ChristopherNeural",
          script: "Welcome to Okou",
          aspectRatio: "landscape",
          screenStyle: 2,
          caption: false,
          videoName: "Product introduction",
        },
      });

      await updateFeatureSwitchesForUser(context, fixture, {
        [FeatureSwitchKey.PrivateArtifacts]: !privateArtifacts,
      });
      const webhookBody = JSON.stringify({
        event_id: "event-1",
        event: "generated_avatar_video_success",
        timestamp: 1_700_000_000,
        data: {
          project_id: providerVideoId,
          video_url: GENERATED_VIDEO_URL,
          cover_url: "https://res.jogg.ai/private-cover.jpg",
          duration: 121,
        },
      });
      const invalidWebhookResponse = await app.request(
        "/api/webhooks/built-in-generations/joggai",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": "invalid-signature",
          },
          body: webhookBody,
        },
      );
      expect(invalidWebhookResponse.status).toBe(401);

      const signature = createHmac("sha256", JOGGAI_WEBHOOK_SECRET)
        .update(webhookBody)
        .digest("hex");
      const webhookResponse = await app.request(
        "/api/webhooks/built-in-generations/joggai",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": signature,
          },
          body: webhookBody,
        },
      );
      expect(webhookResponse.status).toBe(200);
      await videoDownloadStarted.promise;
      releaseVideoDownload.resolve(undefined);
      await flushWaitUntilForTest();

      const status = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers: authHeaders() },
      );
      expect(status.status).toBe(200);
      const statusBody = asRecord(await status.json());
      expect(statusBody.status).toBe("completed");
      expect(statusBody.result).toMatchObject({
        privateArtifacts,
        url: privateArtifacts
          ? expect.stringMatching(
              /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.mp4$/u,
            )
          : expect.stringMatching(
              /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.mp4$/u,
            ),
        contentType: "video/mp4",
        size: VIDEO_BYTES.byteLength,
        durationSeconds: 121,
        creditsCharged: 1246,
        provider: "joggai",
        model: "joggai-talking-avatar",
        providerVideoId,
        avatarId: 81,
        voiceId: "en-US-ChristopherNeural",
        inputType: "script",
        aspectRatio: "landscape",
        screenStyle: 2,
        caption: false,
        ...(privateArtifacts ? {} : { sourceUrl: GENERATED_VIDEO_URL }),
      });
      expect(
        context.mocks.s3.send.mock.calls.some(([command]) => {
          return (
            command instanceof PutObjectCommand &&
            command.input.ContentType === "video/mp4" &&
            command.input.Bucket ===
              (privateArtifacts
                ? "test-private-artifacts"
                : "test-user-artifacts")
          );
        }),
      ).toBeTruthy();

      mocks.clerk.session(fixture.userId, fixture.orgId);
      const catalogResponse = await app.request(
        "/api/artifacts/catalog?kind=avatar",
        { headers: authHeaders() },
      );
      expect(catalogResponse.status).toBe(200);
      const catalog = asRecord(await catalogResponse.json());
      if (!Array.isArray(catalog.artifacts) || catalog.artifacts.length !== 1) {
        throw new Error("Expected one avatar catalog artifact");
      }
      const avatar = asRecord(catalog.artifacts[0]);
      expect(avatar).toMatchObject({
        kind: "avatar",
        title: expect.stringMatching(/^avatar-video-.*\.mp4$/),
      });
      if (typeof avatar.id !== "string") {
        throw new Error("Expected avatar catalog artifact ID");
      }

      const detailResponse = await app.request(
        `/api/artifacts/catalog/${avatar.id}`,
        { headers: authHeaders() },
      );
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json();
      if (privateArtifacts) {
        expect(statusBody.result).not.toHaveProperty("sourceUrl");
        expect(JSON.stringify(detail)).not.toContain(GENERATED_VIDEO_URL);
        expect(JSON.stringify(detail)).not.toContain("private-cover.jpg");
        expect(
          context.mocks.s3.send.mock.calls.some(([command]) => {
            return (
              command instanceof PutObjectCommand &&
              command.input.ContentType === "image/jpeg"
            );
          }),
        ).toBeFalsy();

        const result = asRecord(statusBody.result);
        if (typeof result.url !== "string") {
          throw new Error("Expected a private avatar artifact reference");
        }
        const resolvePath = `/api/artifact-references/${new URL(result.url).pathname.slice("/artifacts/".length)}`;
        const resolved = await app.request(resolvePath, {
          headers: authHeaders(),
        });
        expect(resolved.status).toBe(200);
        expect(resolved.headers.get("cache-control")).toBe("private, no-store");
        await expect(resolved.json()).resolves.toMatchObject({
          url: expect.stringMatching(/^https:\/\//u),
          contentType: "video/mp4",
          target: { kind: "file", id: result.id },
        });

        const peerUserId = `user_${randomUUID()}`;
        await store.set(
          seedOrgMembership$,
          { orgId: fixture.orgId, userId: peerUserId, role: "member" },
          context.signal,
        );
        mocks.clerk.session(peerUserId, fixture.orgId);
        const denied = await app.request(resolvePath, {
          headers: authHeaders(),
        });
        expect(denied.status).toBe(404);
        mocks.clerk.session(fixture.userId, fixture.orgId);
      }
      expect(detail).toMatchObject({
        kind: "avatar",
        model: "joggai-talking-avatar",
        durationSeconds: 121,
        file: {
          contentType: "video/mp4",
          size: VIDEO_BYTES.byteLength,
        },
      });

      const videoCatalogResponse = await app.request(
        "/api/artifacts/catalog?kind=video",
        { headers: authHeaders() },
      );
      expect(videoCatalogResponse.status).toBe(200);
      expect(
        asRecord(await videoCatalogResponse.json()).artifacts,
      ).toStrictEqual([]);

      const fileCatalogResponse = await app.request(
        "/api/artifacts/catalog?kind=file",
        { headers: authHeaders() },
      );
      expect(fileCatalogResponse.status).toBe(200);
      expect(
        asRecord(await fileCatalogResponse.json()).artifacts,
      ).toStrictEqual([]);
      await expect(orgCredits(fixture)).resolves.toBe(8754);
    },
  );
});
