import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { introVideoPresenterContract } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { buildArtifactKey, buildFileUrlFromKey } from "../../../lib/file-url";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { introVideoPresenterRoutes } from "../intro-video-presenter";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { seedCompose$, seedRun$ } from "./helpers/usage-state";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

const HEYGEN_CREATE_URL = "https://api.heygen.com/v3/videos";
const HEYGEN_AVATARS_URL = "https://api.heygen.com/v3/avatars/looks";
const HEYGEN_STYLES_URL = "https://api.heygen.com/v3/video-agents/styles";
const HEYGEN_VOICES_URL = "https://api.heygen.com/v3/voices";
const HEYGEN_SPEECH_URL = `${HEYGEN_VOICES_URL}/speech`;
const HEYGEN_VIDEO_ID = "heygen-video-123";
const HEYGEN_STATUS_URL = `${HEYGEN_CREATE_URL}/${HEYGEN_VIDEO_ID}`;
const HEYGEN_VIDEO_URL = "https://files.heygen.test/presenter.webm";
const HEYGEN_AUDIO_URL = "https://files.heygen.test/narration.mp3";
const VIDEO_BYTES = Buffer.from("generated intro video presenter");
const AUDIO_BYTES = Buffer.from("generated intro video narration");
const PRICING_ROWS = [
  {
    kind: "video",
    provider: "heygen-avatar-iii",
    category: "output_video_seconds",
    unitPrice: 1250,
    unitSize: 60,
  },
  {
    kind: "audio",
    provider: "heygen-starfish-tts",
    category: "output_audio_seconds",
    unitPrice: 40,
    unitSize: 60,
  },
] as const satisfies readonly UsagePricingRow[];

interface IntroVideoPresenterFixture {
  readonly orgId: string;
  readonly usagePricingResolution: UsagePricingFixture["resolution"];
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createIntroVideoPresenterTestApp(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...introVideoPresenterRoutes,
      ...artifactCatalogRoutes,
      ...builtInGenerationRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
    ],
    usagePricingResolution,
  });
}

function introVideoPresenterClient(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return setupApp({
    context,
    routes: introVideoPresenterRoutes,
    usagePricingResolution,
  })(introVideoPresenterContract);
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

async function seedFixture(): Promise<IntroVideoPresenterFixture> {
  const pricing = await createUsagePricingFixture({ configured: PRICING_ROWS });
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

async function enableIntroVideo(
  fixture: IntroVideoPresenterFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.IntroVideo]: true,
  });
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

async function orgCredits(
  fixture: IntroVideoPresenterFixture,
): Promise<number> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const response = await createIntroVideoPresenterTestApp(
    fixture.usagePricingResolution,
  ).request("/api/billing/status", { headers: authHeaders() });
  expect(response.status).toBe(200);
  const body = asRecord(await response.json());
  if (typeof body.credits !== "number") {
    throw new Error("Expected numeric credit balance");
  }
  return body.credits;
}

describe("Intro Video HeyGen presenter route", () => {
  beforeEach(() => {
    mockEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://artifacts.okou.test");
    mockEnv("HEYGEN_API_KEY", "test-heygen-key");
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

  it("rejects agent requests while Intro Video is disabled", async () => {
    const fixture = await seedFixture();
    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
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
    const response = await createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    ).request("/api/intro-video/presenter/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${okouToken({ ...fixture, runId })}` },
      body: JSON.stringify({
        avatarId: "Abigail_standing_office_front",
        audioUrl: "https://example.com/narration.mp3",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Intro Video is not enabled",
      },
    });
  });

  it("rejects direct sessions and non-curated presenter IDs", async () => {
    const fixture = await seedFixture();
    const app = createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const sessionResponse = await app.request(
      "/api/intro-video/presenter/generate",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          avatarId: "Abigail_standing_office_front",
          audioUrl: "https://example.com/narration.mp3",
        }),
      },
    );
    expect(sessionResponse.status).toBe(403);

    await enableIntroVideo(fixture);

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
    const unknownAvatarResponse = await app.request(
      "/api/intro-video/presenter/generate",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          avatarId: "private_or_removed_look",
          audioUrl: "https://example.com/narration.mp3",
        }),
      },
    );
    expect(unknownAvatarResponse.status).toBe(400);
    await expect(unknownAvatarResponse.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("lists only public HeyGen Starfish voices a user can audition", async () => {
    const fixture = await seedFixture();
    await enableIntroVideo(fixture);
    const requestedTokens: (string | null)[] = [];
    server.use(
      http.get(HEYGEN_VOICES_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
        requestedTokens.push(url.searchParams.get("token"));
        expect(Object.fromEntries(url.searchParams)).toStrictEqual({
          type: "public",
          engine: "starfish",
          // Scanning past the provider's sample-less ranking uses its widest page.
          limit: "100",
          language: "English",
          gender: "female",
          ...(url.searchParams.has("token")
            ? { token: "silent-voice-page" }
            : {}),
        });
        // HeyGen ranks its newest voices first and none of them carry a sample,
        // so the first provider page holds nothing the wizard can offer.
        if (!url.searchParams.has("token")) {
          return HttpResponse.json({
            data: [
              {
                voice_id: "00e3d285aba44b27a83c47c02c9c2d9c",
                name: "Orson - Firm & Measured",
                language: "English",
                gender: "female",
                type: "public",
              },
            ],
            has_more: true,
            next_token: "silent-voice-page",
          });
        }
        return HttpResponse.json({
          data: [
            {
              voice_id: "330290724a1b470fb63153f34d4c0183",
              name: "Annie - Lifelike",
              language: "English",
              gender: "female",
              preview_audio_url: "https://files.heygen.test/annie.wav",
              type: "public",
            },
            {
              voice_id: "02052ba42f3d4d50a809b964bb8b1b94",
              name: "Davor - Firm & Measured",
              language: "English",
              gender: "female",
              type: "public",
            },
          ],
          has_more: true,
          next_token: "next-voice-page",
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    ).request(
      "/api/intro-video/voices?pageSize=1&language=English&gender=female",
      { headers: authHeaders() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      voices: [
        {
          id: "330290724a1b470fb63153f34d4c0183",
          name: "Annie - Lifelike",
          language: "English",
          gender: "female",
          sampleUrl: "https://files.heygen.test/annie.wav",
        },
      ],
      hasMore: true,
      nextToken: "next-voice-page",
    });
    expect(requestedTokens).toStrictEqual([null, "silent-voice-page"]);

    server.use(
      http.get(HEYGEN_VOICES_URL, () => {
        return HttpResponse.json(
          { error: { message: "invalid page token" } },
          { status: 400 },
        );
      }),
    );
    const invalidTokenResponse = await accept(
      introVideoPresenterClient(fixture.usagePricingResolution).voices({
        headers: authHeaders(),
        query: { token: "expired" },
      }),
      [400],
    );
    expect(invalidTokenResponse.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "HeyGen rejected the request: invalid page token",
      },
    });
  });

  it("lists public HeyGen styles and auditionable Avatar III looks", async () => {
    const fixture = await seedFixture();
    await enableIntroVideo(fixture);
    server.use(
      http.get(HEYGEN_STYLES_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
        expect(Object.fromEntries(url.searchParams)).toStrictEqual({
          limit: "24",
        });
        return HttpResponse.json({
          data: [
            {
              style_id: "349d91e1ad2444eabab2672a9057f298",
              name: "Thriller",
              thumbnail_url: "https://files.heygen.test/thriller.jpg",
              preview_video_url: "https://files.heygen.test/thriller.mp4",
              tags: ["cinematic"],
              aspect_ratio: "16:9",
            },
            { style_id: "invalid/style", name: "Malformed style" },
          ],
          has_more: false,
          next_token: null,
        });
      }),
      http.get(HEYGEN_AVATARS_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
        expect(Object.fromEntries(url.searchParams)).toStrictEqual({
          ownership: "public",
          avatar_type: "studio_avatar",
          limit: "50",
        });
        return HttpResponse.json({
          data: [
            {
              id: "Daphne_public_1",
              group_id: "c1926d821b4d43d6a5f07f2985bb5cd1",
              name: "Daphne in Grey blazer",
              default_voice_id: "812d4eea4a8442a382dcaf2dbaddbd93",
              avatar_type: "studio_avatar",
              preview_image_url: "https://files.heygen.test/daphne.webp",
              preview_video_url: "https://files.heygen.test/daphne.mp4",
              gender: "female",
              image_width: 1080,
              image_height: 1080,
              preferred_orientation: "portrait",
              status: "completed",
              supported_api_engines: ["avatar_iii"],
            },
            {
              id: "Legacy_public_1",
              group_id: "legacy-group",
              name: "Legacy",
              default_voice_id: "legacy-voice",
              status: "completed",
              supported_api_engines: ["avatar_iv"],
            },
            {
              id: "invalid/avatar",
              group_id: "malformed-group",
              name: "Malformed avatar",
              default_voice_id: "malformed-voice",
              status: "completed",
              supported_api_engines: ["avatar_iii"],
            },
            {
              id: "Silent_public_1",
              group_id: "e0a2c5e5b1f04a4ba6ee2f6e0a1c9d77",
              name: "Silent in Blue suit",
              default_voice_id: "5b4d2f1c9e7a4c3b8d6f0a1e2c3b4d5e",
              avatar_type: "studio_avatar",
              preview_image_url: "https://files.heygen.test/silent.webp",
              status: "completed",
              supported_api_engines: ["avatar_iii"],
            },
            {
              id: "Retired_public_1",
              group_id: "f1b3d6f6c2e15b5cb7ff3f7f1b2dae88",
              name: "Retired in Grey suit",
              default_voice_id: "6c5e3a2d0f8b5d4c9e7a1b2c3d4e5f60",
              avatar_type: "studio_avatar",
              preview_image_url: "https://files.heygen.test/retired.webp",
              status: "completed",
              supported_api_engines: ["avatar_iii"],
            },
          ],
          has_more: false,
          next_token: null,
        });
      }),
      // A look is offered only when its own voice can be auditioned first.
      http.get(`${HEYGEN_VOICES_URL}/:voiceId`, ({ params }) => {
        if (params.voiceId === "812d4eea4a8442a382dcaf2dbaddbd93") {
          return HttpResponse.json({
            data: {
              voice_id: "812d4eea4a8442a382dcaf2dbaddbd93",
              name: "Daphne - Warm & Friendly",
              language: "English",
              gender: "female",
              preview_audio_url: "https://files.heygen.test/daphne-voice.wav",
            },
          });
        }
        if (params.voiceId === "5b4d2f1c9e7a4c3b8d6f0a1e2c3b4d5e") {
          return HttpResponse.json({
            data: {
              voice_id: "5b4d2f1c9e7a4c3b8d6f0a1e2c3b4d5e",
              name: "Orson - Firm & Measured",
              language: "English",
              gender: "male",
            },
          });
        }
        return HttpResponse.json(
          { error: { message: "voice not found" } },
          { status: 404 },
        );
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    );

    const [stylesResponse, avatarsResponse] = await Promise.all([
      app.request("/api/intro-video/styles?pageSize=24", {
        headers: authHeaders(),
      }),
      app.request("/api/intro-video/avatars?pageSize=100", {
        headers: authHeaders(),
      }),
    ]);

    expect(stylesResponse.status).toBe(200);
    await expect(stylesResponse.json()).resolves.toStrictEqual({
      styles: [
        {
          id: "349d91e1ad2444eabab2672a9057f298",
          name: "Thriller",
          thumbnailUrl: "https://files.heygen.test/thriller.jpg",
          previewVideoUrl: "https://files.heygen.test/thriller.mp4",
          tags: ["cinematic"],
          aspectRatio: "16:9",
        },
      ],
      hasMore: false,
      nextToken: null,
    });
    expect(avatarsResponse.status).toBe(200);
    await expect(avatarsResponse.json()).resolves.toStrictEqual({
      avatars: [
        {
          id: "Daphne_public_1",
          groupId: "c1926d821b4d43d6a5f07f2985bb5cd1",
          name: "Daphne in Grey blazer",
          defaultVoiceId: "812d4eea4a8442a382dcaf2dbaddbd93",
          defaultVoiceName: "Daphne - Warm & Friendly",
          defaultVoiceSampleUrl: "https://files.heygen.test/daphne-voice.wav",
          avatarType: "studio_avatar",
          previewImageUrl: "https://files.heygen.test/daphne.webp",
          previewVideoUrl: "https://files.heygen.test/daphne.mp4",
          gender: "female",
          imageWidth: 1080,
          imageHeight: 1080,
          preferredOrientation: "portrait",
        },
      ],
      hasMore: false,
      nextToken: null,
    });
  });

  it.each(["avatars", "styles"] as const)(
    "preserves the provider's invalid-cursor error for %s",
    async (catalog) => {
      const fixture = await seedFixture();
      await enableIntroVideo(fixture);
      server.use(
        http.get(
          catalog === "avatars" ? HEYGEN_AVATARS_URL : HEYGEN_STYLES_URL,
          () => {
            return HttpResponse.json(
              { error: { message: "Invalid pagination token" } },
              { status: 400 },
            );
          },
        ),
      );
      const client = introVideoPresenterClient(fixture.usagePricingResolution);
      const request = {
        headers: authHeaders(),
        query: { token: "expired-cursor" },
      };
      const result =
        catalog === "avatars"
          ? await accept(client.avatars(request), [400])
          : await accept(client.styles(request), [400]);
      expect(result.body).toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message: "HeyGen rejected the request: Invalid pagination token",
        },
      });
    },
  );

  it("reports a failed default-voice lookup instead of hiding looks", async () => {
    const fixture = await seedFixture();
    await enableIntroVideo(fixture);
    server.use(
      http.get(HEYGEN_AVATARS_URL, () => {
        return HttpResponse.json({
          data: [
            {
              id: "Daphne_public_1",
              group_id: "c1926d821b4d43d6a5f07f2985bb5cd1",
              name: "Daphne in Grey blazer",
              default_voice_id: "812d4eea4a8442a382dcaf2dbaddbd93",
              avatar_type: "studio_avatar",
              preview_image_url: "https://files.heygen.test/daphne.webp",
              status: "completed",
              supported_api_engines: ["avatar_iii"],
            },
          ],
          has_more: false,
          next_token: null,
        });
      }),
      http.get(`${HEYGEN_VOICES_URL}/:voiceId`, () => {
        return HttpResponse.json(
          { error: { message: "voice service down" } },
          { status: 500 },
        );
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const result = await accept(
      introVideoPresenterClient(fixture.usagePricingResolution).avatars({
        headers: authHeaders(),
        query: {},
      }),
      [503],
    );
    expect(result.body).toStrictEqual({
      error: {
        code: "HEYGEN_UNAVAILABLE",
        message: "HeyGen is temporarily unavailable",
      },
    });
  });

  it("rejects a dynamically selected avatar that is not public", async () => {
    const fixture = await seedFixture();
    await enableIntroVideo(fixture);
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
    server.use(
      http.get(HEYGEN_AVATARS_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(Object.fromEntries(url.searchParams)).toStrictEqual({
          ownership: "public",
          avatar_type: "studio_avatar",
          limit: "50",
          group_id: "private-group",
        });
        return HttpResponse.json({
          data: [],
          has_more: false,
          next_token: null,
        });
      }),
    );
    const response = await createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    ).request("/api/intro-video/presenter/generate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${okouToken({ ...fixture, runId })}`,
      },
      body: JSON.stringify({
        avatarId: "Private_avatar_1",
        avatarGroupId: "private-group",
        audioUrl: "https://example.com/narration.mp3",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "HeyGen avatar is not available in Intro Video",
      },
    });
  });

  it.each([false, true])(
    "generates HeyGen voice with the shared artifact policy (private=%s)",
    async (privateArtifacts) => {
      const fixture = await seedFixture();
      await enableIntroVideo(fixture);
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
      const voiceId = "330290724a1b470fb63153f34d4c0183";
      let speechRequests = 0;
      let audioDownloads = 0;
      server.use(
        http.get(HEYGEN_VOICES_URL, ({ request }) => {
          expect(
            Object.fromEntries(new URL(request.url).searchParams),
          ).toStrictEqual({
            type: "public",
            engine: "starfish",
            limit: "100",
          });
          return HttpResponse.json({
            data: [
              {
                voice_id: voiceId,
                name: "Annie - Lifelike",
                type: "public",
              },
            ],
            has_more: false,
            next_token: null,
          });
        }),
        http.post(HEYGEN_SPEECH_URL, async ({ request }) => {
          speechRequests += 1;
          expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
          await expect(request.json()).resolves.toStrictEqual({
            text: "Welcome to the launch.",
            voice_id: voiceId,
            input_type: "text",
            speed: 1,
          });
          return HttpResponse.json({
            data: {
              audio_url: HEYGEN_AUDIO_URL,
              duration: 61,
              request_id: "speech-request-123",
            },
          });
        }),
        http.get(HEYGEN_AUDIO_URL, () => {
          audioDownloads += 1;
          return new HttpResponse(AUDIO_BYTES, {
            headers: { "content-type": "audio/mpeg" },
          });
        }),
      );
      const response = await createIntroVideoPresenterTestApp(
        fixture.usagePricingResolution,
      ).request("/api/intro-video/voice/generate", {
        method: "POST",
        headers: {
          authorization: `Bearer ${okouToken({
            ...fixture,
            runId,
          })}`,
        },
        body: JSON.stringify({
          voiceId,
          text: "Welcome to the launch.",
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: expect.any(String),
        filename: expect.stringMatching(/^intro-video-voice-.*\.mp3$/u),
        privateArtifacts,
        contentType: "audio/mpeg",
        size: AUDIO_BYTES.byteLength,
        url: privateArtifacts
          ? expect.stringMatching(/^\/artifacts\/[a-z0-9]{10}\.mp3$/u)
          : expect.stringContaining("https://a.okou.io/"),
        durationSeconds: 61,
        creditsCharged: 41,
        voiceId,
      });
      expect(speechRequests).toBe(1);
      expect(audioDownloads).toBe(1);
      expect(
        context.mocks.s3.send.mock.calls.some(([command]) => {
          return (
            command instanceof PutObjectCommand &&
            command.input.ContentType === "audio/mpeg" &&
            command.input.Bucket ===
              (privateArtifacts
                ? "test-private-artifacts"
                : "test-user-artifacts")
          );
        }),
      ).toBeTruthy();
      mocks.clerk.session(fixture.userId, fixture.orgId);
      for (const query of ["", "?kind=file"]) {
        const catalogResponse = await createIntroVideoPresenterTestApp(
          fixture.usagePricingResolution,
        ).request(`/api/artifacts/catalog${query}`, {
          headers: authHeaders(),
        });
        expect(catalogResponse.status).toBe(200);
        expect(asRecord(await catalogResponse.json()).artifacts).toStrictEqual(
          [],
        );
      }
      await expect(orgCredits(fixture)).resolves.toBe(9959);
    },
  );

  it.each([
    {
      kind: "private curated",
      avatarId: "Abigail_standing_office_front",
      avatarGroupId: undefined,
      privateArtifacts: true,
    },
    {
      kind: "curated",
      privateArtifacts: false,
      avatarId: "Abigail_standing_office_front",
      avatarGroupId: undefined,
    },
    {
      kind: "public catalog",
      privateArtifacts: false,
      avatarId: "Public_presenter_office",
      avatarGroupId: "public-presenter-group",
    },
  ])(
    "renders a $kind presenter through HeyGen v3 idempotently",
    async ({ avatarId, avatarGroupId, privateArtifacts }) => {
      const fixture = await seedFixture();
      await enableIntroVideo(fixture);
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
      const audioKey = buildArtifactKey(
        fixture.userId,
        randomUUID(),
        "narration.mp3",
      );
      const audioUrl = buildFileUrlFromKey(audioKey, "okou");
      const token = okouToken({ ...fixture, runId });
      const observedCreateRequests: {
        readonly body: Record<string, unknown>;
        readonly idempotencyKey: string | null;
      }[] = [];
      let statusCalls = 0;
      let videoDownloads = 0;
      server.use(
        http.get(HEYGEN_AVATARS_URL, ({ request }) => {
          const token = new URL(request.url).searchParams.get("token");
          expect(
            Object.fromEntries(new URL(request.url).searchParams),
          ).toStrictEqual({
            ownership: "public",
            avatar_type: "studio_avatar",
            limit: "50",
            group_id: avatarGroupId,
            ...(token ? { token: "next-public-look" } : {}),
          });
          return HttpResponse.json({
            data: [
              {
                id: token ? avatarId : "Another_public_look",
                group_id: avatarGroupId,
                name: token
                  ? "Public presenter in office"
                  : "Public presenter outdoors",
                default_voice_id: "330290724a1b470fb63153f34d4c0183",
                status: "completed",
                supported_api_engines: ["avatar_iii"],
              },
            ],
            has_more: !token,
            next_token: token ? null : "next-public-look",
          });
        }),
        http.post(HEYGEN_CREATE_URL, async ({ request }) => {
          observedCreateRequests.push({
            body: asRecord(await request.json()),
            idempotencyKey: request.headers.get("idempotency-key"),
          });
          expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
          if (observedCreateRequests.length === 1) {
            return HttpResponse.json(
              { error: { message: "slow down" } },
              { status: 429, headers: { "retry-after": "0" } },
            );
          }
          return HttpResponse.json({
            data: {
              video_id: HEYGEN_VIDEO_ID,
              status: "pending",
              output_format: "webm",
            },
          });
        }),
        http.get(HEYGEN_STATUS_URL, () => {
          statusCalls += 1;
          if (statusCalls === 1) {
            return HttpResponse.json(
              { error: { message: "temporary provider outage" } },
              { status: 503 },
            );
          }
          return HttpResponse.json({
            data:
              statusCalls === 2
                ? { id: HEYGEN_VIDEO_ID, status: "processing" }
                : {
                    id: HEYGEN_VIDEO_ID,
                    status: "completed",
                    video_url: HEYGEN_VIDEO_URL,
                    duration: 61,
                  },
          });
        }),
        http.get(HEYGEN_VIDEO_URL, () => {
          videoDownloads += 1;
          return new HttpResponse(VIDEO_BYTES, {
            headers: { "content-type": "video/webm" },
          });
        }),
      );
      const app = createIntroVideoPresenterTestApp(
        fixture.usagePricingResolution,
      );
      const response = await app.request(
        "/api/intro-video/presenter/generate",
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            avatarId,
            avatarGroupId,
            audioUrl,
          }),
        },
      );

      expect(response.status).toBe(202);
      const generationId = readGenerationId(
        await response.json(),
        fixture.userId,
      );
      expect(observedCreateRequests).toHaveLength(2);
      expect(observedCreateRequests[0]?.idempotencyKey).toBe(generationId);
      expect(observedCreateRequests[1]?.idempotencyKey).toBe(generationId);
      expect(observedCreateRequests[0]?.body).toStrictEqual(
        observedCreateRequests[1]?.body,
      );
      const createBody = observedCreateRequests[1]?.body;
      expect(createBody).toMatchObject({
        type: "avatar",
        engine: { type: "avatar_iii" },
        avatar_id: avatarId,
        audio_url: expect.stringMatching(/^https:\/\/r2\.example\.com\//u),
        aspect_ratio: "16:9",
        resolution: "1080p",
        output_format: "webm",
        callback_id: generationId,
        callback_url: expect.stringContaining(
          `/api/webhooks/built-in-generations/heygen/${generationId}?token=`,
        ),
      });
      expect(createBody).not.toHaveProperty("voice_id");
      expect(createBody).not.toHaveProperty("script");
      expect(createBody).not.toHaveProperty("background");
      const callbackUrl = new URL(String(createBody?.callback_url));

      for (let index = 0; index < 2; index += 1) {
        const additionalResponse = await app.request(
          "/api/intro-video/presenter/generate",
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({
              avatarId,
              avatarGroupId,
              audioUrl,
            }),
          },
        );
        expect(additionalResponse.status).toBe(202);
      }
      const limitedResponse = await accept(
        introVideoPresenterClient(fixture.usagePricingResolution).generate({
          headers: { authorization: `Bearer ${token}` },
          body: {
            avatarId,
            avatarGroupId,
            audioUrl,
          },
        }),
        [429],
      );
      expect(limitedResponse.body).toMatchObject({
        error: { code: "BUILT_IN_RUN_CONCURRENCY_LIMIT" },
      });
      expect(observedCreateRequests).toHaveLength(4);

      const invalidCallback = new URL(callbackUrl);
      invalidCallback.searchParams.set("token", "invalid");
      const invalidResponse = await app.request(
        `${invalidCallback.pathname}${invalidCallback.search}`,
        { method: "POST", body: "{}" },
      );
      expect(invalidResponse.status).toBe(401);

      const providerUnavailableResponse = await app.request(
        `${callbackUrl.pathname}${callbackUrl.search}`,
        { method: "POST", body: "{}" },
      );
      expect(providerUnavailableResponse.status).toBe(503);
      const activeStatusResponse = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers: authHeaders() },
      );
      expect(activeStatusResponse.status).toBe(200);
      expect(asRecord(await activeStatusResponse.json()).status).toBe(
        "running",
      );

      const pendingResponse = await app.request(
        `${callbackUrl.pathname}${callbackUrl.search}`,
        { method: "POST", body: "{}" },
      );
      expect(pendingResponse.status).toBe(503);

      const completedResponse = await app.request(
        `${callbackUrl.pathname}${callbackUrl.search}`,
        { method: "POST", body: "{}" },
      );
      expect(completedResponse.status).toBe(200);
      await flushWaitUntilForTest();

      const status = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers: authHeaders() },
      );
      expect(status.status).toBe(200);
      const statusBody = asRecord(await status.json());
      expect(statusBody.status).toBe("completed");
      expect(statusBody.result).toStrictEqual({
        id: expect.any(String),
        filename: expect.stringMatching(/^intro-video-presenter-.*\.webm$/u),
        privateArtifacts,
        contentType: "video/webm",
        size: VIDEO_BYTES.byteLength,
        url: privateArtifacts
          ? expect.stringMatching(/^\/artifacts\/[a-z0-9]{10}\.webm$/u)
          : expect.stringContaining("https://a.okou.io/"),
        durationSeconds: 61,
        creditsCharged: 1271,
        avatarId,
      });
      expect(videoDownloads).toBe(1);
      expect(
        context.mocks.s3.send.mock.calls.some(([command]) => {
          return (
            command instanceof PutObjectCommand &&
            command.input.ContentType === "video/webm" &&
            command.input.Bucket ===
              (privateArtifacts
                ? "test-private-artifacts"
                : "test-user-artifacts")
          );
        }),
      ).toBeTruthy();

      mocks.clerk.session(fixture.userId, fixture.orgId);
      for (const query of ["", "?kind=avatar", "?kind=file", "?kind=video"]) {
        const catalogResponse = await app.request(
          `/api/artifacts/catalog${query}`,
          { headers: authHeaders() },
        );
        expect(catalogResponse.status).toBe(200);
        expect(asRecord(await catalogResponse.json()).artifacts).toStrictEqual(
          [],
        );
      }

      const duplicateResponse = await app.request(
        `${callbackUrl.pathname}${callbackUrl.search}`,
        { method: "POST", body: "{}" },
      );
      expect(duplicateResponse.status).toBe(200);
      await flushWaitUntilForTest();
      expect(videoDownloads).toBe(1);
      await expect(orgCredits(fixture)).resolves.toBe(8729);
    },
  );
});
