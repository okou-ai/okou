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
import { buildArtifactKey, buildFileUrlFromKey } from "../../../lib/file-url";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
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
const TEST_BUCKET = "test-user-artifacts";

const JOGGAI_CREATE_URL = "https://api.jogg.ai/v2/create_video_from_avatar";
const JOGGAI_AVATARS_URL = "https://api.jogg.ai/v2/avatars/public";
const JOGGAI_VOICES_URL = "https://api.jogg.ai/v2/voices";
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

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["file:write"],
    iat: seconds,
    exp: seconds + 60,
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

function readGenerationId(value: unknown, userId: string): string {
  const body = asRecord(value);
  if (typeof body.generationId !== "string") {
    throw new Error("Expected generation ID");
  }
  expect(body).toMatchObject({
    generationId: body.generationId,
    type: "video",
    status: "queued",
    realtime: {
      channelName: `user:${userId}`,
      eventName: `built-in-generation:${body.generationId}`,
    },
  });
  return body.generationId;
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
    mockEnv("JOGGAI_API_KEY", "test-joggai-key");
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

  it("lists and normalizes public avatars and voices", async () => {
    const fixture = await seedAvatarVideoFixture();
    const observedUrls: string[] = [];
    server.use(
      http.get(JOGGAI_AVATARS_URL, ({ request }) => {
        observedUrls.push(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-joggai-key");
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: {
            avatars: [
              {
                id: 81,
                name: "Ada",
                video_url: "https://res.jogg.ai/ada.mp4",
                cover_url: "https://res.jogg.ai/ada.jpg",
                aspect_ratio: 1,
                style: "professional",
                gender: "female",
                age: "adult",
              },
            ],
          },
        });
      }),
      http.get(JOGGAI_VOICES_URL, ({ request }) => {
        observedUrls.push(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-joggai-key");
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: {
            voices: [
              {
                voice_id: "en-US-ChristopherNeural",
                name: "Christopher",
                audio_url: "https://res.jogg.ai/christopher.mp3",
                language: "english",
                gender: "male",
                age: "young",
                accent: "american",
                use_case: "narrative_story",
              },
            ],
            has_more: true,
          },
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createAvatarVideoTestApp(fixture.usagePricingResolution);

    const avatars = await app.request(
      "/api/avatar-video/avatars?page=2&pageSize=20&aspectRatio=portrait&style=professional",
      { headers: authHeaders() },
    );
    expect(avatars.status).toBe(200);
    await expect(avatars.json()).resolves.toStrictEqual({
      avatars: [
        {
          id: 81,
          name: "Ada",
          videoUrl: "https://res.jogg.ai/ada.mp4",
          coverUrl: "https://res.jogg.ai/ada.jpg",
          aspectRatio: 1,
          style: "professional",
          gender: "female",
          age: "adult",
        },
      ],
    });

    const voices = await app.request(
      "/api/avatar-video/voices?page=3&pageSize=25&language=english&gender=male",
      { headers: authHeaders() },
    );
    expect(voices.status).toBe(200);
    await expect(voices.json()).resolves.toStrictEqual({
      voices: [
        {
          id: "en-US-ChristopherNeural",
          name: "Christopher",
          sampleUrl: "https://res.jogg.ai/christopher.mp3",
          language: "english",
          gender: "male",
          age: "young",
          accent: "american",
          useCase: "narrative_story",
        },
      ],
      hasMore: true,
      filterOptions: {
        languages: ["english"],
        useCases: ["narrative_story"],
      },
    });

    expect(new URL(observedUrls[0] ?? "").searchParams.toString()).toBe(
      "page=2&page_size=20&aspect_ratio=portrait&style=professional",
    );
    expect(new URL(observedUrls[1] ?? "").searchParams.toString()).toBe(
      "page=3&page_size=25&gender=male&language=english",
    );
  });

  it("paginates full collections returned by JoggAI", async () => {
    const fixture = await seedAvatarVideoFixture();
    const avatars = Array.from({ length: 25 }, (_, index) => {
      const id = index + 1;
      return { id, name: `Avatar ${String(id)}` };
    });
    const voices = Array.from({ length: 25 }, (_, index) => {
      const id = index + 1;
      return { voice_id: `voice-${String(id)}`, name: `Voice ${String(id)}` };
    });
    server.use(
      http.get(JOGGAI_AVATARS_URL, () => {
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: { avatars },
        });
      }),
      http.get(JOGGAI_VOICES_URL, () => {
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: { voices, has_more: true },
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createAvatarVideoTestApp(fixture.usagePricingResolution);

    const avatarResponse = await app.request(
      "/api/avatar-video/avatars?page=2&pageSize=10",
      { headers: authHeaders() },
    );
    expect(avatarResponse.status).toBe(200);
    const avatarBody = asRecord(await avatarResponse.json());
    expect(
      Array.isArray(avatarBody.avatars)
        ? avatarBody.avatars.map((avatar) => {
            return asRecord(avatar).id;
          })
        : [],
    ).toStrictEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

    const voiceResponse = await app.request(
      "/api/avatar-video/voices?page=3&pageSize=10",
      { headers: authHeaders() },
    );
    expect(voiceResponse.status).toBe(200);
    const voiceBody = asRecord(await voiceResponse.json());
    expect(
      Array.isArray(voiceBody.voices)
        ? voiceBody.voices.map((voice) => {
            return asRecord(voice).id;
          })
        : [],
    ).toStrictEqual([
      "voice-21",
      "voice-22",
      "voice-23",
      "voice-24",
      "voice-25",
    ]);
    expect(voiceBody.hasMore).toBeFalsy();
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
    "stores talking-avatar catalog output with its recorded policy (private=%s)",
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
      const token = okouToken({ ...fixture, runId });
      const videoDownloadStarted = createDeferredPromise<void>(context.signal);
      const releaseVideoDownload = createDeferredPromise<void>(context.signal);
      let observedBody: unknown = null;
      let observedApiKey: string | null = null;
      server.use(
        http.post(JOGGAI_CREATE_URL, async ({ request }) => {
          observedApiKey = request.headers.get("x-api-key");
          observedBody = await request.json();
          return HttpResponse.json({
            code: 0,
            msg: "Success",
            data: { video_id: "jogg-video-123" },
          });
        }),
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
      const response = await app.request(
        privateArtifacts
          ? "/api/avatar-video/generate/private"
          : "/api/avatar-video/generate",
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            avatarId: 81,
            voiceId: "en-US-ChristopherNeural",
            script: "Welcome to Okou",
            aspectRatio: "landscape",
            screenStyle: 2,
            caption: false,
            videoName: "Product introduction",
          }),
        },
      );

      expect(response.status).toBe(202);
      const generationId = readGenerationId(
        await response.json(),
        fixture.userId,
      );
      expect(observedApiKey).toBe("test-joggai-key");
      expect(observedBody).toMatchObject({
        avatar: { avatar_type: 0, avatar_id: 81 },
        voice: {
          type: "script",
          voice_id: "en-US-ChristopherNeural",
          script: "Welcome to Okou",
        },
        aspect_ratio: "landscape",
        screen_style: 2,
        caption: false,
        video_name: "Product introduction",
      });
      expect(asRecord(observedBody)).not.toHaveProperty("webhook_url");

      await updateFeatureSwitchesForUser(context, fixture, {
        [FeatureSwitchKey.PrivateArtifacts]: !privateArtifacts,
      });
      const webhookBody = JSON.stringify({
        event_id: "event-1",
        event: "generated_avatar_video_success",
        timestamp: 1_700_000_000,
        data: {
          project_id: "jogg-video-123",
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
        providerVideoId: "jogg-video-123",
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

  it("maps audio input without exposing private JoggAI resources", async () => {
    const fixture = await seedAvatarVideoFixture();
    const audioKey = buildArtifactKey(
      fixture.userId,
      randomUUID(),
      "voice.mp3",
    );
    const audioUrl = buildFileUrlFromKey(audioKey, "okou");
    let observedBody: unknown = null;
    server.use(
      http.post(JOGGAI_CREATE_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: { video_id: "jogg-audio-video" },
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await createAvatarVideoTestApp(
      fixture.usagePricingResolution,
    ).request("/api/avatar-video/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        avatarId: 82,
        voiceId: "en-US-AvaNeural",
        audioUrl,
      }),
    });

    expect(response.status).toBe(202);
    expect(observedBody).toMatchObject({
      avatar: { avatar_type: 0, avatar_id: 82 },
      voice: {
        type: "audio",
        voice_id: "en-US-AvaNeural",
        audio_url: expect.any(String),
      },
      aspect_ratio: "portrait",
      screen_style: 1,
      caption: true,
    });
    const providerAudioUrl = asRecord(asRecord(observedBody).voice).audio_url;
    if (typeof providerAudioUrl !== "string") {
      throw new Error("Expected JoggAI audio URL");
    }
    const signedAudioUrl = new URL(providerAudioUrl);
    expect(signedAudioUrl.origin).toBe("https://r2.example.com");
    expect(signedAudioUrl.searchParams.get("object")).toBe(
      `${TEST_BUCKET}/${audioKey}`,
    );
  });

  it("disables captions by default for a transparent background", async () => {
    const fixture = await seedAvatarVideoFixture();
    let observedBody: unknown = null;
    server.use(
      http.post(JOGGAI_CREATE_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: { video_id: "jogg-transparent-video" },
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await createAvatarVideoTestApp(
      fixture.usagePricingResolution,
    ).request("/api/avatar-video/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        avatarId: 1790,
        voiceId: "en-US-AvaNeural",
        script: "Welcome to Okou",
        screenStyle: 3,
      }),
    });

    expect(response.status).toBe(202);
    expect(observedBody).toMatchObject({
      avatar: { avatar_type: 0, avatar_id: 1790 },
      screen_style: 3,
      caption: false,
    });
  });
});
