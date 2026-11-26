import { randomUUID } from "node:crypto";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { stubTestVercelRuntimeToken } from "../../../__tests__/env-stub";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { voiceIoQuotaRoutes } from "../voice-io-quota";
import { voiceIoTranscribeRoutes } from "../voice-io-transcribe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  mockGoogleVoice,
  VERTEX_VOICE_URL,
  vertexVoiceResponse,
  type VertexVoiceRequest,
} from "./helpers/google-voice";
import { createMcpWebApi } from "./helpers/mcp-web-api";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const COMPACT_SAMPLE_RATE = 100;

const voiceApp = setupApp({
  context,
  routes: [...voiceIoTranscribeRoutes, ...voiceIoQuotaRoutes],
});
const transcribeApi = voiceApp(voiceIoTranscribeContract);
const quotaApi = voiceApp(voiceIoQuotaContract);

function makeWavBytes(
  durationSeconds: number,
  options: {
    readonly totalBytes?: number;
    readonly sampleRate?: number;
    readonly bitsPerSample?: 8 | 16;
  } = {},
): Uint8Array<ArrayBuffer> {
  const sampleRate = options.sampleRate ?? COMPACT_SAMPLE_RATE;
  const bitsPerSample = options.bitsPerSample ?? 8;
  const bytesPerSample = bitsPerSample / 8;
  const bytesPerSecond = sampleRate * bytesPerSample;
  const sampleCount = Math.round(durationSeconds * sampleRate);
  const dataBytes = sampleCount * bytesPerSample;
  const headerBytes = 44;
  const junkChunkBytes =
    options.totalBytes === undefined
      ? 0
      : options.totalBytes - headerBytes - dataBytes;
  if (junkChunkBytes < 0 || (junkChunkBytes > 0 && junkChunkBytes < 8)) {
    throw new Error("Invalid WAV totalBytes padding");
  }
  const totalBytes = headerBytes + dataBytes + junkChunkBytes;
  const buffer = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, totalBytes - 8, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, bytesPerSecond, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36); // data
  view.setUint32(40, dataBytes, true);

  if (junkChunkBytes >= 8) {
    const junkOffset = headerBytes + dataBytes;
    bytes.set([0x4a, 0x55, 0x4e, 0x4b], junkOffset); // JUNK
    view.setUint32(junkOffset + 4, junkChunkBytes - 8, true);
  }
  return bytes;
}

function makeSegmentForm(options: {
  readonly file?: File | null;
  readonly durationSeconds?: number;
  readonly totalDurationSeconds?: number;
  readonly previousTranscript?: string;
  readonly overlapDurationSeconds?: number;
  readonly editorContext?: {
    readonly before: string;
    readonly selected: string;
    readonly after: string;
  };
}): FormData {
  const form = new FormData();
  const durationSeconds = options.durationSeconds ?? 1;
  if (options.file !== null) {
    const audioFile =
      options.file ??
      new File([makeWavBytes(durationSeconds)], "segment.wav", {
        type: "audio/wav",
      });
    form.append("file", audioFile);
  }
  form.append(
    "options",
    JSON.stringify({
      previousTranscript: options.previousTranscript ?? "",
      overlapDurationSeconds: options.overlapDurationSeconds ?? 0,
      totalDurationSeconds: options.totalDurationSeconds ?? durationSeconds,
    }),
  );
  if (options.editorContext !== undefined) {
    form.append("editorContext", JSON.stringify(options.editorContext));
  }
  return form;
}

function setupVertexVoice(
  handler: (args: {
    readonly request: Request;
    readonly callNumber: number;
  }) => Promise<Response> | Response,
) {
  onTestFinished(() => {
    stubTestVercelRuntimeToken(undefined);
  });
  mockGoogleVoice();
  let calls = 0;
  server.use(
    http.post(VERTEX_VOICE_URL, async ({ request }) => {
      calls += 1;
      return await handler({ request, callNumber: calls });
    }),
  );
  return {
    get calls() {
      return calls;
    },
  };
}

function vertexTranscriptJson(transcript: string, language = "en"): Response {
  return vertexVoiceResponse(JSON.stringify({ transcript, language }));
}

async function setupProAdmin(): Promise<{
  readonly actor: ApiTestUser;
  readonly customerId: string;
  readonly subscriptionId: string;
}> {
  const actor = bdd.user({ orgRole: "org:admin" });
  const entitlement = await runs.grantProEntitlement(actor);
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return {
    actor,
    customerId: entitlement.customerId,
    subscriptionId: entitlement.subscriptionId,
  };
}

async function setupLimitedFreeAdmin(): Promise<ApiTestUser> {
  const { actor, customerId, subscriptionId } = await setupProAdmin();
  webhooks.configureStripeBillingEnv();
  await webhooks.postStripeEvent(
    {
      id: `evt_voice_cancel_${randomUUID()}`,
      type: "customer.subscription.deleted",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "canceled",
          metadata: {},
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      },
    },
    [200],
  );
  await flushWaitUntilForTest();
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return actor;
}

describe("voice input routing and reference context", () => {
  it("voice-io-transcribe-025 requires audio even when an earlier transcript exists", async () => {
    await setupProAdmin();

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          file: null,
          previousTranscript: "Earlier speech.",
          totalDurationSeconds: 60,
        }),
      }),
      [400],
    );

    expect(response.body.error.message).toBe("No audio file provided");
  });

  it("voice-io-transcribe-010 rejects invalid editor context before contacting the provider: oversized selection", async () => {
    await setupProAdmin();

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 1,
          editorContext: {
            before: "before",
            selected: "x".repeat(1001),
            after: "after",
          },
        }),
      }),
      [400],
    );

    expect(response.status).toBe(400);
  });

  it("voice-io-transcribe-012 rejects a previous transcript beyond the bounded prefix", async () => {
    await setupProAdmin();

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 1,
          previousTranscript: "a".repeat(1001),
          totalDurationSeconds: 61,
        }),
      }),
      [400],
    );

    expect(response.status).toBe(400);
  });

  it("voice-io-transcribe-028 rejects an oversized segment before invoking the provider", async () => {
    await setupProAdmin();

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 76,
          totalDurationSeconds: 76,
        }),
      }),
      [400],
    );

    expect(response.status).toBe(400);
  });

  it("voice-io-transcribe-003 rejects unusable native candidates without retry", async () => {
    await setupProAdmin();
    const vertex = setupVertexVoice(() => {
      return HttpResponse.json({
        promptFeedback: { blockReason: "SAFETY" },
        candidates: [],
      });
    });

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({ durationSeconds: 1 }),
      }),
      [502],
    );

    expect(response.status).toBe(502);
    expect(vertex.calls).toBe(1);
  });

  it("voice-io-transcribe-006 ignores thought parts and rejects an oversized native response", async () => {
    await setupProAdmin();
    setupVertexVoice(({ callNumber }) => {
      if (callNumber === 1) {
        return HttpResponse.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [
                  { text: "internal reasoning thought", thought: true },
                  {
                    text: JSON.stringify({
                      transcript: "Hello.",
                      language: "en",
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      return new HttpResponse("x".repeat(1024 * 1024 + 128), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const first = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({ durationSeconds: 1 }),
      }),
      [200],
    );
    expect(first.body).toStrictEqual({
      transcript: "Hello.",
      language: "en",
    });
    expect(first.body.transcript).not.toContain("internal reasoning");

    const second = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({ durationSeconds: 1 }),
      }),
      [502],
    );
    expect(second.status).toBe(502);
  });

  it("voice-io-transcribe-008 transcribes a 0.56-second recording without polishing", async () => {
    await setupProAdmin();
    const editorContext = {
      before: "Draft header before cursor",
      selected: "selected nebula snippet",
      after: "trailing footer after cursor",
    };
    let capturedBody: VertexVoiceRequest | undefined;

    setupVertexVoice(async ({ request }) => {
      capturedBody = (await request.json()) as VertexVoiceRequest;
      return vertexTranscriptJson("um ship the nebula release", "en-US");
    });

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 0.56,
          totalDurationSeconds: 0.56,
          editorContext,
        }),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      transcript: "um ship the nebula release",
      language: "en-US",
    });
    if (!capturedBody) {
      throw new Error("Expected Vertex voice request body");
    }
    expect(capturedBody.generationConfig.maxOutputTokens).toBe(4096);
    expect(capturedBody.generationConfig.thinkingConfig.thinkingLevel).toBe(
      "MINIMAL",
    );
    expect(capturedBody.generationConfig.temperature).toBe(0);
    expect(
      capturedBody.generationConfig.responseSchema?.required,
    ).toStrictEqual(["transcript", "language"]);

    const systemText = capturedBody.systemInstruction.parts
      .map((part) => {
        return part.text;
      })
      .join("\n");
    expect(systemText).toContain("transcription engine");
    expect(systemText).not.toContain(editorContext.before);
    expect(systemText).not.toContain(editorContext.selected);
    expect(systemText).not.toContain(editorContext.after);

    const userParts = capturedBody.contents[0]?.parts ?? [];
    expect(userParts[0]?.inlineData?.mimeType).toBe("audio/wav");
    expect(userParts[0]?.inlineData?.data).toBeTruthy();
    const textPart = userParts[1]?.text ?? "";
    expect(textPart).toContain(JSON.stringify({ editorContext }));
    expect(textPart).toContain("PREVIOUS_TRANSCRIPT_TAIL");
    expect(textPart).toContain("AUDIO is the only source of new speech");
  });

  it("voice-io-transcribe-011 transcribes OAuth voice input with the existing paid-tier quota", async () => {
    const { actor } = await setupProAdmin();
    const issue = createMcpWebApi(context).authorize(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [{ role: "org:admin", organization: { id: actor.orgId } }],
      totalCount: 1,
    });
    const oauthToken = issue({ scope: "user:org:read okou:voice:transcribe" });
    const oauthHeaders = { authorization: `Bearer ${oauthToken}` };

    setupVertexVoice(() => {
      return vertexTranscriptJson("Recorded speech.", "en");
    });

    const quotaBefore = await accept(
      quotaApi.get({ headers: oauthHeaders }),
      [200],
    );
    expect(quotaBefore.body.allowed).toBeTruthy();
    expect(quotaBefore.body.count).toBe(0);

    const segment = await accept(
      transcribeApi.segment({
        headers: oauthHeaders,
        body: makeSegmentForm({ durationSeconds: 1 }),
      }),
      [200],
    );
    expect(segment.body).toStrictEqual({
      transcript: "Recorded speech.",
      language: "en",
    });

    const quotaAfter = await accept(
      quotaApi.get({ headers: oauthHeaders }),
      [200],
    );
    expect(quotaAfter.body).toStrictEqual(quotaBefore.body);
  });

  it("voice-io-transcribe-014 accepts the 60-minute recording boundary and rejects longer recordings", async () => {
    await setupProAdmin();
    setupVertexVoice(() => {
      return vertexTranscriptJson("Recorded speech.", "en");
    });

    const atLimit = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 1,
          totalDurationSeconds: 3600,
        }),
      }),
      [200],
    );
    expect(atLimit.body.transcript).toBe("Recorded speech.");

    const overLimit = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 1,
          totalDurationSeconds: 3601,
        }),
      }),
      [400],
    );
    expect(overLimit.status).toBe(400);
  });

  it("voice-io-transcribe-015 returns no content for silent audio without discarding client-owned earlier text", async () => {
    await setupProAdmin();
    setupVertexVoice(() => {
      return vertexTranscriptJson("[NO_SPEECH]", "und");
    });

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 1,
          previousTranscript: "Earlier speech.",
          totalDurationSeconds: 61,
        }),
      }),
      [204],
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeFalsy();
  });

  it("voice-io-transcribe-019 keeps plausible speech and leaves suspicious short audio retryable", async () => {
    await setupProAdmin();
    const hallucinated =
      "Hello, I am calling to inquire about the status of my recent order, number 45678. Could you please provide an update on when I might expect delivery?";
    setupVertexVoice(() => {
      return vertexTranscriptJson(hallucinated, "en");
    });

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 0.1,
          totalDurationSeconds: 0.1,
        }),
      }),
      [502],
    );

    expect(response.status).toBe(502);
  });

  it("voice-io-transcribe-020 rejects implausible final output without discarding saved speech", async () => {
    await setupProAdmin();
    setupVertexVoice(() => {
      return vertexTranscriptJson("word ".repeat(40).trim(), "en");
    });

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 1,
          previousTranscript: "Earlier speech.",
          totalDurationSeconds: 61,
        }),
      }),
      [502],
    );

    expect(response.body.error.code).toBe("VOICE_TRANSCRIPTION_FAILED");
  });

  it("voice-io-transcribe-023 meters unique recording time without charging the boundary overlap twice", async () => {
    await setupLimitedFreeAdmin();
    setupVertexVoice(() => {
      return vertexTranscriptJson("Recorded speech.", "en");
    });

    const initialSegments = [75, 75, 75, 75, 75, 75, 32];
    await Promise.all([
      ...initialSegments.map((seconds) => {
        return accept(
          transcribeApi.segment({
            headers,
            body: makeSegmentForm({
              durationSeconds: seconds,
              totalDurationSeconds: seconds,
            }),
          }),
          [200],
        );
      }),
      accept(
        transcribeApi.segment({
          headers,
          body: makeSegmentForm({
            durationSeconds: 60,
            totalDurationSeconds: 60,
          }),
        }),
        [200],
      ),
      accept(
        transcribeApi.segment({
          headers,
          body: makeSegmentForm({
            durationSeconds: 60,
            totalDurationSeconds: 118,
            overlapDurationSeconds: 2,
          }),
        }),
        [200],
      ),
    ]);

    const quota = await accept(quotaApi.get({ headers }), [200]);
    expect(quota.body).toStrictEqual({
      allowed: false,
      count: 600,
      limit: 600,
    });

    const extra = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({ durationSeconds: 1 }),
      }),
      [429],
    );
    expect(extra.body.error.code).toBe("DAILY_DURATION_LIMIT_EXCEEDED");
  });

  it("voice-io-transcribe-024 transcribes every segment with the same prompt and returns only new text", async () => {
    await setupProAdmin();
    const captured: VertexVoiceRequest[] = [];
    setupVertexVoice(async ({ request, callNumber }) => {
      captured.push((await request.json()) as VertexVoiceRequest);
      return callNumber === 1
        ? vertexTranscriptJson("LaunchPad is ready.", "en")
        : vertexTranscriptJson("Send it tomorrow.", "en");
    });

    const first = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 60,
          totalDurationSeconds: 60,
        }),
      }),
      [200],
    );
    expect(first.body).toStrictEqual({
      transcript: "LaunchPad is ready.",
      language: "en",
    });

    const second = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({
          durationSeconds: 3,
          previousTranscript: "LaunchPad is ready.",
          totalDurationSeconds: 61,
          overlapDurationSeconds: 2,
        }),
      }),
      [200],
    );
    expect(second.body).toStrictEqual({
      transcript: "Send it tomorrow.",
      language: "en",
    });

    expect(captured[0]?.systemInstruction).toStrictEqual(
      captured[1]?.systemInstruction,
    );
    expect(captured[1]?.generationConfig.maxOutputTokens).toBe(4096);
    const secondUserText = captured[1]?.contents[0]?.parts[1]?.text ?? "";
    expect(secondUserText).toContain("LaunchPad is ready.");
  });

  it("voice-io-transcribe-031 returns provider-unavailability for a connection failure", async () => {
    await setupProAdmin();
    const vertex = setupVertexVoice(() => {
      return HttpResponse.error();
    });

    const response = await accept(
      transcribeApi.segment({
        headers,
        body: makeSegmentForm({ durationSeconds: 1 }),
      }),
      [503],
    );

    expect(response.body.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(vertex.calls).toBe(1);
  });
});
