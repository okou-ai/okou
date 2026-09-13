import { voiceIoPolishContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { stubTestVercelRuntimeToken } from "../../../__tests__/env-stub";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { createBddApi } from "./helpers/api-bdd";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import {
  mockGoogleVoice,
  VERTEX_VOICE_URL,
  vertexVoiceResponse,
} from "./helpers/google-voice";
import { createDeferredPromise } from "../../utils";
import { voiceIoPolishRoutes } from "../voice-io-polish";

const context = testContext();
const mocks = createRouteMocks(context);
beforeEach(() => {
  mockGoogleVoice();
});
afterEach(() => {
  stubTestVercelRuntimeToken(undefined);
});

function client() {
  return setupApp({ context, routes: voiceIoPolishRoutes })(
    voiceIoPolishContract,
  );
}

async function enableVoicePolish(useGoogleCloud = true) {
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Voice draft tests require an organization");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
    {
      [FeatureSwitchKey.VoiceInputV2]: true,
      ...(useGoogleCloud ? { [FeatureSwitchKey.VoiceGoogleCloud]: true } : {}),
    },
  );
}

describe("POST /api/voice-io/polish", () => {
  it.each([
    { code: "ECONNRESET", status: 503 },
    { code: "UND_ERR_BODY_TIMEOUT", status: 503 },
    { code: "CERT_HAS_EXPIRED", status: 502 },
  ])(
    "classifies a Google body I/O failure with $code",
    async ({ code, status }) => {
      await enableVoicePolish();
      let calls = 0;
      server.use(
        http.post(VERTEX_VOICE_URL, () => {
          calls += 1;
          return new HttpResponse(
            new ReadableStream({
              start(controller) {
                controller.error(
                  new TypeError("fetch failed", { cause: { code } }),
                );
              },
            }),
          );
        }),
      );
      const response = await client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Synthetic dictation." },
      });
      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({
        error: {
          code: status === 503 ? "PROVIDER_UNAVAILABLE" : "VOICE_POLISH_FAILED",
        },
      });
      expect(calls).toBe(1);
    },
  );

  it("classifies a Google connection failure without replaying generation", async () => {
    await enableVoicePolish();
    let calls = 0;
    server.use(
      http.post(VERTEX_VOICE_URL, () => {
        calls += 1;
        return HttpResponse.error();
      }),
    );
    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Synthetic dictation." },
      }),
      [503],
    );
    expect(response.body.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(calls).toBe(1);
  });

  it("defaults staff to Google and honors disabling and resetting the override", async () => {
    const actor = {
      ...createBddApi(context).user(),
      orgId: createUniqueStaffOrgIdFixture(),
      orgRole: "org:member" as const,
    };
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post(VERTEX_VOICE_URL, () => {
        return vertexVoiceResponse("Google staff default.");
      }),
      http.post("https://openrouter.ai/api/v1/chat/completions", () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "OpenRouter override." },
            },
          ],
        });
      }),
    );
    const polish = () => {
      return client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Synthetic dictation." },
      });
    };

    const staffDefault = await accept(polish(), [200]);
    expect(staffDefault.body.text).toBe("Google staff default.");

    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.VoiceGoogleCloud]: false,
    });
    const disabled = await accept(polish(), [200]);
    expect(disabled.body.text).toBe("OpenRouter override.");

    await deleteFeatureSwitchesForUser(context, actor);
    const reset = await accept(polish(), [200]);
    expect(reset.body.text).toBe("Google staff default.");
  });

  it("preserves OpenRouter polishing by default without Google credentials", async () => {
    await enableVoicePolish(false);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
    let requestBody: unknown;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "  Ship on Monday.  " },
              },
            ],
          });
        },
      ),
    );
    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "um ship on Monday" },
      }),
      [200],
    );
    expect(response.body.text).toBe("Ship on Monday.");
    expect(requestBody).toMatchObject({
      model: "google/gemini-3.8-flash",
      max_tokens: 65_536,
      reasoning: { effort: "low" },
      temperature: 0,
      messages: [
        expect.anything(),
        {
          role: "user",
          content: JSON.stringify({ text: "um ship on Monday" }),
        },
      ],
    });
    expect(requestBody).not.toHaveProperty("response_format");
  });

  it("retains the maximum text contract with JSON escaping and rejects oversize output", async () => {
    await enableVoicePolish();
    const text = `a${"\u0001".repeat(262_142)}z`;
    server.use(
      http.post(VERTEX_VOICE_URL, () => {
        return vertexVoiceResponse(text);
      }),
    );
    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Synthetic dictation." },
      }),
      [200],
    );
    expect(response.body.text).toBe(text);
    server.use(
      http.post(VERTEX_VOICE_URL, () => {
        return vertexVoiceResponse("x".repeat(262_145));
      }),
    );
    await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Synthetic dictation." },
      }),
      [502],
    );
    server.use(
      http.post(VERTEX_VOICE_URL, () => {
        return new HttpResponse("x".repeat(2 * 1024 * 1024 + 1));
      }),
    );
    await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Synthetic dictation." },
      }),
      [502],
    );
  });

  it("recovers a temporary Google polish failure on the same model", async () => {
    await enableVoicePolish();
    const urls: string[] = [];
    server.use(
      http.post(VERTEX_VOICE_URL, ({ request }) => {
        urls.push(request.url);
        return urls.length === 1
          ? new HttpResponse(null, { status: 503 })
          : vertexVoiceResponse("Synthetic dictation.");
      }),
    );
    await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Synthetic dictation." },
      }),
      [200],
    );
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(urls[0]);
    expect(urls[0]).toContain(
      "/locations/us/publishers/google/models/gemini-3.8-flash:generateContent",
    );
  });

  it.each([
    {
      reason: "output_truncated",
      body: {
        candidates: [
          {
            finishReason: "MAX_TOKENS",
            content: { parts: [{ text: "private partial transcript" }] },
          },
        ],
      },
    },
    {
      reason: "blocked",
      body: {
        promptFeedback: { blockReason: "private upstream block reason" },
      },
    },
    { reason: "blocked", body: { candidates: [{ finishReason: "SAFETY" }] } },
    {
      reason: "non_stop",
      body: { candidates: [{ finishReason: "private unknown finish reason" }] },
    },
    {
      reason: "empty_output",
      body: {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ text: "private thought text", thought: true }],
            },
          },
        ],
      },
    },
    { reason: "invalid_response", body: { candidates: [{ finishReason: 7 }] } },
  ])("rejects unusable Google output for $reason", async ({ body }) => {
    await enableVoicePolish();
    server.use(
      http.post(VERTEX_VOICE_URL, () => {
        return HttpResponse.json(body);
      }),
    );
    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "private user dictation" },
      }),
      [502],
    );
    expect(response.body.error.code).toBe("VOICE_POLISH_FAILED");
  });

  it("preserves public provider errors, respects long Retry-After, and rejects incomplete polish", async () => {
    await enableVoicePolish();
    const cases = [
      {
        status: 400,
        body: {
          error: {
            code: "unsupported_value",
            param: "reasoning.effort",
            message: "private-provider-detail",
          },
        },
        expectedStatus: 502,
        code: "VOICE_POLISH_FAILED",
      },
      {
        status: 429,
        body: { error: { message: "private-provider-detail" } },
        expectedStatus: 503,
        code: "PROVIDER_UNAVAILABLE",
      },
      {
        status: 503,
        body: { error: { message: "private-provider-detail" } },
        expectedStatus: 503,
        code: "PROVIDER_UNAVAILABLE",
      },
      {
        status: 200,
        body: {
          error: {
            code: "invalid_request_error",
            param: "max_tokens",
            message: "private-provider-detail",
          },
        },
        expectedStatus: 502,
        code: "VOICE_POLISH_FAILED",
      },
      {
        status: 200,
        body: {
          promptFeedback: { blockReason: "SAFETY" },
          candidates: [],
        },
        expectedStatus: 502,
        code: "VOICE_POLISH_FAILED",
      },
      {
        status: 200,
        body: {
          candidates: [
            {
              finishReason: "MAX_TOKENS",
              content: { parts: [{ text: "Truncated dictation" }] },
            },
          ],
        },
        expectedStatus: 502,
        code: "VOICE_POLISH_FAILED",
      },
      {
        status: 200,
        body: {
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: " " }] } },
          ],
        },
        expectedStatus: 502,
        code: "VOICE_POLISH_FAILED",
      },
    ];
    for (const testCase of cases) {
      server.use(
        http.post(VERTEX_VOICE_URL, () => {
          return HttpResponse.json(testCase.body, {
            status: testCase.status,
            headers: { "Retry-After": "20" },
          });
        }),
      );
      const response = await client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "um prepare the update" },
      });
      expect(response.status).toBe(testCase.expectedStatus);
      expect(response.body).toStrictEqual({
        error: {
          code: testCase.code,
          message:
            testCase.expectedStatus === 503
              ? "Voice draft cleanup is temporarily unavailable"
              : "Voice draft cleanup failed to produce a usable response",
        },
      });
    }
  });

  it("cancels the provider request when the client disconnects", async () => {
    await enableVoicePolish();
    const controller = new AbortController();
    context.signal.addEventListener(
      "abort",
      () => {
        controller.abort();
      },
      { once: true },
    );
    const entered = createDeferredPromise<void>(context.signal);
    const aborted = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(VERTEX_VOICE_URL, async ({ request }) => {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await aborted.promise;
        return HttpResponse.json({});
      }),
    );
    const result = setupApp({
      context,
      routes: voiceIoPolishRoutes,
      rethrowErrors: true,
    })(voiceIoPolishContract).post({
      headers: { authorization: "Bearer clerk-session" },
      body: { text: "um prepare the update" },
      fetchOptions: { signal: controller.signal },
    });
    await entered.promise;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await aborted.promise;
  });

  it("turns raw dictation into send-ready text without charging usage", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const actor = createBddApi(context).user({
      orgId: createUniqueStaffOrgIdFixture(),
    });
    if (!actor.orgId) {
      throw new Error("Voice draft tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
      {
        [FeatureSwitchKey.VoiceInputV2]: true,
        [FeatureSwitchKey.VoiceGoogleCloud]: true,
      },
    );
    let requestBody: unknown;
    server.use(
      http.post(VERTEX_VOICE_URL, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Ship the release on Monday." }] },
            },
          ],
        });
      }),
    );

    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          text: "um ship the nebula release Friday no Monday",
          lastAssistantMessage:
            "The Project Nebula release is scheduled for Friday.",
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      text: "Ship the release on Monday.",
    });
    expect(requestBody).toMatchObject({
      generationConfig: {
        maxOutputTokens: 65_536,
        thinkingConfig: { thinkingLevel: "LOW" },
      },
      systemInstruction: {
        parts: [
          {
            text: expect.stringContaining(
              "provides conversational context for resolving vocabulary",
            ),
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({
                text: "um ship the nebula release Friday no Monday",
                lastAssistantMessage:
                  "The Project Nebula release is scheduled for Friday.",
              }),
            },
          ],
        },
      ],
    });
    expect(requestBody).not.toHaveProperty("generationConfig.temperature");
    expect(requestBody).not.toHaveProperty("generationConfig.responseMimeType");
  });

  it("requires session auth and the voice draft switch for staff", async () => {
    const unauthenticated = await client().post({
      headers: {},
      body: { text: "Hello" },
    });
    expect(unauthenticated.status).toBe(401);

    const actor = createBddApi(context).user({
      orgId: createUniqueStaffOrgIdFixture(),
    });
    if (!actor.orgId) {
      throw new Error("Voice draft tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.VoiceInputV2]: false },
    );
    const disabled = await client().post({
      headers: { authorization: "Bearer clerk-session" },
      body: { text: "Hello" },
    });
    expect(disabled.status).toBe(403);
  });

  it("lets non-staff users enable polishing through their Lab override", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Voice draft tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
      {
        [FeatureSwitchKey.VoiceInputV2]: true,
        [FeatureSwitchKey.VoiceGoogleCloud]: true,
      },
    );
    server.use(
      http.post(VERTEX_VOICE_URL, () => {
        return HttpResponse.json({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "Hello." }] } },
          ],
        });
      }),
    );

    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Hello" },
      }),
      [200],
    );

    expect(response.body.text).toBe("Hello.");
  });
});
