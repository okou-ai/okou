import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { installArtifactReferenceStorage } from "./helpers/artifact-reference-storage";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  introVideoAgentResponseSchema,
  type IntroVideoAgentGenerateRequest,
} from "@okouai/api-contracts/contracts/intro-video-agent";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import {
  buildArtifactKey,
  buildArtifactKeyV2,
  buildFileUrlFromKey,
} from "../../../lib/file-url";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { introVideoAgentRoutes } from "../intro-video-agent";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { seedBuiltInDefaultModelKey } from "./helpers/runtime-state";
import { seedCompose$, seedRun$ } from "./helpers/usage-state";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const HEYGEN_BASE = "https://api.heygen.com/v3";
const HEYGEN_CREATE_URL = `${HEYGEN_BASE}/video-agents`;
const SESSION_ID = "native-session-123";
const VIDEO_ID = "native-video-123";
const VIDEO_URL = "https://files.heygen.test/intro.mp4";
const VIDEO_BYTES = Buffer.from("managed native intro video");
const STYLE_ID = "selected-public-style";
const AUTO_STYLE_ID = "auto-resolved-public-style";
const AVATAR_ID = "Daphne_public_look_2";
const AVATAR_GROUP_ID = "daphne-group";
const DEFAULT_VOICE_ID = "daphne-default-voice";
const OVERRIDE_VOICE_ID = "native-non-starfish-voice";
const PRICING_ROWS = [
  {
    kind: "video",
    provider: "heygen-video-agent",
    category: "output_video_seconds",
    unitPrice: 600,
    unitSize: 60,
  },
] as const satisfies readonly UsagePricingRow[];
// A gateway answers with its own page rather than HeyGen's error envelope.
const GATEWAY_ERROR_PAGE = `<html>
  <head><title>502 Bad Gateway</title></head>
  <body>upstream connect error or disconnect/reset before headers</body>
</html>`;

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly token: string;
  readonly pricing: UsagePricingFixture["resolution"];
}

interface ProviderState {
  avatarStatus: string | null;
  publicAvatarAvailable: boolean;
  voiceStatus: string | null;
  publicVoiceAvailable: boolean;
  voiceCatalogType: "public" | "private";
  submitStatus: number;
  sessionStatus: string;
  sessionRequests: number;
  videoId: string | null;
  videoStatus: string;
  videoRequests: number;
  videoContentType: string | null;
  videoDownloads: number;
  beforeDownload?: () => Promise<void>;
  readonly submissions: Record<string, unknown>[];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Expected a response object");
}

function app(fixture: Fixture) {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...introVideoAgentRoutes,
      ...builtInGenerationRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
    ],
    usagePricingResolution: fixture.pricing,
  });
}

function headers(fixture: Fixture) {
  return {
    authorization: `Bearer ${fixture.token}`,
    "content-type": "application/json",
  };
}

function request(
  overrides: Partial<IntroVideoAgentGenerateRequest> = {},
): IntroVideoAgentGenerateRequest {
  return {
    requestId: randomUUID(),
    prompt:
      "Introduce our product to business owners using the supplied facts.",
    styleId: STYLE_ID,
    orientation: "landscape",
    ...overrides,
  };
}

async function fixture(
  options: {
    readonly enabled?: boolean;
    readonly pricing?: readonly UsagePricingRow[];
  } = {},
): Promise<Fixture> {
  const pricing = await createUsagePricingFixture({
    configured: options.pricing ?? PRICING_ROWS,
    missing: [
      {
        kind: "video",
        provider: "heygen-video-agent",
        category: "output_video_seconds",
      },
    ],
  });
  onTestFinished(pricing.cleanup);
  const identity = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  await seedOrgMetadata({ ...identity, tier: "team", credits: 10_000 });
  await store.set(
    seedOrgMembership$,
    { ...identity, role: "admin" },
    context.signal,
  );
  const { composeId } = await store.set(seedCompose$, identity, context.signal);
  const { runId } = await store.set(
    seedRun$,
    { ...identity, composeId, triggerSource: "web" },
    context.signal,
  );
  mocks.clerk.session(identity.userId, identity.orgId);
  await updateFeatureSwitchesForUser(context, identity, {
    [FeatureSwitchKey.IntroVideo]: options.enabled ?? true,
  });
  const seconds = Math.floor(now() / 1000);
  return {
    ...identity,
    runId,
    pricing: pricing.resolution,
    token: signSandboxJwtForTests({
      scope: "okou",
      ...identity,
      runId,
      capabilities: ["file:write"],
      iat: seconds,
      exp: seconds + 2 * 60 * 60,
    }),
  };
}

function mockProvider(): ProviderState {
  const state: ProviderState = {
    avatarStatus: null,
    publicAvatarAvailable: true,
    voiceStatus: null,
    publicVoiceAvailable: true,
    voiceCatalogType: "public",
    submitStatus: 200,
    sessionStatus: "thinking",
    sessionRequests: 0,
    videoId: null,
    videoStatus: "processing",
    videoRequests: 0,
    videoContentType: "video/mp4",
    videoDownloads: 0,
    submissions: [],
  };
  server.use(
    http.get(`${HEYGEN_CREATE_URL}/styles`, () => {
      return HttpResponse.json({
        data: [
          { style_id: STYLE_ID, name: "Business story", aspect_ratio: "16:9" },
          {
            style_id: AUTO_STYLE_ID,
            name: "Clear explainer",
            aspect_ratio: "16:9",
          },
        ],
        has_more: false,
        next_token: null,
      });
    }),
    http.get(`${HEYGEN_BASE}/avatars/looks/:id`, ({ params }) => {
      return params.id === AVATAR_ID
        ? HttpResponse.json({
            data: {
              id: AVATAR_ID,
              group_id: AVATAR_GROUP_ID,
              default_voice_id: DEFAULT_VOICE_ID,
              status: state.avatarStatus,
            },
          })
        : HttpResponse.json(
            { error: { message: "Look not found" } },
            { status: 404 },
          );
    }),
    http.get(`${HEYGEN_BASE}/avatars/looks`, ({ request: providerRequest }) => {
      expect(
        Object.fromEntries(new URL(providerRequest.url).searchParams),
      ).toStrictEqual({
        ownership: "public",
        limit: "50",
        group_id: AVATAR_GROUP_ID,
      });
      return HttpResponse.json({
        data: state.publicAvatarAvailable
          ? [
              {
                id: AVATAR_ID,
                group_id: AVATAR_GROUP_ID,
                status: state.avatarStatus,
                supported_api_engines: ["avatar_iv"],
              },
            ]
          : [],
        has_more: false,
        next_token: null,
      });
    }),
    http.get(
      `${HEYGEN_BASE}/voices/:id`,
      ({ params, request: providerRequest }) => {
        expect(new URL(providerRequest.url).search).toBe("");
        return HttpResponse.json({
          data: {
            voice_id: params.id,
            name: "Native voice",
            status: state.voiceStatus,
            engine: "elevenlabs",
          },
        });
      },
    ),
    http.get(`${HEYGEN_BASE}/voices`, ({ request: providerRequest }) => {
      expect(
        Object.fromEntries(new URL(providerRequest.url).searchParams),
      ).toStrictEqual({
        type: "public",
        limit: "100",
      });
      return HttpResponse.json({
        data: state.publicVoiceAvailable
          ? [DEFAULT_VOICE_ID, OVERRIDE_VOICE_ID].map((voiceId) => {
              return {
                voice_id: voiceId,
                name: "Native voice",
                type: state.voiceCatalogType,
                engine: "elevenlabs",
              };
            })
          : [],
        has_more: false,
        next_token: null,
      });
    }),
    http.post(HEYGEN_CREATE_URL, async ({ request: providerRequest }) => {
      expect(providerRequest.headers.get("x-api-key")).toBe("test-heygen-key");
      expect(providerRequest.headers.get("idempotency-key")).toBeNull();
      state.submissions.push(record(await providerRequest.json()));
      if (state.submitStatus !== 200) {
        return HttpResponse.json(
          { error: { message: "Submission outcome is unknown" } },
          { status: state.submitStatus },
        );
      }
      return HttpResponse.json({
        data: {
          session_id: SESSION_ID,
          status: state.sessionStatus,
          video_id: state.videoId,
        },
      });
    }),
    http.get(`${HEYGEN_CREATE_URL}/${SESSION_ID}`, () => {
      state.sessionRequests += 1;
      return HttpResponse.json({
        data: {
          session_id: SESSION_ID,
          status: state.sessionStatus,
          video_id: state.videoId,
        },
      });
    }),
    http.get(`${HEYGEN_BASE}/videos/${VIDEO_ID}`, () => {
      state.videoRequests += 1;
      return HttpResponse.json({
        data: {
          id: VIDEO_ID,
          status: state.videoStatus,
          ...(state.videoStatus === "completed"
            ? { video_url: VIDEO_URL, duration: 61 }
            : {}),
        },
      });
    }),
    http.get(VIDEO_URL, async () => {
      state.videoDownloads += 1;
      await state.beforeDownload?.();
      return new HttpResponse(VIDEO_BYTES, {
        headers: state.videoContentType
          ? { "content-type": state.videoContentType }
          : {},
      });
    }),
    http.get(/^https:\/\/artifacts\.okou\.test\/cdn-cgi\/media\//u, () => {
      return new HttpResponse(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg" },
      });
    }),
  );
  return state;
}

function submit(f: Fixture, body: IntroVideoAgentGenerateRequest) {
  return app(f).request("/api/intro-video/agent/generate", {
    method: "POST",
    headers: headers(f),
    body: JSON.stringify(body),
  });
}

async function status(f: Fixture, generationId: string) {
  const response = await app(f).request(
    `/api/intro-video/agent/${generationId}`,
    {
      headers: headers(f),
    },
  );
  expect(response.status).toBe(200);
  return introVideoAgentResponseSchema.parse(await response.json());
}

async function credits(f: Fixture): Promise<number> {
  mocks.clerk.session(f.userId, f.orgId);
  const response = await app(f).request("/api/billing/status", {
    headers: { authorization: "Bearer clerk-session" },
  });
  expect(response.status).toBe(200);
  const body = record(await response.json());
  if (typeof body.credits !== "number") {
    throw new Error("Expected a numeric credit balance");
  }
  return body.credits;
}

describe("Managed Intro Video Agent", () => {
  beforeEach(() => {
    mockEnv("OKOU_PUBLIC_ARTIFACTS_BASE_URL", "https://artifacts.okou.test");
    mockEnv("HEYGEN_API_KEY", "test-heygen-key");
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
      return Promise.resolve(apiTestS3PresignedUrl(command));
    });
    context.mocks.ably.createTokenRequest.mockResolvedValue({
      keyName: "test-key",
      timestamp: 1_700_000_000_000,
      capability: '{"user:test-user":["subscribe"]}',
      clientId: "test-user",
      nonce: "test-nonce",
      mac: "test-mac",
    });
  });

  it("requires the rollout and a concrete live style before native submission", async () => {
    const f = await fixture({ enabled: false });
    const provider = mockProvider();
    expect((await submit(f, request())).status).toBe(403);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.IntroVideo]: true,
    });
    const missingStyle = await app(f).request(
      "/api/intro-video/agent/generate",
      {
        method: "POST",
        headers: headers(f),
        body: JSON.stringify({
          requestId: randomUUID(),
          prompt: "Make an intro video.",
          orientation: "landscape",
        }),
      },
    );
    expect(missingStyle.status).toBe(400);
    expect(
      (await submit(f, request({ styleId: "unavailable-style" }))).status,
    ).toBe(400);
    expect(provider.submissions).toHaveLength(0);
  });

  it.each([
    {
      choice: "selected",
      styleId: STYLE_ID,
      voiceId: undefined,
      expectedVoice: DEFAULT_VOICE_ID,
      avatarStatus: "completed",
      voiceStatus: "complete",
    },
    {
      choice: "Auto resolved",
      styleId: AUTO_STYLE_ID,
      voiceId: OVERRIDE_VOICE_ID,
      expectedVoice: OVERRIDE_VOICE_ID,
      avatarStatus: null,
      voiceStatus: null,
    },
  ])(
    "passes the $choice style, look, voice and output ratio to Video Agent",
    async ({ styleId, voiceId, expectedVoice, avatarStatus, voiceStatus }) => {
      const f = await fixture();
      const provider = mockProvider();
      provider.avatarStatus = avatarStatus;
      provider.voiceStatus = voiceStatus;
      const key =
        styleId === AUTO_STYLE_ID
          ? buildArtifactKeyV2(randomUUID(), "brief.pdf")
          : buildArtifactKey(f.userId, randomUUID(), "brief.pdf");
      const fileUrl = buildFileUrlFromKey(key, "okou");
      context.mocks.s3.send.mockImplementation((command) => {
        return Promise.resolve(
          command instanceof HeadObjectCommand
            ? {
                ContentType: "application/pdf",
                ContentLength: 128,
                Metadata: { "user-id": encodeURIComponent(f.userId) },
              }
            : {},
        );
      });
      const body = request({
        styleId,
        avatarId: AVATAR_ID,
        avatarGroupId: AVATAR_GROUP_ID,
        ...(voiceId ? { voiceId } : {}),
        orientation: "portrait",
        fileUrls: [fileUrl],
      });
      const response = await submit(f, body);
      expect(response.status).toBe(202);
      expect(
        introVideoAgentResponseSchema.parse(await response.json()),
      ).toMatchObject({
        generationId: body.requestId,
        status: "running",
        sessionId: SESSION_ID,
        videoId: null,
        styleId,
        avatarId: AVATAR_ID,
        voiceId: expectedVoice,
        orientation: "portrait",
      });
      expect(provider.submissions).toStrictEqual([
        {
          prompt: body.prompt,
          mode: "generate",
          incognito_mode: true,
          style_id: styleId,
          avatar_id: AVATAR_ID,
          voice_id: expectedVoice,
          orientation: "portrait",
          files: [
            {
              type: "url",
              url: expect.stringMatching(/^https:\/\/r2\.example\.com\//u),
            },
          ],
          callback_id: body.requestId,
          callback_url: expect.stringContaining(
            `/api/webhooks/built-in-generations/heygen/${body.requestId}?token=`,
          ),
        },
      ]);
    },
  );

  it("signs owned private references for Video Agent after rollback and rejects another owner's files", async () => {
    const f = await fixture();
    const provider = mockProvider();
    context.mocks.s3.send.mockImplementation((command) => {
      if (command instanceof HeadObjectCommand) {
        expect(command.input.Bucket).toBe("test-private-artifacts");
        return Promise.resolve({
          ContentType: "application/pdf",
          ContentLength: 128,
        });
      }
      return Promise.resolve({});
    });
    installArtifactReferenceStorage(context);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.PrivateArtifacts]: true,
    });
    const prepared = await accept(
      setupApp({ context, routes: uploadsPrepareRoutes })(
        uploadsContract,
      ).prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          filename: "brief.pdf",
          contentType: "application/pdf",
          size: 128,
          purpose: "artifact",
        },
      }),
      [200],
    );
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.PrivateArtifacts]: false,
    });
    const input = request({ fileUrls: [prepared.body.url] });
    expect((await submit(f, input)).status).toBe(202);
    expect(provider.submissions).toHaveLength(1);
    expect(JSON.stringify(provider.submissions[0])).not.toContain(
      prepared.body.url,
    );
    expect(context.mocks.s3.getSignedUrl.mock.calls.at(-1)).toMatchObject({
      1: {
        input: {
          Bucket: "test-private-artifacts",
          Key: `private-artifacts/${prepared.body.id}/brief.pdf`,
        },
      },
      2: { expiresIn: 172_800 },
    });
    const other = await fixture();
    const before = provider.submissions.length;
    expect(
      (await submit(other, request({ fileUrls: [prepared.body.url] }))).status,
    ).toBe(400);
    expect(provider.submissions).toHaveLength(before);
  });

  it("leaves unspecified avatar and voice to Video Agent without inventing disable switches", async () => {
    const f = await fixture();
    const provider = mockProvider();
    const body = request();
    expect((await submit(f, body)).status).toBe(202);
    expect(provider.submissions[0]).toMatchObject({
      mode: "generate",
      style_id: STYLE_ID,
      orientation: "landscape",
    });
    expect(provider.submissions[0]).not.toHaveProperty("avatar_id");
    expect(provider.submissions[0]).not.toHaveProperty("voice_id");
    expect(provider.submissions[0]).not.toHaveProperty("disable_avatar");
    expect(provider.submissions[0]).not.toHaveProperty("disable_voice");
    expect(provider.submissions[0]).not.toHaveProperty("audio_url");
  });

  it("rejects invalid references and private or unavailable avatar and voice selections before billing", async () => {
    const f = await fixture();
    const provider = mockProvider();
    const foreignUrl = buildFileUrlFromKey(
      buildArtifactKey("another-user", randomUUID(), "brief.pdf"),
      "okou",
    );
    expect((await submit(f, request({ fileUrls: [foreignUrl] }))).status).toBe(
      400,
    );
    const foreignV2Url = buildFileUrlFromKey(
      buildArtifactKeyV2(randomUUID(), "brief.pdf"),
      "okou",
    );
    context.mocks.s3.send.mockImplementation((command) => {
      return Promise.resolve(
        command instanceof HeadObjectCommand
          ? {
              ContentType: "application/pdf",
              ContentLength: 128,
              Metadata: { "user-id": "another-user" },
            }
          : {},
      );
    });
    expect(
      (await submit(f, request({ fileUrls: [foreignV2Url] }))).status,
    ).toBe(400);
    const ownedUrl = buildFileUrlFromKey(
      buildArtifactKey(f.userId, randomUUID(), "disguised.pdf"),
      "okou",
    );
    context.mocks.s3.send.mockImplementation((command) => {
      return Promise.resolve(
        command instanceof HeadObjectCommand
          ? {
              ContentType:
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              ContentLength: 128,
            }
          : {},
      );
    });
    expect((await submit(f, request({ fileUrls: [ownedUrl] }))).status).toBe(
      400,
    );
    context.mocks.s3.send.mockImplementation((command) => {
      return Promise.resolve(
        command instanceof HeadObjectCommand
          ? { ContentType: "application/pdf", ContentLength: 32_000_001 }
          : {},
      );
    });
    expect((await submit(f, request({ fileUrls: [ownedUrl] }))).status).toBe(
      400,
    );
    expect(
      (await submit(f, request({ avatarId: AVATAR_GROUP_ID }))).status,
    ).toBe(400);
    provider.avatarStatus = "processing";
    expect((await submit(f, request({ avatarId: AVATAR_ID }))).status).toBe(
      400,
    );
    provider.avatarStatus = "completed";
    provider.publicAvatarAvailable = false;
    expect((await submit(f, request({ avatarId: AVATAR_ID }))).status).toBe(
      400,
    );
    provider.voiceStatus = "processing";
    expect(
      (await submit(f, request({ voiceId: OVERRIDE_VOICE_ID }))).status,
    ).toBe(400);
    provider.voiceStatus = "complete";
    provider.publicVoiceAvailable = false;
    expect(
      (await submit(f, request({ voiceId: OVERRIDE_VOICE_ID }))).status,
    ).toBe(400);
    provider.publicVoiceAvailable = true;
    provider.voiceCatalogType = "private";
    expect(
      (await submit(f, request({ voiceId: OVERRIDE_VOICE_ID }))).status,
    ).toBe(400);
    expect(provider.submissions).toHaveLength(0);
  });

  it("retains an unknown submission and never repeats the paid POST when resumed", async () => {
    const f = await fixture();
    const provider = mockProvider();
    provider.submitStatus = 503;
    const body = request();
    const first = await submit(f, body);
    expect(first.status).toBe(202);
    expect(
      introVideoAgentResponseSchema.parse(await first.json()),
    ).toMatchObject({
      generationId: body.requestId,
      status: "running",
      sessionId: null,
      videoId: null,
      providerStatus: "submission_unknown",
      notice: expect.stringContaining("do not submit another paid generation"),
    });
    const retried = await submit(f, body);
    expect([200, 202]).toContain(retried.status);
    await expect(status(f, body.requestId)).resolves.toMatchObject({
      generationId: body.requestId,
      providerStatus: "submission_unknown",
      sessionId: null,
    });
    expect(provider.submissions).toHaveLength(1);
    await expect(credits(f)).resolves.toBe(10_000);
    provider.sessionStatus = "completed";
    provider.videoId = VIDEO_ID;
    provider.videoStatus = "completed";
    const callback = provider.submissions[0]?.callback_url;
    if (typeof callback !== "string") {
      throw new Error("Expected a provider callback URL");
    }
    const callbackUrl = new URL(callback);
    const recovered = await app(f).request(
      `${callbackUrl.pathname}${callbackUrl.search}`,
      {
        method: "POST",
        body: JSON.stringify({
          event_type: "video_agent.success",
          callback_id: body.requestId,
          event_data: { session_id: SESSION_ID, video_id: VIDEO_ID },
        }),
      },
    );
    expect(recovered.status).toBe(200);
    await expect(status(f, body.requestId)).resolves.toMatchObject({
      status: "completed",
      sessionId: SESSION_ID,
      videoId: VIDEO_ID,
      contentType: "video/mp4",
    });
    expect(provider.sessionRequests).toBe(0);
    expect(provider.videoRequests).toBe(1);
    expect(provider.submissions).toHaveLength(1);
    await expect(credits(f)).resolves.toBe(9390);
  });

  it("retains an unknown submission when the gateway answers with an error page", async () => {
    const f = await fixture();
    const provider = mockProvider();
    // A gateway 5xx carries no JSON error envelope, unlike every other failure
    // this suite exercises, so it reaches the provider reader as plain text.
    server.use(
      http.post(HEYGEN_CREATE_URL, async ({ request: providerRequest }) => {
        provider.submissions.push(record(await providerRequest.json()));
        return new HttpResponse(GATEWAY_ERROR_PAGE, {
          status: 502,
          headers: { "content-type": "text/html" },
        });
      }),
    );

    const body = request();
    expect((await submit(f, body)).status).toBe(202);
    await expect(status(f, body.requestId)).resolves.toMatchObject({
      generationId: body.requestId,
      status: "running",
      providerStatus: "submission_unknown",
      sessionId: null,
      videoId: null,
      notice: expect.stringContaining("do not submit another paid generation"),
    });

    // An ambiguous gateway failure must not license a second paid submission.
    const retried = await submit(f, body);
    expect([200, 202]).toContain(retried.status);
    expect(provider.submissions).toHaveLength(1);
    await expect(credits(f)).resolves.toBe(10_000);
  });

  it("rejects conflicting request IDs and hides another user's generation", async () => {
    const f = await fixture();
    const provider = mockProvider();
    const body = request();
    expect((await submit(f, body)).status).toBe(202);
    expect(
      (await submit(f, { ...body, prompt: "A different billed request." }))
        .status,
    ).toBe(409);
    const other = await fixture();
    const inaccessible = await app(other).request(
      `/api/intro-video/agent/${body.requestId}`,
      {
        headers: headers(other),
      },
    );
    expect(inaccessible.status).toBe(404);
    expect((await submit(other, body)).status).toBe(404);
    expect(provider.submissions).toHaveLength(1);
  });

  it.each(["submission", "session"])(
    "polls only the recorded video after its ID arrives from the %s",
    async (identitySource) => {
      const f = await fixture();
      const provider = mockProvider();
      provider.videoId = identitySource === "submission" ? VIDEO_ID : null;
      const body = request();
      expect((await submit(f, body)).status).toBe(202);
      if (identitySource === "session") {
        await expect(status(f, body.requestId)).resolves.toMatchObject({
          status: "running",
          videoId: null,
        });
        expect(provider.sessionRequests).toBe(1);
        expect(provider.videoRequests).toBe(0);
        provider.sessionStatus = "generating";
        provider.videoId = VIDEO_ID;
      }

      await expect(status(f, body.requestId)).resolves.toMatchObject({
        status: "running",
        sessionId: SESSION_ID,
        videoId: VIDEO_ID,
      });
      expect(provider.sessionRequests).toBe(
        identitySource === "session" ? 2 : 0,
      );
      expect(provider.videoRequests).toBe(1);
      provider.sessionStatus = "failed";
      provider.videoId = "different-video";
      await expect(status(f, body.requestId)).resolves.toMatchObject({
        status: "running",
        videoId: VIDEO_ID,
      });
      await expect(credits(f)).resolves.toBe(10_000);

      provider.videoStatus = "completed";
      const completed = await status(f, body.requestId);
      expect(completed).toMatchObject({
        generationId: body.requestId,
        status: "completed",
        sessionId: SESSION_ID,
        videoId: VIDEO_ID,
        providerStatus: "completed",
        contentType: "video/mp4",
        durationSeconds: 61,
        creditsCharged: 610,
      });
      expect(completed.url).toBeDefined();
      expect(completed.url).not.toBe(VIDEO_URL);
      await expect(status(f, body.requestId)).resolves.toStrictEqual(completed);
      expect(provider.sessionRequests).toBe(
        identitySource === "session" ? 2 : 0,
      );
      expect(provider.videoRequests).toBe(3);
      expect(provider.submissions).toHaveLength(1);
      expect(provider.videoDownloads).toBe(1);
      await expect(credits(f)).resolves.toBe(9390);
    },
  );

  it("reports a recorded video's render failure without querying its session", async () => {
    const f = await fixture();
    const provider = mockProvider();
    provider.videoId = VIDEO_ID;
    const body = request();
    expect((await submit(f, body)).status).toBe(202);
    provider.videoStatus = "failed";

    await expect(status(f, body.requestId)).resolves.toMatchObject({
      status: "failed",
      sessionId: SESSION_ID,
      videoId: VIDEO_ID,
      providerStatus: "failed",
      error: { code: "HEYGEN_GENERATION_FAILED" },
    });
    expect(provider.sessionRequests).toBe(0);
    expect(provider.videoRequests).toBe(1);
    expect(provider.submissions).toHaveLength(1);
    await expect(credits(f)).resolves.toBe(10_000);
  });

  it.each(["missing", "network error"])(
    "resumes a session with a %s response until a video ID is available",
    async (sessionFailure) => {
      const f = await fixture();
      const provider = mockProvider();
      const body = request();
      expect((await submit(f, body)).status).toBe(202);
      server.use(
        http.get(
          `${HEYGEN_CREATE_URL}/${SESSION_ID}`,
          () => {
            provider.sessionRequests += 1;
            return sessionFailure === "missing"
              ? HttpResponse.json(
                  { error: { message: "Session not found" } },
                  { status: 404 },
                )
              : HttpResponse.error();
          },
          { once: true },
        ),
      );

      await expect(status(f, body.requestId)).resolves.toMatchObject({
        status: "running",
        sessionId: SESSION_ID,
        videoId: null,
        notice: expect.stringContaining("Resume this generation"),
      });
      expect(provider.sessionRequests).toBe(1);
      expect(provider.videoRequests).toBe(0);
      await expect(credits(f)).resolves.toBe(10_000);

      provider.sessionStatus = "completed";
      provider.videoId = VIDEO_ID;
      provider.videoStatus = "completed";
      await expect(status(f, body.requestId)).resolves.toMatchObject({
        status: "completed",
        videoId: VIDEO_ID,
        creditsCharged: 610,
      });
      expect(provider.sessionRequests).toBe(2);
      expect(provider.videoRequests).toBe(1);
      expect(provider.submissions).toHaveLength(1);
      await expect(credits(f)).resolves.toBe(9390);
    },
  );

  it.each([
    {
      name: "conflicting session",
      data: { session_id: "another-session", video_id: VIDEO_ID },
      notice: "different Video Agent session",
    },
    {
      name: "malformed session",
      data: { video_id: VIDEO_ID },
      notice: "invalid Video Agent session",
    },
  ])(
    "resumes video discovery after rejecting a $name response",
    async ({ data, notice }) => {
      const f = await fixture();
      const provider = mockProvider();
      const body = request();
      expect((await submit(f, body)).status).toBe(202);
      provider.sessionStatus = "completed";
      provider.videoId = VIDEO_ID;
      provider.videoStatus = "completed";
      server.use(
        http.get(
          `${HEYGEN_CREATE_URL}/${SESSION_ID}`,
          () => {
            return HttpResponse.json({
              data: { ...data, status: "completed" },
            });
          },
          { once: true },
        ),
      );

      await expect(status(f, body.requestId)).resolves.toMatchObject({
        status: "running",
        sessionId: SESSION_ID,
        videoId: null,
        notice: expect.stringContaining(notice),
      });
      expect(provider.videoRequests).toBe(0);
      expect(provider.videoDownloads).toBe(0);
      await expect(credits(f)).resolves.toBe(10_000);

      const completed = await status(f, body.requestId);
      expect(completed).toMatchObject({
        status: "completed",
        sessionId: SESSION_ID,
        videoId: VIDEO_ID,
        contentType: "video/mp4",
        size: VIDEO_BYTES.byteLength,
        creditsCharged: 610,
      });
      expect(completed.url).toBeDefined();
      expect(completed.url).not.toBe(VIDEO_URL);
      await expect(status(f, body.requestId)).resolves.toStrictEqual(completed);
      expect(provider.submissions).toHaveLength(1);
      expect(provider.videoRequests).toBe(1);
      expect(provider.videoDownloads).toBe(1);
      await expect(credits(f)).resolves.toBe(9390);
    },
  );

  it("keeps a conflicting video response blocked until its identity matches", async () => {
    const f = await fixture();
    const provider = mockProvider();
    provider.videoId = VIDEO_ID;
    const body = request();
    expect((await submit(f, body)).status).toBe(202);
    provider.videoStatus = "completed";
    server.use(
      http.get(
        `${HEYGEN_BASE}/videos/${VIDEO_ID}`,
        () => {
          return HttpResponse.json({
            data: {
              id: "different-video",
              status: "completed",
              video_url: VIDEO_URL,
              duration: 61,
            },
          });
        },
        { once: true },
      ),
    );

    await expect(status(f, body.requestId)).resolves.toMatchObject({
      status: "running",
      sessionId: SESSION_ID,
      videoId: VIDEO_ID,
      notice: expect.stringContaining("invalid video response"),
    });
    await expect(credits(f)).resolves.toBe(10_000);

    await expect(status(f, body.requestId)).resolves.toMatchObject({
      status: "completed",
      videoId: VIDEO_ID,
      creditsCharged: 610,
    });
    expect(provider.sessionRequests).toBe(0);
    expect(provider.submissions).toHaveLength(1);
    await expect(credits(f)).resolves.toBe(9390);
  });

  it.each([false, true])(
    "keeps a slow session resumable and converges callback/status completion with one MP4 and charge (private=%s)",
    async (privateArtifacts) => {
      const f = await fixture();
      await updateFeatureSwitchesForUser(context, f, {
        [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
      });
      const provider = mockProvider();
      const body = request();
      const submittedAt = now();
      expect((await submit(f, body)).status).toBe(202);
      await updateFeatureSwitchesForUser(context, f, {
        [FeatureSwitchKey.PrivateArtifacts]: !privateArtifacts,
      });
      await withMockNowForTest(submittedAt + 45 * 60 * 1000, async () => {
        const generic = await app(f).request(
          `/api/built-in-generations/${body.requestId}`,
          {
            headers: { authorization: "Bearer clerk-session" },
          },
        );
        expect(generic.status).toBe(200);
        expect(record(await generic.json()).status).toBe("running");
        await expect(status(f, body.requestId)).resolves.toMatchObject({
          status: "running",
          sessionId: SESSION_ID,
          videoId: null,
        });
      });
      provider.sessionStatus = "generating";
      provider.videoId = VIDEO_ID;
      await expect(status(f, body.requestId)).resolves.toMatchObject({
        status: "running",
        sessionId: SESSION_ID,
        videoId: VIDEO_ID,
      });
      provider.sessionStatus = "completed";
      provider.videoStatus = "completed";
      const downloadStarted = createDeferredPromise<void>(context.signal);
      const releaseDownload = createDeferredPromise<void>(context.signal);
      provider.beforeDownload = async () => {
        downloadStarted.resolve(undefined);
        await releaseDownload.promise;
      };
      const callback = provider.submissions[0]?.callback_url;
      if (typeof callback !== "string") {
        throw new Error("Expected a provider callback URL");
      }
      const callbackUrl = new URL(callback);
      const callbackPath = `${callbackUrl.pathname}${callbackUrl.search}`;
      const [completion] = await Promise.all([
        app(f).request(callbackPath, {
          method: "POST",
          body: "{}",
        }),
        (async () => {
          await downloadStarted.promise;
          await expect(status(f, body.requestId)).resolves.toMatchObject({
            status: "running",
          });
          releaseDownload.resolve(undefined);
        })(),
      ]);
      expect(completion.status).toBe(200);
      await flushWaitUntilForTest();
      const completed = await status(f, body.requestId);
      expect(completed).toMatchObject({
        status: "completed",
        sessionId: SESSION_ID,
        videoId: VIDEO_ID,
        filename: expect.stringMatching(/^intro-video-.*\.mp4$/u),
        privateArtifacts,
        contentType: "video/mp4",
        size: VIDEO_BYTES.byteLength,
        durationSeconds: 61,
        creditsCharged: 610,
      });
      expect(completed.url).toBeDefined();
      if (privateArtifacts) {
        expect(completed.url).toMatch(/^\/artifacts\/[a-z0-9]{10}\.mp4$/u);
      }
      expect(completed.url).not.toBe(VIDEO_URL);
      expect(
        (await app(f).request(callbackPath, { method: "POST", body: "{}" }))
          .status,
      ).toBe(200);
      await expect(status(f, body.requestId)).resolves.toStrictEqual(completed);
      expect(provider.submissions).toHaveLength(1);
      expect(provider.videoDownloads).toBe(1);
      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          return (
            command instanceof PutObjectCommand &&
            command.input.ContentType === "video/mp4"
          );
        }),
      ).toHaveLength(1);
      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          return (
            command instanceof PutObjectCommand &&
            command.input.ContentType === "image/jpeg"
          );
        }),
      ).toHaveLength(privateArtifacts ? 0 : 1);
      await expect(credits(f)).resolves.toBe(9390);
    },
  );

  it.each([false, true])(
    "resumes invalid downloads and failed uploads with the same file identity and one charge (private=%s)",
    async (privateArtifacts) => {
      const f = await fixture();
      await updateFeatureSwitchesForUser(context, f, {
        [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
      });
      const provider = mockProvider();
      const body = request();
      expect((await submit(f, body)).status).toBe(202);
      await updateFeatureSwitchesForUser(context, f, {
        [FeatureSwitchKey.PrivateArtifacts]: !privateArtifacts,
      });
      provider.sessionStatus = "completed";
      provider.videoId = VIDEO_ID;
      provider.videoStatus = "completed";
      const uploadedKeys: string[] = [];
      let firstUpload = true;
      context.mocks.s3.send.mockImplementation((command) => {
        if (
          command instanceof PutObjectCommand &&
          command.input.ContentType === "video/mp4"
        ) {
          if (typeof command.input.Key !== "string") {
            return Promise.reject(new Error("Expected an artifact object key"));
          }
          uploadedKeys.push(command.input.Key);
          if (firstUpload) {
            firstUpload = false;
            return Promise.reject(
              new Error("Temporary artifact upload failure"),
            );
          }
        }
        return Promise.resolve({});
      });
      for (const contentType of [null, "video/webm"]) {
        provider.videoContentType = contentType;
        const rejectedDownload = await app(f).request(
          `/api/intro-video/agent/${body.requestId}`,
          { headers: headers(f) },
        );
        expect(rejectedDownload.status).toBe(500);
        expect(uploadedKeys).toHaveLength(0);
        await expect(credits(f)).resolves.toBe(10_000);
      }
      provider.videoContentType = "video/mp4";
      const failedUpload = await app(f).request(
        `/api/intro-video/agent/${body.requestId}`,
        { headers: headers(f) },
      );
      expect(failedUpload.status).toBe(500);
      await expect(credits(f)).resolves.toBe(10_000);
      await expect(status(f, body.requestId)).resolves.toMatchObject({
        generationId: body.requestId,
        status: "completed",
        privateArtifacts,
        contentType: "video/mp4",
        creditsCharged: 610,
      });
      expect(uploadedKeys).toHaveLength(2);
      expect(uploadedKeys[1]).toBe(uploadedKeys[0]);
      if (privateArtifacts) {
        expect(uploadedKeys[0]).toMatch(/^private-artifacts\//u);
      }
      expect(provider.submissions).toHaveLength(1);
      await expect(credits(f)).resolves.toBe(9390);
    },
  );

  it.each([
    {
      providerStatus: "waiting_for_input",
      expectedStatus: "running",
      notice: "requires input",
    },
    {
      providerStatus: "unexpected_future_state",
      expectedStatus: "running",
      notice: "Unexpected HeyGen session state",
    },
    { providerStatus: "failed", expectedStatus: "failed", notice: undefined },
  ])(
    "reports $providerStatus without submitting a replacement video",
    async ({ providerStatus, expectedStatus, notice }) => {
      const f = await fixture();
      const provider = mockProvider();
      const body = request();
      expect((await submit(f, body)).status).toBe(202);
      provider.sessionStatus = providerStatus;
      const result = await status(f, body.requestId);
      expect(result.status).toBe(expectedStatus);
      if (notice) {
        expect(result.notice).toContain(notice);
      } else {
        expect(result.error?.code).toBe("HEYGEN_GENERATION_FAILED");
      }
      expect(provider.submissions).toHaveLength(1);
      await expect(credits(f)).resolves.toBe(10_000);
    },
  );

  it("requires Video Agent pricing instead of using Avatar III pricing", async () => {
    const f = await fixture({
      pricing: [
        {
          kind: "video",
          provider: "heygen-avatar-iii",
          category: "output_video_seconds",
          unitPrice: 1250,
          unitSize: 60,
        },
      ],
    });
    const provider = mockProvider();
    const response = await submit(f, request());
    expect(response.status).toBe(503);
    expect(provider.submissions).toHaveLength(0);
  });

  it("keeps generation available to a credit-admitted run after its balance is exhausted", async () => {
    const f = await fixture();
    const provider = mockProvider();
    await seedBuiltInDefaultModelKey(context);
    const bdd = createBddApi(context);
    const actor = bdd.user({ userId: f.userId, orgId: f.orgId });
    const api = createRunsApi(context);
    bdd.acceptAgentStorageWrites();
    api.configureRunnerGroup();
    expect((await bdd.completeOnboarding(actor)).status).toBe(200);
    const agent = await bdd.createAgent(actor, {
      displayName: "Intro Video credit admission",
      visibility: "private",
    });
    const admitted = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "Create an intro video using the managed provider.",
      modelProvider: "built-in",
    });
    const seconds = Math.floor(now() / 1000);
    const admittedFixture: Fixture = {
      ...f,
      runId: admitted.runId,
      token: signSandboxJwtForTests({
        scope: "okou",
        orgId: f.orgId,
        userId: f.userId,
        runId: admitted.runId,
        capabilities: ["file:write"],
        iat: seconds,
        exp: seconds + 60,
      }),
    };
    await seedOrgMetadata({ orgId: f.orgId, tier: "team", credits: 0 });
    expect((await submit(f, request())).status).toBe(402);
    expect((await submit(admittedFixture, request())).status).toBe(202);
    expect(provider.submissions).toHaveLength(1);
    await api.requestCancelRun(actor, admitted.runId, [200]);
  });
});
