import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import type { OrgTier } from "@okouai/api-contracts/contracts/orgs";

import { createAppWithRoutes } from "../../../app-factory-core";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";
import { billingStatusRoutes } from "../billing-status";
import { voiceIoSttRoutes } from "../voice-io-stt";
import { voiceIoQuotaRoutes } from "../voice-io-quota";
import { seedUserBehaviorCount } from "../../../test-fixtures/user-behavior-count";
import {
  seedOrgMetadata,
  type UsagePricingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { seedOrgMembership$ } from "./helpers/org-membership";

import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";
const AUDIO_INPUT_FREE_QUOTA = 10;
const FREE_DAILY_RATE_LIMIT = 10;
const FREE_DAILY_DURATION_LIMIT_SECONDS = 10 * 60;
const PRO_DAILY_RATE_LIMIT = 300;
const PRO_DAILY_DURATION_LIMIT_SECONDS = 200 * 60;
const BYTEPLUS_ASR_FLASH_URL =
  "https://byteplus-proxy.vm0.ai/api/v3/auc/bigmodel/recognize/flash";
const DAILY_RATE_KEY_PREFIX = "audio_input_daily";
const DAILY_DURATION_KEY_PREFIX = "audio_input_dur";

interface VoiceFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createVoiceIoTestApp(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...voiceIoQuotaRoutes,
      ...voiceIoSttRoutes,
      ...billingStatusRoutes,
    ],
    usagePricingResolution,
  });
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function currentDate(): Date {
  return new Date(now());
}

function sttDailyRateKey(date: Date = currentDate()): string {
  return `${DAILY_RATE_KEY_PREFIX}_${date.toISOString().slice(0, 10)}`;
}

function sttDailyDurationKey(date: Date = currentDate()): string {
  return `${DAILY_DURATION_KEY_PREFIX}_${date.toISOString().slice(0, 10)}`;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    bytes[offset + i] = value.charCodeAt(i);
  }
}

function wavBytes(durationSeconds: number): Uint8Array<ArrayBuffer> {
  const sampleRate = 24_000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize =
    sampleRate * channels * (bitsPerSample / 8) * durationSeconds;
  const buffer = new ArrayBuffer(44 + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);

  return bytes;
}

function wavBytesWithOversizedDataChunk(
  durationSeconds: number,
): Uint8Array<ArrayBuffer> {
  const sampleRate = 24_000;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = channels * (bitsPerSample / 8);
  const dataSize = sampleRate * bytesPerSample * durationSeconds;
  const junkSize = 4;
  const dataOffset = 56;
  const buffer = new ArrayBuffer(dataOffset + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const byteRate = sampleRate * bytesPerSample;

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(bytes, 36, "JUNK");
  view.setUint32(40, junkSize, true);
  writeAscii(bytes, 48, "data");
  view.setUint32(52, dataSize + 10_000, true);

  return bytes;
}

// Canonical header with a correctly-sized data chunk, followed by a trailing
// LIST chunk. Duration must come from the declared data size, not the whole
// remaining buffer (which would count the trailing chunk as audio).
function wavBytesWithTrailingChunk(
  durationSeconds: number,
): Uint8Array<ArrayBuffer> {
  const sampleRate = 24_000;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * bytesPerSample;
  const dataSize = byteRate * durationSeconds;
  const trailingSize = byteRate * 3; // 3s of bytes; over-count would add ~3s
  const buffer = new ArrayBuffer(44 + dataSize + 8 + trailingSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  writeAscii(bytes, 44 + dataSize, "LIST");
  view.setUint32(44 + dataSize + 4, trailingSize, true);

  return bytes;
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
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

// Isolation comes from random org/user IDs; no teardown is needed.
async function seedVoiceFixture(options: {
  readonly credits?: number;
  readonly tier?: OrgTier;
}): Promise<VoiceFixture> {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };

  await seedOrgMetadata({
    orgId: fixture.orgId,
    tier: options.tier ?? "free",
    credits: options.credits ?? 10_000,
  });
  await store.set(
    seedOrgMembership$,
    { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
    context.signal,
  );

  return fixture;
}

function sttFile(
  body: Uint8Array = wavBytes(1),
  type = "audio/wav",
  name = "speech.wav",
): File {
  return new File([body], name, { type });
}

function sttForm(file?: File): FormData {
  const form = new FormData();
  if (file) {
    form.append("file", file);
  }
  return form;
}

// Reads the audio input quota through the product quota surface. For free
// orgs this reports the lifetime `audio_input` count while under the daily
// limits, and the blocking counter with its limit once a daily limit is hit —
// the same signals the product exposes to clients.
async function readAudioQuota(fixture: VoiceFixture): Promise<unknown> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const app = createVoiceIoTestApp();
  const response = await app.request("/api/voice-io/quota", {
    method: "GET",
    headers: authHeaders(),
  });
  expect(response.status).toBe(200);
  return await response.json();
}

async function seedBehaviorCount(
  fixture: VoiceFixture,
  behaviorKey: string,
  count: number,
): Promise<void> {
  await seedUserBehaviorCount({
    orgId: fixture.orgId,
    userId: fixture.userId,
    behaviorKey,
    count,
  });
}

function bytePlusSttResponse(text: string, utterances?: readonly unknown[]) {
  return HttpResponse.json(
    {
      result: {
        text,
        ...(utterances !== undefined && { utterances }),
      },
    },
    { headers: { "x-api-status-code": "20000000" } },
  );
}

function mockBytePlusStt(text: string): void {
  server.use(
    http.post(BYTEPLUS_ASR_FLASH_URL, () => {
      return bytePlusSttResponse(text);
    }),
  );
}

describe("POST /api/voice-io/*", () => {
  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  it("returns 401 from /stt when unauthenticated", async () => {
    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      body: sttForm(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("reports daily request exhaustion from /quota", async () => {
    const fixture = await seedVoiceFixture({ tier: "pro" });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedBehaviorCount(fixture, sttDailyRateKey(), PRO_DAILY_RATE_LIMIT);

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/quota", {
      method: "GET",
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      allowed: false,
      count: PRO_DAILY_RATE_LIMIT,
      limit: PRO_DAILY_RATE_LIMIT,
    });
  });

  it("rejects /stt requests without a multipart file before BytePlus", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        calledBytePlus = true;
        return bytePlusSttResponse("should not run");
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "No audio file provided", code: "BAD_REQUEST" },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it("rejects unsupported /stt MIME types before BytePlus", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        calledBytePlus = true;
        return bytePlusSttResponse("should not run");
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(
        sttFile(new Uint8Array([1, 2, 3]), "text/plain", "notes.txt"),
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "Unsupported audio format: text/plain. Supported: webm, wav, mp3, m4a, mp4, mpeg, mpga",
        code: "BAD_REQUEST",
      },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it("rejects /stt files larger than 25 MB before BytePlus", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        calledBytePlus = true;
        return bytePlusSttResponse("should not run");
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(
        sttFile(
          new Uint8Array(25 * 1024 * 1024 + 1),
          "audio/webm",
          "large.webm",
        ),
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "File too large (max 25 MB)", code: "BAD_REQUEST" },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it("accepts /stt MIME types with codec suffixes", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedBody: Record<string, unknown> | null = null;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, async ({ request }) => {
        observedBody = (await request.json()) as Record<string, unknown>;
        return bytePlusSttResponse("hello from codec test");
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(
        sttFile(
          new Uint8Array([1, 2, 3]),
          "audio/webm;codecs=opus",
          "recording.webm",
        ),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      text: "hello from codec test",
    });
    expect(observedBody).toMatchObject({
      audio: {
        format: "webm",
        codec: "opus",
      },
    });
  });

  it("transcribes /stt multipart audio through BytePlus and records quota counters", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const audioBytes = wavBytes(2);
    let observedApiKey: string | null = null;
    let observedResourceId: string | null = null;
    let observedSequence: string | null = null;
    let observedRequestId: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, async ({ request }) => {
        observedApiKey = request.headers.get("x-api-key");
        observedResourceId = request.headers.get("x-api-resource-id");
        observedSequence = request.headers.get("x-api-sequence");
        observedRequestId = request.headers.get("x-api-request-id");
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            result: {
              text: "hello from byteplus",
              utterances: [
                {
                  start_time: 80,
                  end_time: 1280,
                  text: "hello from byteplus",
                },
              ],
            },
          },
          { headers: { "x-api-status-code": "20000000" } },
        );
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile(audioBytes)),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      text: "hello from byteplus",
      segments: [{ start: 0.08, end: 1.28, text: "hello from byteplus" }],
    });
    expect(observedApiKey).toBe("test-byteplus-stt-key");
    expect(observedResourceId).toBe("volc.seedasr.auc_turbo");
    expect(observedSequence).toBe("-1");
    expect(observedRequestId).toStrictEqual(expect.any(String));
    expect(observedBody).toStrictEqual({
      audio: {
        data: Buffer.from(audioBytes).toString("base64"),
        format: "wav",
      },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        enable_speaker_info: false,
        show_utterances: true,
      },
    });

    // The quota surface reports the lifetime free-tier count and confirms the
    // daily counters have not hit a limit; exact daily rate/duration
    // accounting is pinned product-visibly by the metering and limit tests.
    await expect(readAudioQuota(fixture)).resolves.toStrictEqual({
      allowed: true,
      count: 1,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("retries a transient BytePlus gateway failure once", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const requestIds: string[] = [];
    let requestCount = 0;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, ({ request }) => {
        requestCount += 1;
        const requestId = request.headers.get("x-api-request-id");
        if (requestId) {
          requestIds.push(requestId);
        }
        if (requestCount === 1) {
          return HttpResponse.text("Gateway Timeout", { status: 504 });
        }
        return bytePlusSttResponse("hello after retry");
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile(wavBytes(1))),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      text: "hello after retry",
    });
    expect(requestCount).toBe(2);
    expect(requestIds).toHaveLength(2);
    expect(new Set(requestIds).size).toBe(2);
  });

  it("rounds fractional WAV usage for a BytePlus no-speech response", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    // Pre-fill the daily duration counter to two seconds under the free-tier
    // limit so the fractional clip's rounded usage is visible on the quota surface.
    await seedBehaviorCount(
      fixture,
      sttDailyDurationKey(),
      FREE_DAILY_DURATION_LIMIT_SECONDS - 2,
    );

    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        return HttpResponse.json(
          {
            audio_info: { duration: 2700 },
            result: {
              additions: { duration: "2700" },
              text: "",
            },
          },
          { headers: { "x-api-status-code": "20000003" } },
        );
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile(wavBytes(1.56))),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ text: "" });
    // The no-speech transcription still metered its 2 seconds: the duration
    // counter lands exactly on the limit, which the quota surface reports.
    await expect(readAudioQuota(fixture)).resolves.toStrictEqual({
      allowed: false,
      count: FREE_DAILY_DURATION_LIMIT_SECONDS,
      limit: FREE_DAILY_DURATION_LIMIT_SECONDS,
    });
  });

  it("meters /stt WAV duration from the data chunk, not a fixed 44-byte offset", async () => {
    // ffmpeg-produced WAV can carry chunks (LIST/INFO/JUNK) before the data
    // chunk, so the data chunk is not at byte 44. A fixed-offset reader would
    // mis-measure this clip; the RIFF chunk-walk must report its true length.
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockBytePlusStt("hello from voice");
    // Pre-fill the duration counter to exactly 120 seconds under the limit:
    // the quota surface then reports the metered duration exactly (any over-
    // or under-count would return a different count or stay allowed).
    await seedBehaviorCount(
      fixture,
      sttDailyDurationKey(),
      FREE_DAILY_DURATION_LIMIT_SECONDS - 120,
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile(wavBytesWithOversizedDataChunk(120))),
    });

    expect(response.status).toBe(200);
    await expect(readAudioQuota(fixture)).resolves.toStrictEqual({
      allowed: false,
      count: FREE_DAILY_DURATION_LIMIT_SECONDS,
      limit: FREE_DAILY_DURATION_LIMIT_SECONDS,
    });
  });

  it("meters /stt WAV duration from the declared data size, ignoring trailing chunks", async () => {
    // A well-formed WAV with a LIST chunk after data must be measured from the
    // declared data size, not the whole remaining buffer (which would count the
    // 3s-worth trailing chunk as audio and over-meter to 63s).
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockBytePlusStt("hello from voice");
    // Pre-fill the duration counter to exactly 60 seconds under the limit: an
    // over-count (63s with the trailing chunk) would report 603, an
    // under-count would stay allowed.
    await seedBehaviorCount(
      fixture,
      sttDailyDurationKey(),
      FREE_DAILY_DURATION_LIMIT_SECONDS - 60,
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile(wavBytesWithTrailingChunk(60))),
    });

    expect(response.status).toBe(200);
    await expect(readAudioQuota(fixture)).resolves.toStrictEqual({
      allowed: false,
      count: FREE_DAILY_DURATION_LIMIT_SECONDS,
      limit: FREE_DAILY_DURATION_LIMIT_SECONDS,
    });
  });

  it("does not reject large compressed audio on a byte-size estimate", async () => {
    // A 400 KB mp3 upload. The old size-based estimate (bytes / 8 kbps) computed
    // ~400s and rejected it with AUDIO_DURATION_TOO_LONG; real duration parsing
    // measures the actual length instead, so a short-but-dense clip is no longer
    // falsely rejected on file size.
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockBytePlusStt("hello from voice");

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(
        sttFile(new Uint8Array(400_000), "audio/mpeg", "speech.mp3"),
      ),
    });

    expect(response.status).toBe(200);
  });

  it("returns BytePlus utterance segments when ?verbose=true", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        return bytePlusSttResponse("hello world", [
          { start_time: 0, end_time: 1500, text: " hello world" },
        ]);
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt?verbose=true", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile(wavBytes(2))),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      text: "hello world",
      segments: [{ start: 0, end: 1.5, text: " hello world" }],
    });
  });

  it("authorizes a sandbox token carrying file:write on /stt", async () => {
    const fixture = await seedVoiceFixture({});
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: `run_${randomUUID()}`,
    });
    mockBytePlusStt("from agent");

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: sttForm(sttFile(wavBytes(2))),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      text: "from agent",
    });
  });

  it("rejects a sandbox token without file:write on /stt", async () => {
    const fixture = await seedVoiceFixture({});
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: sttForm(sttFile(wavBytes(2))),
    });

    expect(response.status).toBe(403);
  });

  it("does not increment the legacy /stt free-tier counter for pro orgs", async () => {
    const fixture = await seedVoiceFixture({ tier: "pro" });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockBytePlusStt("pro transcript");

    const app = createVoiceIoTestApp();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request("/api/voice-io/stt", {
        method: "POST",
        headers: authHeaders(),
        body: sttForm(sttFile(new Uint8Array([1, 2, 3]), "audio/webm")),
      });
      expect(response.status).toBe(200);
    }

    // The lifetime counter is only recorded for lifetime-limited tiers (the
    // quota surface always reports 0 for pro/team). Downgrading the org to
    // free exposes it: had the pro requests incremented it, count would be 2.
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "free",
      credits: 10_000,
    });
    await expect(readAudioQuota(fixture)).resolves.toStrictEqual({
      allowed: true,
      count: 0,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it.each(["free", "limited-free-1"] as const)(
    "increments the /stt lifetime audio input counter for %s orgs up to quota",
    async (tier) => {
      const fixture = await seedVoiceFixture({ tier });
      mocks.clerk.session(fixture.userId, fixture.orgId);
      mockBytePlusStt("quota transcript");

      const app = createVoiceIoTestApp();
      for (let attempt = 1; attempt <= AUDIO_INPUT_FREE_QUOTA; attempt++) {
        const response = await app.request("/api/voice-io/stt", {
          method: "POST",
          headers: authHeaders(),
          body: sttForm(sttFile(new Uint8Array([1, 2, 3]), "audio/webm")),
        });
        expect(response.status).toBe(200);
        // The quota surface reports the lifetime count while under the daily
        // limits and flips to blocked exactly at the shared limit of 10.
        await expect(readAudioQuota(fixture)).resolves.toStrictEqual({
          allowed: attempt < AUDIO_INPUT_FREE_QUOTA,
          count: attempt,
          limit: AUDIO_INPUT_FREE_QUOTA,
        });
      }
    },
  );

  it("blocks /stt before BytePlus when the free audio quota is exhausted", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedBehaviorCount(
      fixture,
      AUDIO_INPUT_BEHAVIOR_KEY,
      AUDIO_INPUT_FREE_QUOTA,
    );

    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        calledBytePlus = true;
        return bytePlusSttResponse("should not run");
      }),
    );
    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile()),
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
        code: "AUDIO_INPUT_QUOTA_EXCEEDED",
      },
      quota: { count: AUDIO_INPUT_FREE_QUOTA, limit: AUDIO_INPUT_FREE_QUOTA },
    });
    expect(calledBytePlus).toBeFalsy();
    // The rejected request did not consume quota: the surface still reports
    // exactly the seeded lifetime count.
    await expect(readAudioQuota(fixture)).resolves.toStrictEqual({
      allowed: false,
      count: AUDIO_INPUT_FREE_QUOTA,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("does not increment /stt counters when BytePlus transcription fails", async () => {
    const fixture = await seedVoiceFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    // Park every counter one increment under its limit: if the failed request
    // incremented any of them, the quota surface would flip to blocked (or
    // report a lifetime count of 1).
    await seedBehaviorCount(
      fixture,
      sttDailyRateKey(),
      FREE_DAILY_RATE_LIMIT - 1,
    );
    await seedBehaviorCount(
      fixture,
      sttDailyDurationKey(),
      FREE_DAILY_DURATION_LIMIT_SECONDS - 3,
    );
    let requestCount = 0;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        requestCount += 1;
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile(wavBytes(3))),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Transcription failed", code: "INTERNAL_SERVER_ERROR" },
    });
    await expect(readAudioQuota(fixture)).resolves.toStrictEqual({
      allowed: true,
      count: 0,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
    expect(requestCount).toBe(1);
  });

  it("blocks /stt before BytePlus when the daily request limit is exhausted", async () => {
    const fixture = await seedVoiceFixture({ tier: "pro" });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedBehaviorCount(fixture, sttDailyRateKey(), PRO_DAILY_RATE_LIMIT);

    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        calledBytePlus = true;
        return bytePlusSttResponse("should not run");
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile(new Uint8Array([1, 2, 3]), "audio/webm")),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Daily request rate limit exceeded",
        code: "DAILY_RATE_LIMIT_EXCEEDED",
      },
      quota: { count: PRO_DAILY_RATE_LIMIT, limit: PRO_DAILY_RATE_LIMIT },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it("blocks /stt before BytePlus when the daily duration limit is exhausted", async () => {
    const fixture = await seedVoiceFixture({ tier: "pro" });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await seedBehaviorCount(
      fixture,
      sttDailyDurationKey(),
      PRO_DAILY_DURATION_LIMIT_SECONDS,
    );

    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_ASR_FLASH_URL, () => {
        calledBytePlus = true;
        return bytePlusSttResponse("should not run");
      }),
    );

    const app = createVoiceIoTestApp();
    const response = await app.request("/api/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: sttForm(sttFile(wavBytes(1))),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Daily audio duration limit exceeded",
        code: "DAILY_DURATION_LIMIT_EXCEEDED",
      },
      quota: {
        count: PRO_DAILY_DURATION_LIMIT_SECONDS,
        limit: PRO_DAILY_DURATION_LIMIT_SECONDS,
      },
    });
    expect(calledBytePlus).toBeFalsy();
  });
});
